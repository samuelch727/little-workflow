import { runIdFromPrompt, type ScriptedTurn } from "./mock-model";
import { QUOTE_CITE_1, QUOTE_CITE_2 } from "./stub-littledb";

/**
 * The scripted investigation, in one place.
 *
 * Both the in-process loop test and the `run.mjs` subprocess test drive the SAME script, so
 * "what the driver prints" and "what the loop produced" cannot drift apart.
 */

export const PATCH = {
  prompt:
    "You are the Librarian, the knowledge-base assistant for Northwind Systems.\n\nAlways cite the source file on its own line, exactly like this: `Source: vacation-policy.md`.",
};

/** The card the mock returns for whichever run the workflow prompt names. */
export function cardFor(promptText: string): unknown {
  const runId = runIdFromPrompt(promptText);
  const quote = runId === "run_cite_2" ? QUOTE_CITE_2 : QUOTE_CITE_1;
  return {
    runId,
    symptom: "answered without naming a source",
    userQuote: quote,
    wrongAnswerSummary: "gave a number with no file reference",
    suspectedCause: "prompt never requires a Source line",
  };
}

export function clustering(): unknown {
  return {
    clusters: [
      {
        label: "answers omit their source",
        runIds: ["run_cite_1", "run_cite_2"],
        dominantCause: "the prompt never requires a citation",
      },
    ],
    dominantCluster: "answers omit their source",
  };
}

/** Route a workflow model call to the right template output. */
export function workflowOutput(promptText: string): unknown {
  return promptText.includes("dream.cluster-cards") ||
    promptText.includes("Group incident cards into failure modes")
    ? clustering()
    : cardFor(promptText);
}

export function proposalInput(quotes: { readonly cite1: string; readonly cite2: string }) {
  return {
    rationale:
      "Answers give a fact with no source, so users immediately re-ask where it came from (runs run_cite_1, run_cite_2). The production prompt never requires a citation.",
    evidence: {
      failureSamples: [
        { runId: "run_cite_1", pushback: quotes.cite1, issue: "answered 20 days with no source file" },
        { runId: "run_cite_2", pushback: quotes.cite2, issue: "answered carry-over with no source file" },
      ],
      configSuccessRates: [
        { configVersionId: "cfgv_002", successRate: 1 / 6, runCount: 7 },
        { configVersionId: "cfgv_001", successRate: 1, runCount: 1 },
      ],
    },
    proposedConfigPatch: PATCH,
  };
}

/** Evidence pack → sweep two cards in one step → cluster → submit → report. */
export function fullInvestigationTurns(): ScriptedTurn[] {
  return [
    { toolCalls: [{ toolName: "littledb_evidence_pack", input: {} }] },
    {
      // The sweep: one card per failure run, all in ONE step — the shape the doctrine asks
      // for and the shape the concurrency gate bounds.
      toolCalls: [
        {
          toolName: "dream_incident_card",
          input: {
            runId: "run_cite_1",
            transcript: `user: how many vacation days do I get?\nassistant: You get 20 vacation days a year.\nuser: ${QUOTE_CITE_1}`,
            outcome: "failure (inferred from user pushback)",
          },
        },
        {
          toolName: "dream_incident_card",
          input: {
            runId: "run_cite_2",
            transcript: `user: can I carry vacation days over?\nassistant: Carry-over is capped at 5 days.\nuser: ${QUOTE_CITE_2}`,
            outcome: "failure (inferred from user pushback)",
          },
        },
      ],
    },
    { toolCalls: [{ toolName: "dream_cluster_cards", input: { cards: [] } }] },
    {
      toolCalls: [
        {
          toolName: "littledb_submit_proposal",
          input: proposalInput({ cite1: QUOTE_CITE_1, cite2: QUOTE_CITE_2 }),
        },
      ],
    },
    { text: "Dominant mode: answers omit their source. Proposed a citation requirement." },
  ];
}
