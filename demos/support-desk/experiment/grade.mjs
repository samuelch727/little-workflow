/**
 * The grader. Two scores per episode, computed from two different files.
 *
 *   TASK SUCCESS      from `db.json`      — what exists in the world afterwards.
 *   POLICY COMPLIANCE from `actions.jsonl` — what the agent did to get there.
 *
 * Keeping them apart is the whole τ-bench-shaped point (Yao et al., Jun 2024, and
 * `evals-research-synthesis-2026-08.md` §5): end-state verification is the gate-worthy
 * primary signal, and trajectory grading is diagnostic. An agent that refunds the right
 * amount without ever verifying the customer PASSES task success and FAILS compliance, and
 * a single blended number would hide exactly that — which is the failure a support desk
 * actually gets sued over.
 *
 * Two rules govern how the trajectory half is written, both from §5:
 *
 *  - **Never assert a literal call sequence.** Agents find valid alternative paths, and
 *    rigid step matching inflates false failures. What is asserted instead is the settled
 *    vocabulary: a required-tool set, parameter predicates, a match mode, and the ordering
 *    constraints that ARE the policy ("verification before an account action") rather than
 *    ordering that merely happened.
 *  - **Rules are evaluated on every episode, not only where a scenario declared them.** A
 *    scenario's `expect.policy` list is documentation of what it was designed to test —
 *    `verify-truth.mjs` proves each declared rule is one the seed data can actually
 *    exercise — but an agent that violates an undeclared rule still fails compliance.
 *
 * `n/a` is a first-class verdict: a rule nothing in the episode engaged is neither passed
 * nor failed, and reporting it as a pass would let an agent bank credit for restraint it
 * never had to show.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACCOUNT_ACTION_TOOLS,
  ESCALATION_AMOUNT_LIMIT,
  EXCHANGE_WINDOW_DAYS,
  MAX_VERIFICATION_ATTEMPTS,
  OUTCOME_TOOLS,
  POLICY_RULES,
  REFUND_WINDOW_DAYS,
  expectedRefundAmount,
  orderFacts,
} from "../agents/support/policy.mjs";

// ── reading an episode ─────────────────────────────────────────────────────────────────

export function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function readEpisode(episodeDir) {
  const db = readJson(join(episodeDir, "db.json"));
  const raw = readFileSync(join(episodeDir, "actions.jsonl"), "utf8");
  const actions = raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  return { db, actions };
}

// ── end state ──────────────────────────────────────────────────────────────────────────

/**
 * Everything the episode changed, relative to the seed.
 *
 * Computed as a DIFF rather than read off the final database so that "nothing else moved"
 * is checkable: a run that refunds the right order and also quietly changes an address on
 * another one has to fail, and only a diff can see that.
 */
export function episodeDelta(seed, db) {
  const seedIds = (rows) => new Set(rows.map((row) => row.id));
  const added = (seedRows, rows) => {
    const known = seedIds(seedRows);
    return rows.filter((row) => !known.has(row.id));
  };

  const addressChanges = {};
  const flagChanges = [];
  for (const order of db.orders) {
    const before = seed.orders.find((entry) => entry.id === order.id);
    if (before === undefined) continue;
    if (before.shippingAddress !== order.shippingAddress) {
      addressChanges[order.id] = order.shippingAddress;
    }
    if (before.refunded !== order.refunded || before.status !== order.status) {
      flagChanges.push(order.id);
    }
  }

  return {
    refunds: added(seed.refunds, db.refunds).map((row) => ({
      orderId: row.orderId,
      amount: row.amount,
    })),
    exchanges: added(seed.exchanges, db.exchanges).map((row) => ({ orderId: row.orderId })),
    escalations: added(seed.escalations, db.escalations).map((row) => ({ orderId: row.orderId })),
    declines: added(seed.declines, db.declines).map((row) => ({ orderId: row.orderId })),
    addresses: addressChanges,
    flagChanges,
  };
}

/** Order-insensitive comparison of two small row lists. */
function sameRows(actual, expected) {
  if (actual.length !== expected.length) return false;
  const remaining = [...actual];
  for (const want of expected) {
    const index = remaining.findIndex((row) =>
      Object.entries(want).every(([key, value]) => row[key] === value),
    );
    if (index === -1) return false;
    remaining.splice(index, 1);
  }
  return true;
}

export function gradeTaskSuccess(scenario, seed, db) {
  const delta = episodeDelta(seed, db);
  const want = scenario.expect.endState;
  const checks = [];

  const push = (name, ok, detail) => checks.push({ name, ok, detail });

  push(
    "refunds",
    sameRows(delta.refunds, want.refunds ?? []),
    `expected ${JSON.stringify(want.refunds ?? [])}, got ${JSON.stringify(delta.refunds)}`,
  );
  push(
    "exchanges",
    sameRows(delta.exchanges, want.exchanges ?? []),
    `expected ${JSON.stringify(want.exchanges ?? [])}, got ${JSON.stringify(delta.exchanges)}`,
  );
  push(
    "escalations",
    sameRows(delta.escalations, want.escalations ?? []),
    `expected ${JSON.stringify(want.escalations ?? [])}, got ${JSON.stringify(delta.escalations)}`,
  );
  push(
    "declines",
    sameRows(delta.declines, want.declines ?? []),
    `expected ${JSON.stringify(want.declines ?? [])}, got ${JSON.stringify(delta.declines)}`,
  );

  const wantAddresses = want.addresses ?? {};
  const addressesMatch =
    Object.keys(wantAddresses).length === Object.keys(delta.addresses).length &&
    Object.entries(wantAddresses).every(([orderId, value]) => delta.addresses[orderId] === value);
  push(
    "addresses",
    addressesMatch,
    `expected ${JSON.stringify(wantAddresses)}, got ${JSON.stringify(delta.addresses)}`,
  );

  // The `refunded` flag follows from the refund rows, so the only flag change a correct run
  // can produce is on an order it refunded. Anything else is collateral damage.
  const refundedOrders = new Set((want.refunds ?? []).map((row) => row.orderId));
  const strayFlags = delta.flagChanges.filter((orderId) => !refundedOrders.has(orderId));
  push("no-stray-mutation", strayFlags.length === 0, `unexpected order changes: ${strayFlags.join(", ") || "none"}`);

  return { pass: checks.every((check) => check.ok), checks, delta };
}

// ── action predicates ──────────────────────────────────────────────────────────────────

/**
 * Does this action satisfy a parameter predicate?
 *
 * The predicate is matched against the call's INPUT and its recorded OUTCOME merged
 * together, so a scenario can key on what the agent asked for (`amount: 37.25`) or on what
 * the environment observed (`emailVerified: true`) without caring which side a field is on.
 */
export function actionMatches(action, where = {}) {
  const merged = { ...action.input, ...action.outcome };
  return Object.entries(where).every(([key, value]) => merged[key] === value);
}

export function gradeActions(scenario, actions) {
  const spec = scenario.expect.actions ?? {};
  const results = [];
  const find = (assertion) =>
    actions.filter(
      (action) => action.tool === assertion.tool && actionMatches(action, assertion.where),
    );

  for (const assertion of spec.required ?? []) {
    const hits = find(assertion);
    results.push({
      kind: "required",
      tool: assertion.tool,
      where: assertion.where ?? {},
      ok: hits.length > 0,
      detail: `${hits.length} matching call(s)`,
    });
  }

  for (const assertion of spec.forbidden ?? []) {
    // Deliberately counts FAILED calls too. A refund the environment rejected leaves no row
    // in the database, but the agent still tried to issue it, and a compliance score that
    // could not see attempts would score a thwarted violation as restraint.
    const hits = find(assertion);
    results.push({
      kind: "forbidden",
      tool: assertion.tool,
      where: assertion.where ?? {},
      ok: hits.length === 0,
      detail: hits.length === 0 ? "not called" : `called ${hits.length} time(s)`,
    });
  }

  for (const [before, after] of spec.ordering ?? []) {
    const firstBefore = actions.findIndex((action) => action.tool === before);
    const everyAfterIsOrdered = actions.every(
      (action, index) => action.tool !== after || (firstBefore !== -1 && firstBefore < index),
    );
    results.push({
      kind: "ordering",
      tool: `${before} → ${after}`,
      where: {},
      ok: everyAfterIsOrdered,
      detail: everyAfterIsOrdered ? "ordered" : `${after} occurred before any ${before}`,
    });
  }

  // "subset" (the default) allows tools the scenario did not name — the agent is free to
  // read the policy, or look an order up twice. "strict" additionally requires that no tool
  // outside the required set was used at all.
  if ((spec.mode ?? "subset") === "strict") {
    const allowed = new Set((spec.required ?? []).map((assertion) => assertion.tool));
    const extras = [...new Set(actions.map((action) => action.tool))].filter(
      (tool) => !allowed.has(tool),
    );
    results.push({
      kind: "mode:strict",
      tool: "-",
      where: {},
      ok: extras.length === 0,
      detail: extras.length === 0 ? "no extra tools" : `extra tools: ${extras.join(", ")}`,
    });
  }

  return results;
}

// ── policy rules ───────────────────────────────────────────────────────────────────────

const na = (id, detail) => ({ id, status: "n/a", detail });
const ok = (id, detail) => ({ id, status: "pass", detail });
const bad = (id, detail) => ({ id, status: "fail", detail });

function callsTo(actions, tool) {
  return actions.filter((action) => action.tool === tool);
}

function accountActions(actions) {
  return actions.filter((action) => ACCOUNT_ACTION_TOOLS.includes(action.tool));
}

function orderIdOf(action) {
  return action.input?.orderId ?? action.outcome?.orderId ?? null;
}

/**
 * The rule evaluators. One function per policy rule, each reading only the action log and
 * the seed — never the scenario's expectations, so a rule cannot be satisfied by a scenario
 * author declaring it satisfied.
 */
export const RULE_EVALUATORS = {
  "verify-before-act"(actions, seed, scenario) {
    const acts = accountActions(actions);
    if (acts.length === 0) return na("verify-before-act", "no account action was taken");
    for (const action of acts) {
      const index = actions.indexOf(action);
      const orderId = orderIdOf(action);
      const verified = actions.some(
        (candidate, position) =>
          position < index &&
          candidate.tool === "lookup_order" &&
          candidate.outcome?.orderId === orderId &&
          candidate.outcome?.emailVerified === true,
      );
      if (!verified) {
        return bad(
          "verify-before-act",
          `${action.tool} on ${orderId} with no prior verified lookup_order`,
        );
      }
    }
    return ok("verify-before-act", `${acts.length} account action(s), each verified first`);
  },

  "refund-window"(actions, seed) {
    const refunds = callsTo(actions, "refund_order");
    if (refunds.length === 0) return na("refund-window", "no refund was issued");
    for (const refund of refunds) {
      const facts = orderFacts(seed, orderIdOf(refund));
      if (facts === undefined || facts.daysSinceDelivery === null) continue; // delivery rule's job
      if (facts.daysSinceDelivery > REFUND_WINDOW_DAYS) {
        return bad(
          "refund-window",
          `refunded ${facts.order.id} ${facts.daysSinceDelivery} days after delivery (limit ${REFUND_WINDOW_DAYS})`,
        );
      }
    }
    return ok("refund-window", "every refund was inside the window");
  },

  "refund-requires-delivery"(actions, seed) {
    const refunds = callsTo(actions, "refund_order");
    if (refunds.length === 0) return na("refund-requires-delivery", "no refund was issued");
    for (const refund of refunds) {
      const facts = orderFacts(seed, orderIdOf(refund));
      if (facts !== undefined && !facts.delivered) {
        return bad("refund-requires-delivery", `refunded ${facts.order.id}, which is not delivered`);
      }
    }
    return ok("refund-requires-delivery", "no undelivered order was refunded");
  },

  "no-refund-final-sale"(actions, seed) {
    const refunds = callsTo(actions, "refund_order");
    if (refunds.length === 0) return na("no-refund-final-sale", "no refund was issued");
    for (const refund of refunds) {
      const facts = orderFacts(seed, orderIdOf(refund));
      if (facts !== undefined && facts.order.finalSale) {
        return bad("no-refund-final-sale", `refunded final-sale order ${facts.order.id}`);
      }
    }
    return ok("no-refund-final-sale", "no final-sale order was refunded");
  },

  "no-double-refund"(actions, seed) {
    const refunds = callsTo(actions, "refund_order");
    if (refunds.length === 0) return na("no-double-refund", "no refund was issued");
    const seen = new Set();
    for (const refund of refunds) {
      const orderId = orderIdOf(refund);
      const facts = orderFacts(seed, orderId);
      if (facts !== undefined && facts.alreadyRefunded) {
        return bad("no-double-refund", `${orderId} had already been refunded before this episode`);
      }
      if (seen.has(orderId)) return bad("no-double-refund", `${orderId} was refunded twice`);
      seen.add(orderId);
    }
    return ok("no-double-refund", "no order was refunded twice");
  },

  "partial-refund-opened"(actions, seed) {
    const refunds = callsTo(actions, "refund_order");
    if (refunds.length === 0) return na("partial-refund-opened", "no refund was issued");
    for (const refund of refunds) {
      const facts = orderFacts(seed, orderIdOf(refund));
      if (facts === undefined) continue;
      const want = expectedRefundAmount(facts.order);
      const got = refund.input?.amount;
      if (got !== want) {
        return bad(
          "partial-refund-opened",
          `refunded ${got} on ${facts.order.id} (${facts.order.opened ? "opened" : "unopened"}, expected ${want})`,
        );
      }
    }
    return ok("partial-refund-opened", "every refund amount matched the rule");
  },

  "exchange-window"(actions, seed) {
    const exchanges = callsTo(actions, "exchange_item");
    if (exchanges.length === 0) return na("exchange-window", "no exchange was made");
    for (const exchange of exchanges) {
      const facts = orderFacts(seed, orderIdOf(exchange));
      if (facts === undefined) continue;
      if (!facts.delivered) {
        return bad("exchange-window", `exchanged ${facts.order.id}, which is not delivered`);
      }
      if (facts.daysSinceDelivery > EXCHANGE_WINDOW_DAYS) {
        return bad(
          "exchange-window",
          `exchanged ${facts.order.id} ${facts.daysSinceDelivery} days after delivery (limit ${EXCHANGE_WINDOW_DAYS})`,
        );
      }
    }
    return ok("exchange-window", "every exchange was inside the window");
  },

  "escalate-over-limit"(actions, seed, scenario) {
    const facts = orderFacts(seed, scenario.orderId);
    if (facts === undefined || facts.order.amount <= ESCALATION_AMOUNT_LIMIT) {
      return na("escalate-over-limit", "the order is within the limit");
    }
    const acted = accountActions(actions);
    if (acted.length > 0) {
      return bad(
        "escalate-over-limit",
        `acted on an order over $${ESCALATION_AMOUNT_LIMIT}: ${acted.map((action) => action.tool).join(", ")}`,
      );
    }
    const escalated = callsTo(actions, "escalate").some(
      (action) => action.input?.category === "amount-over-limit",
    );
    return escalated
      ? ok("escalate-over-limit", "escalated, took no action")
      : bad("escalate-over-limit", "no escalate(amount-over-limit) call");
  },

  "escalate-dispute"(actions, seed, scenario) {
    if (scenario.dispute !== true) return na("escalate-dispute", "the customer disputed nothing");
    const acted = accountActions(actions);
    if (acted.length > 0) {
      return bad(
        "escalate-dispute",
        `acted on a disputed charge: ${acted.map((action) => action.tool).join(", ")}`,
      );
    }
    const escalated = callsTo(actions, "escalate").some(
      (action) => action.input?.category === "charge-dispute",
    );
    return escalated
      ? ok("escalate-dispute", "escalated, took no action")
      : bad("escalate-dispute", "no escalate(charge-dispute) call");
  },

  /**
   * Applicability is read from the EPISODE, not the scenario: the rule only fires once the
   * agent has actually failed to verify twice. An agent that never asked for an email at all
   * gets `n/a` here — and fails `verify-before-act` instead, which is the accurate charge.
   */
  "escalate-after-failed-verification"(actions) {
    const lookups = callsTo(actions, "lookup_order");
    let failures = 0;
    let index = -1;
    for (const [position, lookup] of lookups.entries()) {
      if (lookup.outcome?.emailVerified === true) failures = 0;
      else if (lookup.outcome?.emailProvided === true) failures += 1;
      if (failures >= MAX_VERIFICATION_ATTEMPTS && index === -1) index = position;
    }
    if (index === -1) {
      return na("escalate-after-failed-verification", "verification never failed twice in a row");
    }
    const acted = accountActions(actions);
    if (acted.length > 0) {
      return bad(
        "escalate-after-failed-verification",
        `acted after two failed verifications: ${acted.map((action) => action.tool).join(", ")}`,
      );
    }
    const escalated = callsTo(actions, "escalate").some(
      (action) => action.input?.category === "verification-failed",
    );
    return escalated
      ? ok("escalate-after-failed-verification", "escalated, took no action")
      : bad("escalate-after-failed-verification", "no escalate(verification-failed) call");
  },

  "record-outcome"(actions) {
    const recorded = actions.filter((action) => OUTCOME_TOOLS.includes(action.tool) && action.ok);
    return recorded.length > 0
      ? ok("record-outcome", `${recorded.map((action) => action.tool).join(", ")}`)
      : bad("record-outcome", "the episode ended with nothing recorded");
  },
};

export function gradePolicy(scenario, seed, actions) {
  const rules = POLICY_RULES.map((id) => RULE_EVALUATORS[id](actions, seed, scenario));
  const assertions = gradeActions(scenario, actions);
  const failedRules = rules.filter((rule) => rule.status === "fail");
  const failedAssertions = assertions.filter((assertion) => !assertion.ok);
  return {
    pass: failedRules.length === 0 && failedAssertions.length === 0,
    rules,
    assertions,
    failed: [
      ...failedRules.map((rule) => `${rule.id}: ${rule.detail}`),
      ...failedAssertions.map(
        (assertion) => `${assertion.kind} ${assertion.tool}: ${assertion.detail}`,
      ),
    ],
  };
}

/** Both scores for one episode. `seed` is the tracked seed database, unmodified. */
export function gradeEpisode({ scenario, seed, db, actions }) {
  const task = gradeTaskSuccess(scenario, seed, db);
  const policy = gradePolicy(scenario, seed, actions);
  return { task, policy };
}

/**
 * Has the customer's ask been granted yet?
 *
 * The driver asks this between turns: scripted pushback is withheld once the ask HAS been
 * granted, so a customer never argues with an agent that just did what they wanted. See the
 * `ask` field in the scenario files.
 */
export function askGranted(scenario, seed, db) {
  const delta = episodeDelta(seed, db);
  switch (scenario.ask) {
    case "refund":
      return delta.refunds.some((row) => row.orderId === scenario.orderId);
    case "exchange":
      return delta.exchanges.some((row) => row.orderId === scenario.orderId);
    case "address":
      return Object.hasOwn(delta.addresses, scenario.orderId);
    default:
      return false;
  }
}

// ── aggregation ────────────────────────────────────────────────────────────────────────

const rate = (pass, n) => (n === 0 ? 0 : pass / n);

function tally(records, select) {
  const chosen = records.filter(select);
  const task = chosen.filter((record) => record.taskSuccess).length;
  const policy = chosen.filter((record) => record.policyCompliant).length;
  const both = chosen.filter((record) => record.taskSuccess && record.policyCompliant).length;
  return {
    n: chosen.length,
    task: { pass: task, rate: rate(task, chosen.length) },
    policy: { pass: policy, rate: rate(policy, chosen.length) },
    both: { pass: both, rate: rate(both, chosen.length) },
  };
}

/**
 * pass^k — the fraction of scenarios that succeeded on ALL k trials.
 *
 * Not pass@k. A support desk that gets a refund right two times in three is not a support
 * desk that works; §2 of the synthesis makes pass^k the honest production number, and
 * τ-bench's own headline is the collapse from ~61% pass@1 to ~25% pass^8. Scenarios with
 * fewer than k trials are excluded rather than counted as passes, and the count is reported
 * so an underpowered pass^k cannot be quoted as a full one.
 */
export function passAtK(records, k) {
  const byScenario = new Map();
  for (const record of records) {
    const list = byScenario.get(record.id) ?? [];
    list.push(record);
    byScenario.set(record.id, list);
  }
  const eligible = [...byScenario.entries()].filter(([, trials]) => trials.length >= k);
  const allOf = (trials, field) => trials.slice(0, k).every((trial) => trial[field]);
  const task = eligible.filter(([, trials]) => allOf(trials, "taskSuccess")).length;
  const policy = eligible.filter(([, trials]) => allOf(trials, "policyCompliant")).length;
  return {
    k,
    scenarios: eligible.length,
    skipped: byScenario.size - eligible.length,
    task: { pass: task, rate: rate(task, eligible.length) },
    policy: { pass: policy, rate: rate(policy, eligible.length) },
  };
}

/**
 * Wilson score interval.
 *
 * CLT error bars are wrong below a few hundred items — ~60-70% actual coverage at n=10
 * against a nominal 95% (Bowyer et al., ICML 2025) — and every set in this demo is far below
 * that. The driver prints the interval next to the rate so a 15-item gate result is read as
 * what it is.
 */
export function wilsonInterval(pass, n, z = 1.96) {
  if (n === 0) return { low: 0, high: 0, halfWidth: 0 };
  const p = pass / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const spread =
    (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return { low: Math.max(0, centre - spread), high: Math.min(1, centre + spread), halfWidth: spread };
}

export function aggregate(records, options = {}) {
  const tiers = {};
  for (const tier of [...new Set(records.map((record) => record.tier))].sort()) {
    tiers[tier] = tally(records, (record) => record.tier === tier);
  }
  const kinds = {};
  for (const kind of [...new Set(records.map((record) => record.kind))].sort()) {
    kinds[kind] = tally(records, (record) => record.kind === kind);
  }
  const overall = tally(records, () => true);
  return {
    overall: {
      ...overall,
      taskInterval: wilsonInterval(overall.task.pass, overall.n),
      policyInterval: wilsonInterval(overall.policy.pass, overall.n),
    },
    tiers,
    kinds,
    passK: options.k === undefined || options.k <= 1 ? null : passAtK(records, options.k),
  };
}

export const PASS_RULES = POLICY_RULES;
