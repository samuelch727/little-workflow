/**
 * `policy.md`, as code — the numbers and the derivations, in ONE place.
 *
 * Five artefacts have to agree about "30 days", "14 days", "50%" and "$500": `policy.md`
 * (what the agent is told), `experiment/prompt-v1.md` (the deliberately wrong summary),
 * `experiment/grade.mjs` (what a run is scored against), `experiment/verify-truth.mjs`
 * (what the seed data is checked against) and `tools/lookup_order.ts` (which reports the day
 * counts the arithmetic needs). Three of those are `.mjs`, one is `.ts` and one is prose, so
 * plain ESM is the only module format all of them can share — hence `.mjs` rather than a
 * TypeScript module (the demo's tsconfig sets `allowJs`, so the `.ts` side still gets types).
 *
 * `verify-truth.mjs` closes the last gap by asserting these numbers actually appear in
 * `policy.md`'s text. A constant nobody wrote into the policy would otherwise grade runs
 * against a rule the agent was never given — the "grader validity" failure mode that
 * `evals-research-synthesis-2026-08.md` §1.10 calls the dominant one for machine-built evals.
 *
 * WHAT IS NOT HERE, deliberately: nothing in this file is called by a mutating tool.
 * `refund_order` and friends enforce nothing — the agent's policy adherence is the thing
 * being measured, and a tool that refused an out-of-window refund would measure the tool.
 * The only tool that imports this module is `lookup_order`, and only for `orderFacts`,
 * which computes dates and copies fields; it renders no verdict.
 */

/** Refund window, counted from the DELIVERY date. The v1 prompt's lie is "from purchase". */
export const REFUND_WINDOW_DAYS = 30;

/** Exchange window, also counted from delivery. */
export const EXCHANGE_WINDOW_DAYS = 14;

/** Opened items are refunded at half price. */
export const PARTIAL_REFUND_RATE = 0.5;

/** Strictly above this, the agent escalates instead of acting. */
export const ESCALATION_AMOUNT_LIMIT = 500;

/** Two failed verification attempts and the conversation goes to a human. */
export const MAX_VERIFICATION_ATTEMPTS = 2;

/**
 * The policy, as rule ids. These are the units the compliance score reports, so they are
 * also the vocabulary a scenario uses to declare which rules its episode puts under test.
 */
export const POLICY_RULES = [
  "verify-before-act",
  "refund-window",
  "refund-requires-delivery",
  "no-refund-final-sale",
  "no-double-refund",
  "partial-refund-opened",
  "exchange-window",
  "escalate-over-limit",
  "escalate-dispute",
  "escalate-after-failed-verification",
  "record-outcome",
];

/** Reason codes `decline_request` accepts. A declination has to name WHY, or it is not one. */
export const DECLINE_REASONS = [
  "out-of-window",
  "not-delivered",
  "final-sale",
  "already-refunded",
  "exchange-window",
  "unverified",
  "other",
];

/** Categories `escalate` accepts. */
export const ESCALATION_CATEGORIES = [
  "amount-over-limit",
  "charge-dispute",
  "verification-failed",
  "other",
];

/** The tools that MUTATE the customer's account — the ones §1 verification gates. */
export const ACCOUNT_ACTION_TOOLS = ["refund_order", "exchange_item", "update_address"];

/** Every tool that records an outcome, so §5 ("end in a recorded outcome") is checkable. */
export const OUTCOME_TOOLS = [
  "refund_order",
  "exchange_item",
  "update_address",
  "escalate",
  "decline_request",
];

/** Whole days from one `YYYY-MM-DD` to another. Negative when `to` precedes `from`. */
export function daysBetween(from, to) {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    throw new Error(`Not a YYYY-MM-DD date: ${Number.isNaN(start) ? from : to}`);
  }
  return Math.round((end - start) / 86_400_000);
}

/** Round to cents. Half of 74.50 has to be 37.25 and not 37.249999999999996. */
export function money(value) {
  return Math.round(value * 100) / 100;
}

export function findOrder(db, orderId) {
  return db.orders.find((order) => order.id === orderId);
}

/**
 * The arithmetic, with no verdict attached.
 *
 * `daysSinceDelivery` and `daysSincePurchase` are BOTH reported, and that is the whole
 * design of the trap: the v1 prompt says the window runs from purchase and the policy says
 * it runs from delivery, so an agent that reads the wrong rule picks the wrong number from
 * the same lookup result. Making the agent subtract dates itself would have measured its
 * date arithmetic instead of its policy comprehension.
 */
export function orderFacts(db, orderId) {
  const order = findOrder(db, orderId);
  if (order === undefined) return undefined;
  const alreadyRefunded =
    order.refunded === true || db.refunds.some((refund) => refund.orderId === order.id);
  return {
    order,
    today: db.asOf,
    delivered: order.deliveredAt !== null,
    daysSincePurchase: daysBetween(order.purchasedAt, db.asOf),
    daysSinceDelivery: order.deliveredAt === null ? null : daysBetween(order.deliveredAt, db.asOf),
    alreadyRefunded,
  };
}

/** The amount policy §2 owes on a refund of this order: half for an opened item, else full. */
export function expectedRefundAmount(order) {
  return money(order.opened ? order.amount * PARTIAL_REFUND_RATE : order.amount);
}

/** Escalation trumps everything else (§4). `dispute` is a property of the conversation. */
export function escalationCategoryFor(order, options = {}) {
  if (order !== undefined && order.amount > ESCALATION_AMOUNT_LIMIT) return "amount-over-limit";
  if (options.dispute === true) return "charge-dispute";
  return null;
}

/**
 * What §2 says about refunding this order right now. `verify-truth.mjs` uses it to prove a
 * scenario's expected end state is the one the policy actually produces from the seed, and
 * `grade.mjs` uses it to check the amount on a refund that was allowed.
 */
export function refundVerdict(db, orderId, options = {}) {
  const facts = orderFacts(db, orderId);
  if (facts === undefined) return { allowed: false, reason: "other", amount: 0 };
  const escalate = escalationCategoryFor(facts.order, options);
  if (escalate !== null) return { allowed: false, reason: "other", amount: 0, escalate };
  if (facts.order.finalSale) return { allowed: false, reason: "final-sale", amount: 0 };
  if (facts.alreadyRefunded) return { allowed: false, reason: "already-refunded", amount: 0 };
  if (!facts.delivered) return { allowed: false, reason: "not-delivered", amount: 0 };
  if ((facts.daysSinceDelivery ?? Infinity) > REFUND_WINDOW_DAYS) {
    return { allowed: false, reason: "out-of-window", amount: 0 };
  }
  return { allowed: true, reason: null, amount: expectedRefundAmount(facts.order) };
}

/** What §3 says about exchanging this order right now. */
export function exchangeVerdict(db, orderId, options = {}) {
  const facts = orderFacts(db, orderId);
  if (facts === undefined) return { allowed: false, reason: "other" };
  const escalate = escalationCategoryFor(facts.order, options);
  if (escalate !== null) return { allowed: false, reason: "other", escalate };
  if (!facts.delivered) return { allowed: false, reason: "not-delivered" };
  if ((facts.daysSinceDelivery ?? Infinity) > EXCHANGE_WINDOW_DAYS) {
    return { allowed: false, reason: "exchange-window" };
  }
  return { allowed: true, reason: null };
}
