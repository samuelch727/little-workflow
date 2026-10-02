#!/usr/bin/env node
/**
 * Ground the scenario files against the seed data, the policy, and each other.
 *
 *   node experiment/verify-truth.mjs
 *
 * Every claim a scenario makes is RECOMPUTED here from `seed-data/db.json` and
 * `agents/support/policy.mjs`, never trusted:
 *
 *   - the order exists and belongs to the customer named;
 *   - the scenario's `kind` is what the dates and flags actually say it is — an
 *     out-of-window scenario really is out of window, a delivery-window trap really was
 *     bought outside 30 days and delivered inside them;
 *   - the expected end state is the one the policy produces, including the exact refund
 *     amount and the reason code on a declination;
 *   - the emails in the turns verify (or, for the verification-failure scenarios, do not);
 *   - every rule a scenario declares is one its data can actually exercise;
 *   - every tier-B/C follow-up turn matches at least one littleDB pushback pattern;
 *   - the optimizer and gate sets share no id, no order and no turn text.
 *
 * This is the grader-validity check that `evals-research-synthesis-2026-08.md` §1.10 says
 * is the dominant failure mode of machine-built eval sets: 61.1% of discarded SWE-bench
 * tasks had unfair tests. An eval set nobody checked back against its own environment is a
 * set that grades against a world that does not exist.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ESCALATION_AMOUNT_LIMIT,
  EXCHANGE_WINDOW_DAYS,
  PARTIAL_REFUND_RATE,
  REFUND_WINDOW_DAYS,
  escalationCategoryFor,
  exchangeVerdict,
  expectedRefundAmount,
  orderFacts,
  refundVerdict,
} from "../agents/support/policy.mjs";
import { DETECTOR_VERSION, matchingPatterns } from "./pushback-patterns.mjs";

const experimentDir = dirname(fileURLToPath(import.meta.url));
const demoRoot = join(experimentDir, "..");

const seed = JSON.parse(readFileSync(join(demoRoot, "seed-data", "db.json"), "utf8"));
const policyText = readFileSync(join(demoRoot, "agents", "support", "policy.md"), "utf8");
const sets = {
  optimizer: JSON.parse(readFileSync(join(experimentDir, "optimizer-truth.json"), "utf8")),
  gate: JSON.parse(readFileSync(join(experimentDir, "gate-truth.json"), "utf8")),
};

const problems = [];
const fail = (where, message) => problems.push(`${where}: ${message}`);

// ── 1. the policy document really states the constants the grader enforces ──────────────

const policyClaims = [
  [`${REFUND_WINDOW_DAYS} days`, "the refund window"],
  [`${EXCHANGE_WINDOW_DAYS} days`, "the exchange window"],
  [`${PARTIAL_REFUND_RATE * 100}%`, "the partial-refund rate"],
  [`$${ESCALATION_AMOUNT_LIMIT}`, "the escalation threshold"],
];
for (const [needle, what] of policyClaims) {
  if (!policyText.includes(needle)) fail("policy.md", `does not state ${what} ("${needle}")`);
}
if (!/\bDELIVERY\b/i.test(policyText)) fail("policy.md", "does not say the window runs from delivery");

// ── 2/3/4. every scenario, against the seed ────────────────────────────────────────────

/**
 * Which rules a scenario is ALLOWED to declare, given its data. A rule declared here that
 * the seed cannot exercise is a scenario claiming to test something it does not.
 */
const RULE_APPLICABILITY = {
  "verify-before-act": (scenario, facts) =>
    expectsAccountAction(scenario) || scenario.kind === "verification-failure",
  "refund-window": (scenario, facts) => facts.delivered,
  "refund-requires-delivery": (scenario, facts) => !facts.delivered,
  "no-refund-final-sale": (scenario, facts) => facts.order.finalSale,
  "no-double-refund": (scenario, facts) => facts.alreadyRefunded,
  "partial-refund-opened": (scenario) => (scenario.expect.endState.refunds ?? []).length > 0,
  "exchange-window": (scenario) => scenario.ask === "exchange",
  "escalate-over-limit": (scenario, facts) => facts.order.amount > ESCALATION_AMOUNT_LIMIT,
  "escalate-dispute": (scenario) => scenario.dispute === true,
  "escalate-after-failed-verification": (scenario) => scenario.kind === "verification-failure",
  "record-outcome": () => true,
};

function expectsAccountAction(scenario) {
  const end = scenario.expect.endState;
  return (
    (end.refunds ?? []).length > 0 ||
    (end.exchanges ?? []).length > 0 ||
    Object.keys(end.addresses ?? {}).length > 0
  );
}

/** What the scenario's `kind` asserts about the order, recomputed. */
const KIND_CHECKS = {
  "fair-refund": (facts) =>
    facts.delivered &&
    facts.daysSinceDelivery <= REFUND_WINDOW_DAYS &&
    facts.daysSincePurchase <= REFUND_WINDOW_DAYS &&
    !facts.order.finalSale &&
    !facts.alreadyRefunded,
  "delivery-window-trap": (facts) =>
    facts.delivered &&
    facts.daysSinceDelivery <= REFUND_WINDOW_DAYS &&
    facts.daysSincePurchase > REFUND_WINDOW_DAYS,
  "out-of-window": (facts) => facts.delivered && facts.daysSinceDelivery > REFUND_WINDOW_DAYS,
  undelivered: (facts) => !facts.delivered,
  "final-sale": (facts) => facts.order.finalSale,
  "opened-partial": (facts) => facts.order.opened,
  "double-refund": (facts) => facts.alreadyRefunded,
  "over-limit-escalate": (facts) => facts.order.amount > ESCALATION_AMOUNT_LIMIT,
  "dispute-escalate": (facts, scenario) => scenario.dispute === true,
  "exchange-in-window": (facts) =>
    facts.delivered && facts.daysSinceDelivery <= EXCHANGE_WINDOW_DAYS,
  "exchange-out-of-window": (facts) =>
    facts.delivered && facts.daysSinceDelivery > EXCHANGE_WINDOW_DAYS,
  "address-update": (facts, scenario) => scenario.ask === "address",
  "verification-failure": () => true,
};

const emailPattern = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g;

function customerFor(scenario) {
  return seed.customers.find((entry) => entry.id === scenario.customer);
}

const rows = [];

for (const [setName, file] of Object.entries(sets)) {
  for (const scenario of file.scenarios) {
    const where = `${setName}/${scenario.id}`;
    const facts = orderFacts(seed, scenario.orderId);
    if (facts === undefined) {
      fail(where, `unknown order ${scenario.orderId}`);
      continue;
    }
    const customer = customerFor(scenario);
    if (customer === undefined) {
      fail(where, `unknown customer ${scenario.customer}`);
      continue;
    }
    if (facts.order.customerId !== scenario.customer) {
      fail(where, `${scenario.orderId} belongs to ${facts.order.customerId}, not ${scenario.customer}`);
    }

    // kind
    const kindCheck = KIND_CHECKS[scenario.kind];
    if (kindCheck === undefined) fail(where, `unknown kind ${scenario.kind}`);
    else if (!kindCheck(facts, scenario)) {
      fail(
        where,
        `kind "${scenario.kind}" is not what the seed says: delivered=${facts.delivered}, ` +
          `daysSinceDelivery=${facts.daysSinceDelivery}, daysSincePurchase=${facts.daysSincePurchase}, ` +
          `amount=${facts.order.amount}, opened=${facts.order.opened}, finalSale=${facts.order.finalSale}, ` +
          `alreadyRefunded=${facts.alreadyRefunded}`,
      );
    }

    // emails in the turns
    const emails = [...scenario.turns.join(" ").matchAll(emailPattern)].map((match) => match[0]);
    const verifies = emails.some(
      (email) => email.toLowerCase() === customer.email.toLowerCase(),
    );
    if (scenario.kind === "verification-failure") {
      if (emails.length === 0) fail(where, "a verification-failure scenario must quote an email");
      if (verifies) fail(where, "a verification-failure scenario must NOT quote the real email");
    } else if (expectsAccountAction(scenario) && !verifies) {
      fail(
        where,
        `expects an account action but the customer never gives the account email (${customer.email})`,
      );
    }

    // expected end state == what the policy computes
    const wantRefunds = scenario.expect.endState.refunds ?? [];
    const wantDeclines = scenario.expect.endState.declines ?? [];
    const wantEscalations = scenario.expect.endState.escalations ?? [];
    const wantExchanges = scenario.expect.endState.exchanges ?? [];
    const options = { dispute: scenario.dispute === true };
    const refund = refundVerdict(seed, scenario.orderId, options);
    const exchange = exchangeVerdict(seed, scenario.orderId, options);
    const escalation =
      scenario.kind === "verification-failure"
        ? "verification-failed"
        : escalationCategoryFor(facts.order, options);

    if (wantRefunds.length > 0) {
      if (!refund.allowed) fail(where, `expects a refund the policy forbids (${refund.reason ?? refund.escalate})`);
      const want = wantRefunds[0];
      const computed = expectedRefundAmount(facts.order);
      if (want.amount !== computed) {
        fail(where, `expects a refund of ${want.amount}; the policy computes ${computed}`);
      }
      if (want.orderId !== scenario.orderId) fail(where, "expects a refund on a different order");
    }
    if (wantExchanges.length > 0 && !exchange.allowed) {
      fail(where, `expects an exchange the policy forbids (${exchange.reason ?? exchange.escalate})`);
    }
    if (wantEscalations.length > 0) {
      if (escalation === null) fail(where, "expects an escalation the policy does not require");
      const declared = requiredWhere(scenario, "escalate")?.category;
      if (declared !== undefined && declared !== escalation) {
        fail(where, `requires escalate(${declared}); the policy says ${escalation}`);
      }
    }
    if (wantDeclines.length > 0) {
      const declared = requiredWhere(scenario, "decline_request")?.reason;
      const computed = scenario.ask === "exchange" ? exchange.reason : refund.reason;
      if (declared !== undefined && declared !== computed) {
        fail(where, `requires decline_request(${declared}); the policy says ${computed}`);
      }
      if (refund.allowed && scenario.ask === "refund") {
        fail(where, "expects a declination on a refund the policy allows");
      }
    }
    if (wantRefunds.length > 0 && escalation !== null) {
      fail(where, `expects a refund on an order policy §4 says to escalate (${escalation})`);
    }

    // declared rules are exercisable
    for (const rule of scenario.expect.policy ?? []) {
      const applies = RULE_APPLICABILITY[rule];
      if (applies === undefined) fail(where, `declares unknown rule ${rule}`);
      else if (!applies(scenario, facts)) fail(where, `declares rule ${rule}, which its data cannot exercise`);
    }

    // pushback turns are visible to littleDB's detector
    const followUps = scenario.turns.slice(1);
    if (scenario.tier === "A" && followUps.length > 0) {
      fail(where, "tier A scenarios are single-turn by definition");
    }
    if (scenario.tier !== "A" && followUps.length === 0) {
      fail(where, `tier ${scenario.tier} must script pushback turns`);
    }
    for (const [index, turn] of followUps.entries()) {
      const matches = matchingPatterns(turn);
      if (matches.length === 0) {
        fail(where, `follow-up turn ${index + 2} matches no ${DETECTOR_VERSION} pattern: "${turn}"`);
      }
    }

    // reactions per tier
    if (setName === "gate" && scenario.reaction !== null) {
      fail(where, "gate scenarios must never report an outcome");
    }
    if (setName === "optimizer") {
      if (scenario.tier === "C" && scenario.reaction !== null) {
        fail(where, "tier C must report no outcome");
      }
      if (scenario.tier !== "C" && scenario.reaction !== "auto") {
        fail(where, `tier ${scenario.tier} must report an outcome`);
      }
    }

    rows.push({
      set: setName,
      id: scenario.id,
      tier: scenario.tier,
      kind: scenario.kind,
      order: scenario.orderId,
      sincePurchase: facts.daysSincePurchase,
      sinceDelivery: facts.daysSinceDelivery === null ? "-" : facts.daysSinceDelivery,
      amount: facts.order.amount,
      expected: describeExpectation(scenario),
      pushback: followUps.map((turn) => matchingPatterns(turn).join("+")).join(" | ") || "-",
    });
  }
}

function requiredWhere(scenario, tool) {
  return (scenario.expect.actions?.required ?? []).find((entry) => entry.tool === tool)?.where;
}

function describeExpectation(scenario) {
  const end = scenario.expect.endState;
  if ((end.refunds ?? []).length > 0) return `refund ${end.refunds[0].amount}`;
  if ((end.exchanges ?? []).length > 0) return "exchange";
  if ((end.escalations ?? []).length > 0) {
    return `escalate ${requiredWhere(scenario, "escalate")?.category ?? ""}`.trim();
  }
  if ((end.declines ?? []).length > 0) {
    return `decline ${requiredWhere(scenario, "decline_request")?.reason ?? ""}`.trim();
  }
  if (Object.keys(end.addresses ?? {}).length > 0) return "update address";
  return "nothing";
}

// ── 5. the two sets are disjoint ───────────────────────────────────────────────────────

const optimizer = sets.optimizer.scenarios;
const gate = sets.gate.scenarios;

const sharedIds = optimizer.filter((scenario) => gate.some((other) => other.id === scenario.id));
if (sharedIds.length > 0) fail("sets", `shared scenario ids: ${sharedIds.map((s) => s.id).join(", ")}`);

const optimizerOrders = new Set(optimizer.map((scenario) => scenario.orderId));
const sharedOrders = [...new Set(gate.map((scenario) => scenario.orderId))].filter((id) =>
  optimizerOrders.has(id),
);
if (sharedOrders.length > 0) fail("sets", `shared order ids: ${sharedOrders.join(", ")}`);

const optimizerTurns = new Set(optimizer.flatMap((scenario) => scenario.turns));
const sharedTurns = gate.flatMap((scenario) => scenario.turns).filter((turn) => optimizerTurns.has(turn));
if (sharedTurns.length > 0) fail("sets", `shared turn text: ${sharedTurns.length} line(s)`);

// ── report ─────────────────────────────────────────────────────────────────────────────

function table(rows, columns) {
  const header = columns.map((column) => column.label);
  const body = rows.map((row) => columns.map((column) => String(row[column.key])));
  const widths = header.map((label, index) =>
    Math.max(label.length, ...body.map((cells) => cells[index].length)),
  );
  const line = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join("  ");
  return [line(header), widths.map((width) => "-".repeat(width)).join("  "), ...body.map(line)].join(
    "\n",
  );
}

console.log(`seed: ${seed.orders.length} orders, ${seed.customers.length} customers, asOf ${seed.asOf}`);
console.log(
  `policy: refund ${REFUND_WINDOW_DAYS}d from delivery, exchange ${EXCHANGE_WINDOW_DAYS}d, ` +
    `opened ${PARTIAL_REFUND_RATE * 100}%, escalate over $${ESCALATION_AMOUNT_LIMIT}`,
);
console.log(`detector fixture: ${DETECTOR_VERSION}\n`);

console.log(
  table(rows, [
    { key: "set", label: "set" },
    { key: "id", label: "id" },
    { key: "tier", label: "tier" },
    { key: "kind", label: "kind" },
    { key: "order", label: "order" },
    { key: "sincePurchase", label: "d-purch" },
    { key: "sinceDelivery", label: "d-deliv" },
    { key: "amount", label: "amount" },
    { key: "expected", label: "policy says" },
    { key: "pushback", label: "pushback patterns" },
  ]),
);

const counts = (scenarios, key) =>
  Object.entries(
    scenarios.reduce((tally, scenario) => {
      tally[scenario[key]] = (tally[scenario[key]] ?? 0) + 1;
      return tally;
    }, {}),
  )
    .sort()
    .map(([name, n]) => `${name}=${n}`)
    .join(" ");

console.log(`\noptimizer: ${optimizer.length} scenarios — tiers ${counts(optimizer, "tier")}`);
console.log(`           kinds ${counts(optimizer, "kind")}`);
console.log(`gate:      ${gate.length} scenarios — tiers ${counts(gate, "tier")}`);
console.log(`           kinds ${counts(gate, "kind")}`);
console.log(
  `disjoint:  ids ✓  orders ✓  turn text ✓ (${optimizerTurns.size} vs ${new Set(gate.flatMap((s) => s.turns)).size} lines)`,
);

if (problems.length > 0) {
  console.error(`\n${problems.length} PROBLEM(S):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log("\nAll scenario expectations are reachable from the seed data and the policy.");
}
