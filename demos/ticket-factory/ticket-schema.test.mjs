import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CATEGORIES,
  formatTicketId,
  validateTicket,
} from "./ticket-schema.mjs";

function validTicket(overrides = {}) {
  return {
    ticket_id: "TICKET-0001",
    customer_name: "Jordan Lee",
    customer_company: "BrightPath Dental",
    customer_plan: "Pro",
    channel: "Email",
    submitted_at: "2026-05-01T09:42:00Z",
    ticket_subject: "Charged twice",
    ticket_body: "Body text.",
    category: "Billing",
    urgency: "High",
    sentiment: "Frustrated",
    summary: "Duplicate charge.",
    recommended_action: "Refund if confirmed.",
    draft_reply: "Hi Jordan, sorry about that.",
    ...overrides,
  };
}

test("validateTicket accepts a well-formed ticket", () => {
  assert.deepEqual(validateTicket(validTicket()), []);
});

test("validateTicket flags missing fields", () => {
  const ticket = validTicket();
  delete ticket.summary;
  assert.ok(validateTicket(ticket).some((p) => p.includes("summary")));
});

test("validateTicket flags out-of-vocabulary enums", () => {
  const problems = validateTicket(validTicket({ category: "Nonsense" }));
  assert.ok(problems.some((p) => p.includes("not in allowed set")));
});

test("validateTicket flags unexpected fields", () => {
  const problems = validateTicket(validTicket({ extra: "x" }));
  assert.ok(problems.some((p) => p.includes("unexpected field 'extra'")));
});

test("validateTicket rejects non-objects", () => {
  assert.deepEqual(validateTicket(null), ["not an object"]);
  assert.deepEqual(validateTicket([]), ["not an object"]);
});

test("formatTicketId zero-pads to four digits", () => {
  assert.equal(formatTicketId(1), "TICKET-0001");
  assert.equal(formatTicketId(42), "TICKET-0042");
  assert.equal(formatTicketId(500), "TICKET-0500");
});

test("CATEGORIES has the ten expected categories", () => {
  assert.equal(CATEGORIES.length, 10);
});
