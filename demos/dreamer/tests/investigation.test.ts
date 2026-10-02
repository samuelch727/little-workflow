import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setDreamerModel } from "../agents/dreamer/env";
import { runInvestigation } from "../agents/dreamer/investigate";
import {
  scriptedModel,
  unparseableSuccessError,
  type ScriptedModel,
  type ScriptedTurn,
} from "./support/mock-model";
import {
  fullInvestigationTurns,
  PATCH,
  proposalInput,
  workflowOutput,
} from "./support/investigation-script";
import {
  HARNESS_SLUG,
  QUOTE_CITE_1,
  QUOTE_CITE_2,
  startStubLittleDb,
  type StubLittleDb,
} from "./support/stub-littledb";

const DEMO_ROOT = join(import.meta.dirname, "..");
// Vitest runs test FILES in parallel and the session store is a directory in the checkout,
// so each file needs its own. Set before the first `loadHarness`, which reads `env.ts`.
const DATA_DIR = join(tmpdir(), `dreamer-investigation-${process.pid}`);
process.env.DREAMER_DATA_DIR = DATA_DIR;

let stub: StubLittleDb;
let model: ScriptedModel;
let sessionCounter = 0;

/**
 * ONE model instance for the whole file, re-armed per test.
 *
 * A second `loadHarness` in the same process does not re-read the agent folder — jiti's
 * module cache is process-wide, so `agent.ts` and the workflow modules keep the model they
 * captured on the first load. Installing a fresh mock per test would therefore be silently
 * ignored, and every test after the first would run on the first test's exhausted script.
 */
beforeAll(() => {
  model = scriptedModel({ turns: [] });
  setDreamerModel(model);
});

afterAll(async () => {
  setDreamerModel(undefined);
  await rm(DATA_DIR, { recursive: true, force: true });
  // Inline workflows write their sqlite event stores to `<cwd>/<sessionId>/workflows` — the
  // harness hands a workflow a RELATIVE `persistence.dataDir`, resolved against `cwd`.
  for (const entry of await readdir(DEMO_ROOT)) {
    if (entry.startsWith("dream-test-")) {
      await rm(join(DEMO_ROOT, entry), { recursive: true, force: true });
    }
  }
});

beforeEach(async () => {
  stub = await startStubLittleDb();
  sessionCounter += 1;
});

afterEach(async () => {
  await stub.close();
  delete process.env.DREAMER_DRY_RUN;
  delete process.env.DREAMER_CONTROL_PLANE_URL;
  delete process.env.DREAMER_HARNESS;
});

/** A fresh session per test: a reused id would replay the previous test's turn. */
function sessionId(): string {
  return `dream-test-${sessionCounter}`;
}

describe("the dreamer's investigation loop", () => {
  it("--dry-run: sweeps, clusters and builds a citing proposal body without submitting", async () => {
    model.setScript({ turns: fullInvestigationTurns(), workflowOutput });

    const result = await runInvestigation({
      harness: HARNESS_SLUG,
      controlPlaneUrl: stub.controlPlaneUrl,
      dryRun: true,
      sessionId: sessionId(),
    });

    const names = result.toolCalls.map((call) => call.toolName);
    expect(names).toEqual([
      "littledb_evidence_pack",
      "dream_incident_card",
      "dream_incident_card",
      "dream_cluster_cards",
      "littledb_submit_proposal",
    ]);

    // Nothing was posted, and the body the agent would have posted is captured whole.
    expect(stub.proposals).toHaveLength(0);
    expect(result.dryRunSubmissions).toHaveLength(1);

    const body = result.dryRunSubmissions[0]!;
    expect(body.origin).toBe("dreamer-agent");
    expect(body.proposedConfigPatch).toEqual(PATCH);
    expect(body.evidence.failureSamples.length).toBeGreaterThanOrEqual(2);
    // The citations are the fixture's user turns, character for character.
    expect(body.evidence.failureSamples.map((sample) => sample.pushback)).toEqual([
      QUOTE_CITE_1,
      QUOTE_CITE_2,
    ]);
    expect(body.evidence.failureSamples.map((sample) => sample.runId)).toEqual([
      "run_cite_1",
      "run_cite_2",
    ]);
  }, 120_000);

  it("survives DeepSeek's unparseable 200 on the agent's turn AND on a workflow call", async () => {
    // The failure that killed two of three live investigations. It is armed on BOTH sides
    // of the dreamer because they reach the provider by different methods: the agent's own
    // turn runs through `generateText` → `doGenerate`, while every workflow call — the 61
    // incident cards, their planner drafts — runs through the workflow harness's
    // `streamText` → `doStream`. A wrapper covering only one of the two would still lose
    // most runs, so the assertion below insists on seeing a retry of each kind.
    model.setScript({ turns: fullInvestigationTurns(), workflowOutput });
    model.failNext("dreamer", unparseableSuccessError());
    model.failNext("workflow", unparseableSuccessError());

    const stderrLines: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrLines.push(String(chunk));
      return true;
    });

    let result: Awaited<ReturnType<typeof runInvestigation>>;
    try {
      result = await runInvestigation({
        harness: HARNESS_SLUG,
        controlPlaneUrl: stub.controlPlaneUrl,
        dryRun: true,
        sessionId: sessionId(),
      });
    } finally {
      stderr.mockRestore();
    }

    // The investigation is the same one the first test drives — unchanged, not degraded.
    // Without the retry wrapper the first `failNext` alone aborts it with an uncaught
    // `AI_APICallError`, so reaching this assertion IS the proof.
    expect(result.toolCalls.map((call) => call.toolName)).toEqual([
      "littledb_evidence_pack",
      "dream_incident_card",
      "dream_incident_card",
      "dream_cluster_cards",
      "littledb_submit_proposal",
    ]);
    expect(result.dryRunSubmissions).toHaveLength(1);
    expect(result.dryRunSubmissions[0]?.proposedConfigPatch).toEqual(PATCH);

    const retries = stderrLines.filter((line) => line.includes("[dreamer] model "));
    expect(retries.filter((line) => line.includes("doGenerate"))).toHaveLength(1);
    expect(retries.filter((line) => line.includes("doStream"))).toHaveLength(1);
    for (const line of retries) {
      expect(line).toContain("empty response body (HTTP 200)");
    }
  }, 120_000);

  it("re-reads the run and fixes the citation when the control plane answers 422", async () => {
    const PARAPHRASE = "where did that number come from?"; // NOT what the user said.

    const turns: ScriptedTurn[] = [
      { toolCalls: [{ toolName: "littledb_evidence_pack", input: {} }] },
      {
        // First submission tidies up the quote — exactly the mistake the seam exists to catch.
        toolCalls: [
          {
            toolName: "littledb_submit_proposal",
            input: proposalInput({ cite1: PARAPHRASE, cite2: QUOTE_CITE_2 }),
          },
        ],
      },
      { toolCalls: [{ toolName: "littledb_load_run", input: { runId: "run_cite_1" } }] },
      {
        toolCalls: [
          {
            toolName: "littledb_submit_proposal",
            input: proposalInput({ cite1: QUOTE_CITE_1, cite2: QUOTE_CITE_2 }),
          },
        ],
      },
      { text: "Corrected the citation for run_cite_1 and submitted." },
    ];

    model.setScript({ turns, workflowOutput });

    const result = await runInvestigation({
      harness: HARNESS_SLUG,
      controlPlaneUrl: stub.controlPlaneUrl,
      dryRun: false,
      sessionId: sessionId(),
    });

    // Two POSTs: the rejected one, then the corrected one.
    expect(stub.proposals.map((proposal) => proposal.status)).toEqual([422, 201]);
    expect(result.submitAttempts[HARNESS_SLUG]).toBe(2);

    // The agent went back to the engine for the run the 422 named, before resubmitting.
    expect(stub.runReads).toContain("run_cite_1");

    const rejected = stub.proposals[0]!.body as {
      evidence: { failureSamples: Array<{ pushback: string }> };
    };
    const accepted = stub.proposals[1]!.body as {
      evidence: { failureSamples: Array<{ runId: string; pushback: string }> };
    };
    expect(rejected.evidence.failureSamples[0]?.pushback).toBe(PARAPHRASE);
    expect(accepted.evidence.failureSamples[0]?.pushback).toBe(QUOTE_CITE_1);
    // The claim was FIXED, not dropped: run_cite_1 is still cited.
    expect(accepted.evidence.failureSamples.map((sample) => sample.runId)).toEqual([
      "run_cite_1",
      "run_cite_2",
    ]);

    expect(result.submittedProposals).toHaveLength(1);
    expect(result.submittedProposals[0]?.proposalId).toBe("cpr_stub_2");
  }, 120_000);

  it("refuses a proposal with fewer than two citations before it reaches the network", async () => {
    const turns: ScriptedTurn[] = [
      { toolCalls: [{ toolName: "littledb_evidence_pack", input: {} }] },
      {
        toolCalls: [
          {
            toolName: "littledb_submit_proposal",
            input: {
              rationale: "One run is enough, surely.",
              evidence: {
                failureSamples: [
                  { runId: "run_cite_1", pushback: QUOTE_CITE_1, issue: "no source" },
                ],
              },
              proposedConfigPatch: PATCH,
            },
          },
        ],
      },
      { text: "Stopped: not enough grounded citations." },
    ];

    model.setScript({ turns, workflowOutput });

    const result = await runInvestigation({
      harness: HARNESS_SLUG,
      controlPlaneUrl: stub.controlPlaneUrl,
      dryRun: false,
      sessionId: sessionId(),
    });

    expect(stub.proposals).toHaveLength(0);
    expect(result.submitAttempts[HARNESS_SLUG]).toBeUndefined();
    expect(result.submittedProposals).toHaveLength(0);
  }, 120_000);

  it("stops submitting after the bounded retries are used up", async () => {
    const WRONG = "this is not what the user said";
    const badSubmit: ScriptedTurn = {
      toolCalls: [
        {
          toolName: "littledb_submit_proposal",
          input: proposalInput({ cite1: WRONG, cite2: QUOTE_CITE_2 }),
        },
      ],
    };
    const turns: ScriptedTurn[] = [
      { toolCalls: [{ toolName: "littledb_evidence_pack", input: {} }] },
      // A model that never learns: four attempts, all with the same ungrounded quote.
      badSubmit,
      badSubmit,
      badSubmit,
      badSubmit,
      { text: "Could not ground the claim." },
    ];

    model.setScript({ turns, workflowOutput });

    const result = await runInvestigation({
      harness: HARNESS_SLUG,
      controlPlaneUrl: stub.controlPlaneUrl,
      dryRun: false,
      sessionId: sessionId(),
    });

    // Four tool calls, but only three POSTs: initial + two retries. The fourth was blocked
    // in-process, so a looping model cannot hammer the control plane.
    expect(
      result.toolCalls.filter((call) => call.toolName === "littledb_submit_proposal"),
    ).toHaveLength(4);
    expect(stub.proposals).toHaveLength(3);
    expect(stub.proposals.every((proposal) => proposal.status === 422)).toBe(true);
    expect(result.submitAttempts[HARNESS_SLUG]).toBe(3);
    expect(result.submittedProposals).toHaveLength(0);
  }, 120_000);
});
