/**
 * Shared ticket contract for demo-ticket-factory.
 *
 * Pure data + a couple of pure validators so the run script and tests agree on
 * one source of truth for the dataset shape and the allowed label vocabularies.
 */

export const CATEGORIES = [
  "Billing",
  "Account Access",
  "Bug Report",
  "Feature Request",
  "Onboarding",
  "Cancellation",
  "Performance",
  "Integration",
  "Data & Privacy",
  "General Question",
];

export const URGENCIES = ["Low", "Medium", "High", "Critical"];

export const SENTIMENTS = [
  "Positive",
  "Neutral",
  "Frustrated",
  "Angry",
  "Confused",
];

export const PLANS = ["Free", "Starter", "Pro", "Business", "Enterprise"];

export const CHANNELS = ["Email", "Chat", "In-App Form", "Phone Transcript"];

/** Approximate target distribution (shares sum to 1.0). */
export const TARGET_DISTRIBUTION = {
  category: {
    Billing: 0.15,
    "Account Access": 0.12,
    "Bug Report": 0.14,
    "Feature Request": 0.1,
    Onboarding: 0.1,
    Cancellation: 0.08,
    Performance: 0.08,
    Integration: 0.1,
    "Data & Privacy": 0.06,
    "General Question": 0.07,
  },
  urgency: { Low: 0.25, Medium: 0.45, High: 0.25, Critical: 0.05 },
  sentiment: {
    Positive: 0.1,
    Neutral: 0.35,
    Frustrated: 0.3,
    Angry: 0.1,
    Confused: 0.15,
  },
};

/** JSON schema for a single ticket. Used as the worker array item schema. */
export const ticketItemSchema = {
  type: "object",
  required: [
    "ticket_id",
    "customer_name",
    "customer_company",
    "customer_plan",
    "channel",
    "submitted_at",
    "ticket_subject",
    "ticket_body",
    "category",
    "urgency",
    "sentiment",
    "summary",
    "recommended_action",
    "draft_reply",
  ],
  additionalProperties: false,
  properties: {
    ticket_id: { type: "string" },
    customer_name: { type: "string" },
    customer_company: { type: "string" },
    customer_plan: { type: "string", enum: PLANS },
    channel: { type: "string", enum: CHANNELS },
    submitted_at: { type: "string" },
    ticket_subject: { type: "string" },
    ticket_body: { type: "string" },
    category: { type: "string", enum: CATEGORIES },
    urgency: { type: "string", enum: URGENCIES },
    sentiment: { type: "string", enum: SENTIMENTS },
    summary: { type: "string" },
    recommended_action: { type: "string" },
    draft_reply: { type: "string" },
  },
};

export const ticketArraySchema = {
  type: "array",
  items: ticketItemSchema,
};

/** Input schema for the support.ticket.batch workflow (kept permissive). */
export const batchInputSchema = {
  type: "object",
  required: ["count"],
  additionalProperties: true,
  properties: {
    count: { type: "number" },
    startIndex: { type: "number" },
    instructions: { type: "string" },
    mix: { type: "object", additionalProperties: true },
  },
};

const REQUIRED_FIELDS = ticketItemSchema.required;

/**
 * Validate a single ticket against the contract. Returns an array of
 * human-readable problems (empty array means valid). Pure — no throwing.
 *
 * @param {unknown} ticket
 * @returns {string[]}
 */
export function validateTicket(ticket) {
  const problems = [];
  if (ticket === null || typeof ticket !== "object" || Array.isArray(ticket)) {
    return ["not an object"];
  }
  for (const field of REQUIRED_FIELDS) {
    if (!Object.hasOwn(ticket, field)) {
      problems.push(`missing field '${field}'`);
      continue;
    }
    if (typeof ticket[field] !== "string") {
      problems.push(`field '${field}' is not a string`);
    }
  }
  const enumChecks = [
    ["customer_plan", PLANS],
    ["channel", CHANNELS],
    ["category", CATEGORIES],
    ["urgency", URGENCIES],
    ["sentiment", SENTIMENTS],
  ];
  for (const [field, allowed] of enumChecks) {
    const value = ticket[field];
    if (typeof value === "string" && !allowed.includes(value)) {
      problems.push(`field '${field}' value '${value}' not in allowed set`);
    }
  }
  for (const key of Object.keys(ticket)) {
    if (!REQUIRED_FIELDS.includes(key)) {
      problems.push(`unexpected field '${key}'`);
    }
  }
  return problems;
}

/**
 * Format a sequential ticket id like TICKET-0001.
 *
 * @param {number} index 1-based index.
 * @returns {string}
 */
export function formatTicketId(index) {
  return `TICKET-${String(index).padStart(4, "0")}`;
}
