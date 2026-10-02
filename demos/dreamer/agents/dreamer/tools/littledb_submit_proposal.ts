import { tool } from "ai";
import { z } from "zod";
import {
  investigationState,
  MAX_SUBMIT_ATTEMPTS,
  resolveHarnessSlug,
  submitProposal,
  type ProposalBody,
} from "../littledb-api";

const MIN_FAILURE_SAMPLES = 2;

/**
 * Submit the config proposal.
 *
 * Two guards sit in front of the POST, and they are deliberately mechanical rather than
 * prompt-only:
 *
 *  1. **Two verifiable citations minimum.** A proposal with fewer than two failure samples
 *     never leaves the process. "Never propose without at least 2 verifiable failure
 *     citations" is the doctrine; a rule that only lives in `instructions.md` is a rule the
 *     model can talk itself out of.
 *  2. **A cited run has to exist in the evidence pack.** A run id the pack never mentioned
 *     is a hallucination, and catching it here costs one local lookup instead of a round
 *     trip.
 *
 * Everything else is the control plane's job: it re-reads each cited run and checks the
 * quoted `pushback` against the real transcript, answering 422 with
 * `{error, unverifiedClaim: {runId, pushback}}` when a quote is not there. That verdict is
 * returned to the model as a tool result, with instructions to re-read the run and fix the
 * quote — bounded to {@link MAX_SUBMIT_ATTEMPTS} POSTs, after which the tool stops accepting
 * submissions rather than letting the turn spin.
 */
export default tool({
  description:
    "Submit a config-change proposal for the harness under investigation. Requires at least two failure samples, each citing a run id from the evidence pack and the user's pushback VERBATIM — the control plane re-reads the run and rejects the proposal if a quote is not in the transcript. Call this LAST, once the dominant failure mode is identified.",
  inputSchema: z.object({
    harness: z
      .string()
      .optional()
      .describe("Harness slug. Omit to use the harness this investigation was started for."),
    rationale: z
      .string()
      .describe(
        "Why this change. Name the failure MODE and the evidence for it — not the metrics. 'Success rate is 41%' is not a rationale; 'answers cite no source, so users re-ask for the source (runs r3, r7)' is.",
      ),
    evidence: z.object({
      failureSamples: z
        .array(
          z.object({
            runId: z.string().describe("A run id from the evidence pack."),
            pushback: z
              .string()
              .describe(
                "The user's own words, VERBATIM from that run — copy `pushbackQuote` (or `outcome.quote`) exactly, or the exact text from the run's transcript. Do not paraphrase, trim or re-punctuate: the control plane matches this against the real transcript.",
              ),
            issue: z
              .string()
              .describe("What went wrong in that run, in your words. One short sentence."),
          }),
        )
        .describe(
          `At least ${MIN_FAILURE_SAMPLES} samples, drawn from DIFFERENT runs of the dominant failure cluster.`,
        ),
      configSuccessRates: z
        .array(
          z.object({
            configVersionId: z.string(),
            successRate: z.number().nullable(),
            runCount: z.number().int(),
          }),
        )
        .optional()
        .describe("Optional: the per-config-version rates from the evidence pack, copied as-is."),
    }),
    // `looseObject`, not `record`: a zod record emits a `propertyNames` JSON Schema keyword,
    // which is both rejected by alpha LWIR and needlessly exotic for a provider's tool
    // schema. An open object says the same thing in the vocabulary everything accepts.
    proposedConfigPatch: z
      .looseObject({})
      .describe(
        "The SMALLEST partial override of the base config bundle that addresses the dominant failure mode. A delta, not a rewrite: include only the fields you are changing (usually just `prompt`).",
      ),
  }),
  execute: async ({ harness, rationale, evidence, proposedConfigPatch }) => {
    const slug = resolveHarnessSlug(harness);
    const state = investigationState();

    if (evidence.failureSamples.length < MIN_FAILURE_SAMPLES) {
      return {
        status: "rejected-locally",
        reason: `A proposal needs at least ${MIN_FAILURE_SAMPLES} failure samples from different runs; you supplied ${evidence.failureSamples.length}. Find another run in the same cluster and cite its pushback verbatim.`,
      };
    }

    const known = new Set(state.pack?.runs.map((run) => run.runId) ?? []);
    const unknownRunIds = known.size === 0
      ? []
      : evidence.failureSamples.map((sample) => sample.runId).filter((runId) => !known.has(runId));
    if (unknownRunIds.length > 0) {
      return {
        status: "rejected-locally",
        reason: `These run ids are not in the evidence pack: ${unknownRunIds.join(", ")}. Cite runs the pack actually lists.`,
      };
    }

    const body: ProposalBody = {
      rationale,
      evidence: {
        failureSamples: evidence.failureSamples,
        ...(evidence.configSuccessRates === undefined
          ? {}
          : { configSuccessRates: evidence.configSuccessRates }),
      },
      proposedConfigPatch,
      // A constant, never model input: the control plane uses it to tell dreamer-authored
      // proposals apart from the ones its own server-side dream loop writes.
      origin: "dreamer-agent",
    };

    const outcome = await submitProposal(slug, body);

    switch (outcome.kind) {
      case "submitted":
        return {
          status: "submitted",
          proposalId: outcome.proposalId ?? null,
          harness: slug,
          response: outcome.body,
        };
      case "dry-run":
        return {
          status: "dry-run",
          harness: slug,
          note: "Dry run: this body was NOT submitted. The investigation is complete — report it and stop.",
          body: outcome.body,
        };
      case "unverified":
        return {
          status: "unverified-claim",
          error: outcome.error,
          unverifiedClaim: outcome.unverifiedClaim ?? null,
          attemptsLeft: outcome.attemptsLeft,
          nextStep:
            outcome.unverifiedClaim === null || outcome.unverifiedClaim === undefined
              ? "Re-read the cited runs with littledb_load_run and copy each user turn exactly, then submit again."
              : `The quote you attributed to run ${outcome.unverifiedClaim.runId} is not in its transcript. Call littledb_load_run for ${outcome.unverifiedClaim.runId}, copy the user's turn character for character, and submit again. If that run genuinely contains no such pushback, replace the sample with a different run from the same cluster — and if you cannot, say in the rationale which claim you dropped and why.`,
        };
      case "rejected":
        return {
          status: "rejected",
          httpStatus: outcome.status,
          error: outcome.error,
        };
      case "blocked":
        return {
          status: "blocked",
          reason: `You have already used all ${MAX_SUBMIT_ATTEMPTS} submission attempts for '${slug}' and each was rejected as unverified. Stop submitting. Report which claims you could not ground and what you would have proposed.`,
        };
    }
  },
});
