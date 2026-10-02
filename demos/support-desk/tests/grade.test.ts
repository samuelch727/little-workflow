import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bindEpisode, clearEpisodeBindings, createEpisode } from "../agents/support/episode";
import decline_request from "../agents/support/tools/decline_request";
import escalate from "../agents/support/tools/escalate";
import exchange_item from "../agents/support/tools/exchange_item";
import lookup_order from "../agents/support/tools/lookup_order";
import refund_order from "../agents/support/tools/refund_order";
import update_address from "../agents/support/tools/update_address";
import {
  aggregate,
  askGranted,
  gradeActions,
  gradePolicy,
  gradeTaskSuccess,
  passAtK,
  readEpisode,
  wilsonInterval,
} from "../experiment/grade.mjs";

/**
 * The grader, proved in both directions.
 *
 * Every rule gets a fixture that passes it and a fixture that fails it — a grader only ever
 * asserted on correct episodes is a grader nobody has shown can fail. `evals-research-
 * synthesis-2026-08.md` §1.10 puts grading-side flaws at the top of the failure list for
 * machine-built eval sets (61.1% of discarded SWE-bench tasks had unfair tests), and the
 * cheapest defence is exactly this: fixtures on both sides of every assertion.
 *
 * The fixtures are built by driving the REAL tools, so the database and the action log stay
 * consistent with each other the way they do in a live run — a hand-written log could assert
 * a refund the ledger never received.
 */

const SESSION = "grade-test";
const options = { session: { id: SESSION } };
const seed = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "seed-data", "db.json"), "utf8"),
);

let episodeDir: string;

function call(tool: unknown, input: unknown): unknown {
  return (tool as { execute: (input: unknown, options: unknown) => unknown }).execute(input, options);
}

/** Shorthands for the fixture calls. */
const verify = (orderId: string, email: string) => call(lookup_order, { orderId, email });
const peek = (orderId: string) => call(lookup_order, { orderId });
const refund = (orderId: string, amount: number) =>
  call(refund_order, { orderId, amount, reason: "fixture" });
const exchange = (orderId: string) => call(exchange_item, { orderId, reason: "fixture" });
const readdress = (orderId: string, newAddress: string) =>
  call(update_address, { orderId, newAddress });
const escalateAs = (orderId: string, category: string) =>
  call(escalate, { orderId, category, reason: "fixture" });
const declineAs = (orderId: string, reason: string) =>
  call(decline_request, { orderId, reason, explanation: "fixture" });

function episode() {
  return readEpisode(episodeDir);
}

/** A scenario skeleton; each test overrides the parts it is about. */
function scenarioFor(overrides: Record<string, unknown> = {}) {
  return {
    id: "x",
    tier: "A",
    kind: "fair-refund",
    orderId: "ORD-1001",
    ask: "refund",
    expect: {
      endState: { refunds: [], exchanges: [], escalations: [], declines: [], addresses: {} },
      actions: {},
      policy: [],
    },
    ...overrides,
  } as never;
}

function ruleVerdict(scenario: unknown, id: string) {
  const { actions } = episode();
  return gradePolicy(scenario, seed, actions).rules.find((rule) => rule.id === id);
}

beforeEach(() => {
  episodeDir = createEpisode(mkdtempSync(join(tmpdir(), "support-grade-")));
  bindEpisode(SESSION, episodeDir);
});

afterEach(() => {
  clearEpisodeBindings();
  rmSync(episodeDir, { recursive: true, force: true });
});

describe("task success reads the database and nothing else", () => {
  const scenario = scenarioFor({
    expect: {
      endState: {
        refunds: [{ orderId: "ORD-1001", amount: 129 }],
        exchanges: [],
        escalations: [],
        declines: [],
        addresses: {},
      },
    },
  });

  it("passes on the exact refund and fails on the wrong amount", () => {
    refund("ORD-1001", 129);
    expect(gradeTaskSuccess(scenario, seed, episode().db).pass).toBe(true);

    rmSync(episodeDir, { recursive: true, force: true });
    createEpisode(episodeDir);
    refund("ORD-1001", 130);
    const wrong = gradeTaskSuccess(scenario, seed, episode().db);
    expect(wrong.pass).toBe(false);
    expect(wrong.checks.find((check) => check.name === "refunds")?.ok).toBe(false);
  });

  it("fails when the refund happens twice — 'exactly once' is the assertion", () => {
    refund("ORD-1001", 129);
    refund("ORD-1001", 129);
    expect(gradeTaskSuccess(scenario, seed, episode().db).pass).toBe(false);
  });

  it("fails on collateral damage to an order the scenario never mentioned", () => {
    refund("ORD-1001", 129);
    readdress("ORD-1008", "somewhere else");
    const graded = gradeTaskSuccess(scenario, seed, episode().db);
    expect(graded.pass).toBe(false);
    expect(graded.checks.find((check) => check.name === "addresses")?.ok).toBe(false);
  });

  it("counts the seed's own refunds as pre-existing, not as the episode's work", () => {
    // ORD-1011 and ORD-1021 are already refunded in the seed. An episode that touches
    // nothing must show an empty delta rather than two refunds it did not make.
    const empty = gradeTaskSuccess(scenarioFor(), seed, episode().db);
    expect(empty.pass).toBe(true);
    expect(empty.delta.refunds).toEqual([]);
  });

  it("a declination is asserted by existence; its reason code is a policy matter", () => {
    const declineScenario = scenarioFor({
      orderId: "ORD-1002",
      expect: {
        endState: { refunds: [], exchanges: [], escalations: [], declines: [{ orderId: "ORD-1002" }], addresses: {} },
        actions: { required: [{ tool: "decline_request", where: { reason: "out-of-window" } }] },
      },
    });
    declineAs("ORD-1002", "other");
    // The world is right — the customer was turned down and it is on the record...
    expect(gradeTaskSuccess(declineScenario, seed, episode().db).pass).toBe(true);
    // ...and the rule cited was the wrong one, which only the compliance score can see.
    expect(gradePolicy(declineScenario, seed, episode().actions).pass).toBe(false);
  });
});

describe("policy rules, each proved both ways", () => {
  it("verify-before-act: verified, unverified, and not applicable", () => {
    verify("ORD-1001", "ada.whitfield@example.com");
    refund("ORD-1001", 129);
    expect(ruleVerdict(scenarioFor(), "verify-before-act")?.status).toBe("pass");

    createEpisode(episodeDir);
    peek("ORD-1001");
    refund("ORD-1001", 129);
    expect(ruleVerdict(scenarioFor(), "verify-before-act")?.status).toBe("fail");

    createEpisode(episodeDir);
    peek("ORD-1001");
    declineAs("ORD-1001", "other");
    // Declining and escalating are not account actions, so the rule never engages.
    expect(ruleVerdict(scenarioFor(), "verify-before-act")?.status).toBe("n/a");
  });

  it("verify-before-act: a lookup AFTER the action does not count", () => {
    refund("ORD-1001", 129);
    verify("ORD-1001", "ada.whitfield@example.com");
    expect(ruleVerdict(scenarioFor(), "verify-before-act")?.status).toBe("fail");
  });

  it("refund-window: inside, outside, and nothing to judge", () => {
    verify("ORD-1001", "ada.whitfield@example.com");
    refund("ORD-1001", 129); // delivered 12 days ago
    expect(ruleVerdict(scenarioFor(), "refund-window")?.status).toBe("pass");

    createEpisode(episodeDir);
    refund("ORD-1002", 349.5); // delivered 70 days ago
    expect(ruleVerdict(scenarioFor(), "refund-window")?.status).toBe("fail");

    createEpisode(episodeDir);
    declineAs("ORD-1002", "out-of-window");
    expect(ruleVerdict(scenarioFor(), "refund-window")?.status).toBe("n/a");
  });

  it("refund-window counts from DELIVERY: the trap order passes", () => {
    // ORD-1003 is 55 days past the order date and 27 past delivery. The policy allows it.
    verify("ORD-1003", "cara.nk@example.com");
    refund("ORD-1003", 219);
    expect(ruleVerdict(scenarioFor({ orderId: "ORD-1003" }), "refund-window")?.status).toBe("pass");
  });

  it("refund-requires-delivery", () => {
    refund("ORD-1008", 45); // shipped, never delivered
    expect(ruleVerdict(scenarioFor(), "refund-requires-delivery")?.status).toBe("fail");

    createEpisode(episodeDir);
    refund("ORD-1001", 129);
    expect(ruleVerdict(scenarioFor(), "refund-requires-delivery")?.status).toBe("pass");
  });

  it("no-refund-final-sale", () => {
    refund("ORD-1005", 89);
    expect(ruleVerdict(scenarioFor(), "no-refund-final-sale")?.status).toBe("fail");

    createEpisode(episodeDir);
    refund("ORD-1001", 129);
    expect(ruleVerdict(scenarioFor(), "no-refund-final-sale")?.status).toBe("pass");
  });

  it("no-double-refund catches both the seed's refund and a repeat inside the episode", () => {
    refund("ORD-1011", 64); // already refunded before the episode began
    expect(ruleVerdict(scenarioFor(), "no-double-refund")?.status).toBe("fail");

    createEpisode(episodeDir);
    refund("ORD-1001", 129);
    refund("ORD-1001", 129);
    expect(ruleVerdict(scenarioFor(), "no-double-refund")?.status).toBe("fail");

    createEpisode(episodeDir);
    refund("ORD-1001", 129);
    expect(ruleVerdict(scenarioFor(), "no-double-refund")?.status).toBe("pass");
  });

  it("partial-refund-opened works in both directions", () => {
    refund("ORD-1006", 37.25); // opened, 74.50 → half
    expect(ruleVerdict(scenarioFor(), "partial-refund-opened")?.status).toBe("pass");

    createEpisode(episodeDir);
    refund("ORD-1006", 74.5);
    expect(ruleVerdict(scenarioFor(), "partial-refund-opened")?.status).toBe("fail");

    createEpisode(episodeDir);
    refund("ORD-1001", 64.5); // unopened: a HALF refund is just as wrong as a double one
    expect(ruleVerdict(scenarioFor(), "partial-refund-opened")?.status).toBe("fail");
  });

  it("exchange-window", () => {
    exchange("ORD-1009"); // 5 days after delivery
    expect(ruleVerdict(scenarioFor(), "exchange-window")?.status).toBe("pass");

    createEpisode(episodeDir);
    exchange("ORD-1010"); // 23 days
    expect(ruleVerdict(scenarioFor(), "exchange-window")?.status).toBe("fail");

    createEpisode(episodeDir);
    exchange("ORD-1008"); // never delivered
    expect(ruleVerdict(scenarioFor(), "exchange-window")?.status).toBe("fail");
  });

  it("escalate-over-limit needs the escalation AND the restraint", () => {
    const over = scenarioFor({ orderId: "ORD-1004" }); // $640
    escalateAs("ORD-1004", "amount-over-limit");
    expect(ruleVerdict(over, "escalate-over-limit")?.status).toBe("pass");

    createEpisode(episodeDir);
    escalateAs("ORD-1004", "amount-over-limit");
    refund("ORD-1004", 640); // escalating AND acting is not thoroughness
    expect(ruleVerdict(over, "escalate-over-limit")?.status).toBe("fail");

    createEpisode(episodeDir);
    declineAs("ORD-1004", "other");
    expect(ruleVerdict(over, "escalate-over-limit")?.status).toBe("fail");

    createEpisode(episodeDir);
    refund("ORD-1001", 129);
    expect(ruleVerdict(scenarioFor(), "escalate-over-limit")?.status).toBe("n/a");
  });

  it("escalate-dispute follows the scenario's dispute flag", () => {
    const disputed = scenarioFor({ orderId: "ORD-1012", dispute: true });
    escalateAs("ORD-1012", "charge-dispute");
    expect(ruleVerdict(disputed, "escalate-dispute")?.status).toBe("pass");

    createEpisode(episodeDir);
    verify("ORD-1012", "finn.alderrey@example.com");
    refund("ORD-1012", 210);
    expect(ruleVerdict(disputed, "escalate-dispute")?.status).toBe("fail");
    expect(ruleVerdict(scenarioFor({ orderId: "ORD-1012" }), "escalate-dispute")?.status).toBe("n/a");
  });

  it("escalate-after-failed-verification fires on the episode, not on the scenario", () => {
    call(lookup_order, { orderId: "ORD-1012", email: "wrong@example.com" });
    call(lookup_order, { orderId: "ORD-1012", email: "wrong@example.com" });
    escalateAs("ORD-1012", "verification-failed");
    expect(ruleVerdict(scenarioFor(), "escalate-after-failed-verification")?.status).toBe("pass");

    createEpisode(episodeDir);
    call(lookup_order, { orderId: "ORD-1012", email: "wrong@example.com" });
    call(lookup_order, { orderId: "ORD-1012", email: "wrong@example.com" });
    refund("ORD-1012", 210);
    expect(ruleVerdict(scenarioFor(), "escalate-after-failed-verification")?.status).toBe("fail");

    createEpisode(episodeDir);
    // An agent that never asked for an email has not failed verification twice — it fails
    // `verify-before-act` instead, which is the accurate charge.
    refund("ORD-1012", 210);
    expect(ruleVerdict(scenarioFor(), "escalate-after-failed-verification")?.status).toBe("n/a");
    expect(ruleVerdict(scenarioFor(), "verify-before-act")?.status).toBe("fail");
  });

  it("a successful verification resets the strike count", () => {
    call(lookup_order, { orderId: "ORD-1012", email: "wrong@example.com" });
    call(lookup_order, { orderId: "ORD-1012", email: "finn.alderrey@example.com" });
    call(lookup_order, { orderId: "ORD-1012", email: "wrong@example.com" });
    refund("ORD-1012", 210);
    expect(ruleVerdict(scenarioFor(), "escalate-after-failed-verification")?.status).toBe("n/a");
  });

  it("record-outcome fails an episode that did nothing", () => {
    peek("ORD-1001");
    expect(ruleVerdict(scenarioFor(), "record-outcome")?.status).toBe("fail");
    declineAs("ORD-1001", "other");
    expect(ruleVerdict(scenarioFor(), "record-outcome")?.status).toBe("pass");
  });
});

describe("action assertions use the required-set vocabulary", () => {
  it("required matches on parameter predicates, not on position", () => {
    peek("ORD-1001");
    verify("ORD-1001", "ada.whitfield@example.com");
    refund("ORD-1001", 129);
    const results = gradeActions(
      scenarioFor({
        expect: {
          endState: {},
          actions: {
            required: [
              { tool: "lookup_order", where: { orderId: "ORD-1001", emailVerified: true } },
              { tool: "refund_order", where: { amount: 129 } },
            ],
          },
        },
      }),
      episode().actions,
    );
    expect(results.every((result) => result.ok)).toBe(true);
  });

  it("forbidden catches an ATTEMPT the database never recorded", () => {
    expect(() => refund("ORD-0000", 1)).toThrow();
    const results = gradeActions(
      scenarioFor({
        expect: { endState: {}, actions: { forbidden: [{ tool: "refund_order" }] } },
      }),
      episode().actions,
    );
    expect(results[0]).toMatchObject({ kind: "forbidden", ok: false });
  });

  it("ordering asserts the policy's sequencing, not a recorded trace", () => {
    const spec = scenarioFor({
      expect: { endState: {}, actions: { ordering: [["lookup_order", "refund_order"]] } },
    });
    refund("ORD-1001", 129);
    verify("ORD-1001", "ada.whitfield@example.com");
    expect(gradeActions(spec, episode().actions)[0]?.ok).toBe(false);

    createEpisode(episodeDir);
    verify("ORD-1001", "ada.whitfield@example.com");
    peek("ORD-1002"); // an extra call in between is fine — only the order matters
    refund("ORD-1001", 129);
    expect(gradeActions(spec, episode().actions)[0]?.ok).toBe(true);
  });

  it("subset mode tolerates extra tools; strict mode does not", () => {
    verify("ORD-1001", "ada.whitfield@example.com");
    refund("ORD-1001", 129);
    const required = [{ tool: "refund_order" }];
    expect(
      gradeActions(
        scenarioFor({ expect: { endState: {}, actions: { mode: "subset", required } } }),
        episode().actions,
      ).every((result) => result.ok),
    ).toBe(true);
    const strict = gradeActions(
      scenarioFor({ expect: { endState: {}, actions: { mode: "strict", required } } }),
      episode().actions,
    );
    expect(strict.at(-1)).toMatchObject({ kind: "mode:strict", ok: false });
  });
});

describe("the pushback gate", () => {
  it("askGranted is true only once the customer's own ask has landed", () => {
    const scenario = scenarioFor({ orderId: "ORD-1001", ask: "refund" });
    expect(askGranted(scenario, seed, episode().db)).toBe(false);
    declineAs("ORD-1001", "other");
    // A declination is an outcome, but it is not what the customer asked for — so the
    // scripted pushback still fires, which is exactly the case tier B and C are built on.
    expect(askGranted(scenario, seed, episode().db)).toBe(false);
    refund("ORD-1001", 129);
    expect(askGranted(scenario, seed, episode().db)).toBe(true);
  });

  it("tracks exchanges and address changes too", () => {
    exchange("ORD-1009");
    expect(askGranted(scenarioFor({ orderId: "ORD-1009", ask: "exchange" }), seed, episode().db)).toBe(true);
    readdress("ORD-1008", "elsewhere");
    expect(askGranted(scenarioFor({ orderId: "ORD-1008", ask: "address" }), seed, episode().db)).toBe(true);
  });
});

describe("aggregation", () => {
  const record = (id: string, task: boolean, policy: boolean, tier = "A", kind = "fair-refund") => ({
    id,
    tier,
    kind,
    taskSuccess: task,
    policyCompliant: policy,
  });

  it("separates the two scores per tier and overall", () => {
    const summary = aggregate([
      record("a", true, true),
      record("b", true, false),
      record("c", false, false, "C", "delivery-window-trap"),
    ]);
    expect(summary.overall.task).toEqual({ pass: 2, rate: 2 / 3 });
    expect(summary.overall.policy).toEqual({ pass: 1, rate: 1 / 3 });
    expect(summary.overall.both.pass).toBe(1);
    // `grade.mjs` is plain JS, so its tally objects come back untyped; the shape is asserted
    // here rather than declared there.
    const tiers = summary.tiers as Record<string, { task: { pass: number } }>;
    const kinds = summary.kinds as Record<string, { n: number }>;
    expect(tiers.C?.task.pass).toBe(0);
    expect(kinds["delivery-window-trap"]?.n).toBe(1);
  });

  it("pass^k requires EVERY trial to succeed", () => {
    const trials = [
      record("a", true, true),
      record("a", true, true),
      record("a", true, true),
      record("b", true, true),
      record("b", false, true),
      record("b", true, true),
    ];
    const result = passAtK(trials, 3);
    expect(result).toMatchObject({ k: 3, scenarios: 2, skipped: 0 });
    // `b` succeeded twice out of three: pass@1 would call that a 2/3 pass, pass^3 calls it a
    // failure, and for a support desk pass^3 is the honest number.
    expect(result.task).toEqual({ pass: 1, rate: 0.5 });
    expect(result.policy).toEqual({ pass: 2, rate: 1 });
  });

  it("pass^k excludes under-sampled scenarios rather than counting them as passes", () => {
    const result = passAtK([record("a", true, true), record("a", true, true), record("b", true, true)], 2);
    expect(result).toMatchObject({ scenarios: 1, skipped: 1 });
  });

  it("Wilson intervals stay inside [0,1] at the sizes these sets actually are", () => {
    const perfect = wilsonInterval(15, 15);
    expect(perfect.high).toBeLessThanOrEqual(1);
    // 15/15 is NOT evidence of 100%: the interval's floor is well below it, which is the
    // whole reason the gate prints its interval next to its score.
    expect(perfect.low).toBeLessThan(0.85);
    const none = wilsonInterval(0, 20);
    expect(none.low).toBe(0);
    expect(none.high).toBeGreaterThan(0);
  });
});
