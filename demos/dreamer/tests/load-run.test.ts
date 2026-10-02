import { afterEach, beforeEach, expect, it } from "vitest";
import loadRunTool from "../agents/dreamer/tools/littledb_load_run";
import { resetInvestigationState } from "../agents/dreamer/littledb-api";
import { QUOTE_CITE_1, QUOTE_LONG_TAIL, startStubLittleDb, type StubLittleDb } from "./support/stub-littledb";

let stub: StubLittleDb;

beforeEach(async () => {
  stub = await startStubLittleDb();
  resetInvestigationState();
  // No evidence pack has been fetched in this realm, so the tool falls back to the
  // configured engine URL — which is exactly the path this test wants to pin.
  process.env.LITTLEDB_ENGINE_URL = stub.engineUrl;
});

afterEach(async () => {
  await stub.close();
  delete process.env.LITTLEDB_ENGINE_URL;
  resetInvestigationState();
});

type LoadRunResult = {
  runId: string;
  eventCount: number;
  events: unknown[];
  truncated?: { kept: number; of: number; note: string };
};

async function loadRun(runId: string): Promise<LoadRunResult> {
  const result = await loadRunTool.execute?.({ runId }, { toolCallId: "call_1" } as never);
  return result as LoadRunResult;
}

it("returns a short run's events whole and unmodified", async () => {
  const result = await loadRun("run_cite_1");

  expect(result.runId).toBe("run_cite_1");
  expect(result.truncated).toBeUndefined();
  expect(result.events).toHaveLength(result.eventCount);
  expect(JSON.stringify(result.events)).toContain(QUOTE_CITE_1);
});

/**
 * The direction of truncation is the whole point. Pushback is the LAST thing in a run — it
 * is the turn correcting the answer — so a long run whose tail was dropped would make its
 * citation permanently unrepairable: the agent re-reads the run after a 422, cannot find the
 * quote, and abandons a claim that was true.
 */
it("keeps the END of a long run, where the pushback is", async () => {
  const result = await loadRun("run_long_1");

  expect(result.truncated).toBeDefined();
  expect(result.truncated?.kept).toBeLessThan(result.eventCount);
  expect(result.events.length).toBe(result.truncated?.kept);

  const rendered = JSON.stringify(result.events);
  // The citable quote survived…
  expect(rendered).toContain(QUOTE_LONG_TAIL);
  // …and it survived because the tail was kept, not because everything fit.
  expect(rendered).not.toContain("filler question 0");
  // Chronological order is preserved: the last event is still the last event.
  const last = JSON.stringify(result.events[result.events.length - 1]);
  expect(last).toContain("It is in expenses.md.");
});

it("reports a run the engine does not have as an error, not as an empty transcript", async () => {
  await expect(loadRun("run_does_not_exist")).rejects.toThrow(/not in the engine/);
});
