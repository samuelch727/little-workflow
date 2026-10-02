import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setSupportModel } from "../agents/support/env";
import { runEpisode } from "../agents/support/run-episode";
import { askGranted, gradeEpisode, readEpisode } from "../experiment/grade.mjs";
import { DETECTOR_VERSION, matchingPatterns } from "../experiment/pushback-patterns.mjs";
import { mockAgentModel, type MockAgent } from "./support/mock-agent";

/**
 * The eval set, checked as an instrument rather than as data.
 *
 * `experiment/verify-truth.mjs` proves the scenarios are consistent with the seed on paper.
 * This file proves the stronger property by actually running them: a policy-compliant agent
 * scores 100% (so no scenario is impossible), an agent that follows the v1 prompt does not
 * (so the trap is a trap), and an agent that talks without acting scores zero (so nothing
 * can be passed by doing nothing). All three, over 35 scenarios, with no provider.
 */

const ROOT = mkdtempSync(join(tmpdir(), "support-scenarios-"));
const HERE = import.meta.dirname;

const optimizer = JSON.parse(
  readFileSync(join(HERE, "..", "experiment", "optimizer-truth.json"), "utf8"),
) as { scenarios: Scenario[] };
const gate = JSON.parse(
  readFileSync(join(HERE, "..", "experiment", "gate-truth.json"), "utf8"),
) as { scenarios: Scenario[] };
const seed = JSON.parse(readFileSync(join(HERE, "..", "seed-data", "db.json"), "utf8"));

type Scenario = {
  id: string;
  tier: "A" | "B" | "C";
  kind: string;
  orderId: string;
  ask: string;
  reaction: string | null;
  turns: string[];
  expect: Record<string, unknown>;
};

let agent: MockAgent;

beforeAll(() => {
  agent = mockAgentModel("oracle");
  setSupportModel(agent);
  process.env.SUPPORT_DATA_DIR = join(ROOT, ".little-harness");
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  delete process.env.SUPPORT_DATA_DIR;
});

type Verdict = { id: string; task: boolean; policy: boolean; taskWhy: string[]; policyWhy: string[] };

async function runSet(label: string, scenarios: readonly Scenario[]): Promise<Verdict[]> {
  const verdicts: Verdict[] = [];
  for (const scenario of scenarios) {
    const episodeDir = join(ROOT, label, scenario.id);
    await runEpisode({
      sessionId: `${label}-${scenario.id}`,
      episodeDir,
      turns: scenario.turns,
      telemetry: false,
      // The driver's rule, reproduced: pushback is withheld once the ask has been granted.
      shouldSendTurn: () => !askGranted(scenario, seed, readEpisode(episodeDir).db),
    });
    const { db, actions } = readEpisode(episodeDir);
    const { task, policy } = gradeEpisode({ scenario, seed, db, actions });
    verdicts.push({
      id: scenario.id,
      task: task.pass,
      policy: policy.pass,
      taskWhy: task.checks.filter((check) => !check.ok).map((check) => `${check.name} ${check.detail}`),
      policyWhy: policy.failed,
    });
  }
  return verdicts;
}

describe("the set is disjoint from the gate", () => {
  it("shares no id, no order and no turn text", () => {
    const optimizerIds = new Set(optimizer.scenarios.map((scenario) => scenario.id));
    expect(gate.scenarios.filter((scenario) => optimizerIds.has(scenario.id))).toEqual([]);

    const optimizerOrders = new Set(optimizer.scenarios.map((scenario) => scenario.orderId));
    expect(gate.scenarios.filter((scenario) => optimizerOrders.has(scenario.orderId))).toEqual([]);

    const optimizerTurns = new Set(optimizer.scenarios.flatMap((scenario) => scenario.turns));
    const shared = gate.scenarios
      .flatMap((scenario) => scenario.turns)
      .filter((turn) => optimizerTurns.has(turn));
    expect(shared).toEqual([]);
  });

  it("keeps the gate silent: no gate scenario ever reports an outcome", () => {
    expect(gate.scenarios.filter((scenario) => scenario.reaction !== null)).toEqual([]);
  });

  it("reports on every optimizer tier except C", () => {
    for (const scenario of optimizer.scenarios) {
      expect([scenario.id, scenario.reaction]).toEqual([
        scenario.id,
        scenario.tier === "C" ? null : "auto",
      ]);
    }
  });
});

describe(`pushback is visible to littleDB (${DETECTOR_VERSION})`, () => {
  it("fires at least one detector pattern on every tier-B/C follow-up turn", () => {
    const misses: string[] = [];
    for (const scenario of [...optimizer.scenarios, ...gate.scenarios]) {
      if (scenario.tier === "A") continue;
      for (const [index, turn] of scenario.turns.slice(1).entries()) {
        if (matchingPatterns(turn).length === 0) misses.push(`${scenario.id} turn ${index + 2}`);
      }
    }
    // A tier-C failure reports no outcome at all, so a follow-up no pattern matches is a
    // failure littleDB would never hear about — the tier would be measuring nothing.
    expect(misses).toEqual([]);
  });

  it("never fires on an opening turn, which the detector would ignore anyway", () => {
    // The detector only reads user turns AFTER the first. A first turn that looks like
    // pushback is therefore invisible to it, and writing one would create a scenario whose
    // signal quietly depends on a rule the detector does not have.
    const openers = [...optimizer.scenarios, ...gate.scenarios]
      .map((scenario) => scenario.turns[0] ?? "")
      .filter((turn) => matchingPatterns(turn).length > 0);
    expect(openers).toEqual([]);
  });
});

describe("the set is satisfiable, falsifiable and null-proof", () => {
  it("a policy-following agent scores 100% on both sets, on both scores", async () => {
    agent.setMode("oracle");
    const verdicts = [
      ...(await runSet("oracle-opt", optimizer.scenarios)),
      ...(await runSet("oracle-gate", gate.scenarios)),
    ];
    const failures = verdicts.filter((verdict) => !verdict.task || !verdict.policy);
    // Printed rather than merely counted: a regression here has to name the scenario and the
    // assertion, or the next person has 35 episodes to bisect by hand.
    expect(failures.map((f) => `${f.id}: task[${f.taskWhy}] policy[${f.policyWhy}]`)).toEqual([]);
    expect(verdicts).toHaveLength(35);
  }, 120_000);

  it("an agent following prompt v1 fails exactly the scenarios the trap targets", async () => {
    agent.setMode("v1");
    const verdicts = await runSet("v1-opt", optimizer.scenarios);
    const byId = new Map(verdicts.map((verdict) => [verdict.id, verdict]));

    // The delivery-window traps: v1 counts from the purchase date, so it refuses refunds the
    // policy owes. This is the failure the whole demo exists to have dreaming find.
    for (const id of ["o11", "o15", "o18", "o19", "o20"]) {
      expect([id, byId.get(id)?.task]).toEqual([id, false]);
    }

    // The two-score split, demonstrated. v1 reaches the right END STATE on the fair refund,
    // the in-window exchange, the address change and even the already-refunded order — and
    // gets to all four without ever verifying the customer.
    for (const id of ["o01", "o07", "o09", "o14"]) {
      expect([id, byId.get(id)?.task, byId.get(id)?.policy]).toEqual([id, true, false]);
    }

    // o09 is the sharpest case: v1 declines the already-refunded order for being 86 days past
    // the ORDER date, which happens to leave exactly the declination row the scenario expects.
    // Right outcome, wrong rule — visible only because the reason code is a policy predicate.
    expect(byId.get("o09")?.policyWhy).toEqual(["required decline_request: 0 matching call(s)"]);

    // Wrong actions of the other kinds: full refund on an opened item, refunding a final-sale
    // item, refunding before delivery, exchanging outside the window, acting on an order over
    // $500, acting on a disputed charge, acting with no verification at all.
    for (const id of ["o03", "o04", "o05", "o06", "o08", "o10", "o13", "o16", "o17"]) {
      expect([id, byId.get(id)?.task]).toEqual([id, false]);
    }

    // And the fair controls still pass, so the set can show a regression as well as a fix:
    // both scores are already correct on the orders v1's rules happen to get right.
    for (const id of ["o02", "o12"]) {
      expect([id, byId.get(id)?.task]).toEqual([id, true]);
    }

    // 6/20 and 2/20. Both numbers matter: a set everything fails cannot show a fix, and a
    // policy score far below the task score is the demo's whole thesis in one line — the
    // agent looks two-thirds broken by outcome and is nine-tenths broken by conduct.
    const taskPasses = verdicts.filter((verdict) => verdict.task).length;
    const policyPasses = verdicts.filter((verdict) => verdict.policy).length;
    expect({ taskPasses, policyPasses }).toEqual({ taskPasses: 6, policyPasses: 2 });
  }, 120_000);

  it("an agent that talks without acting scores zero", async () => {
    agent.setMode("null");
    const verdicts = await runSet("null-opt", optimizer.scenarios);
    expect(verdicts.filter((verdict) => verdict.task)).toEqual([]);
    expect(verdicts.filter((verdict) => verdict.policy)).toEqual([]);
    // And it fails for the right reason everywhere: nothing was recorded.
    expect(
      verdicts.filter((verdict) => !verdict.policyWhy.some((why) => why.includes("record-outcome"))),
    ).toEqual([]);
  }, 120_000);
});
