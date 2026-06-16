import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SENIORITY,
  SOURCES,
  STATUSES,
  LOCATIONS,
  EDUCATION,
  validateCandidate,
  formatCandidateId,
} from "./candidate-schema.mjs";

function validCandidate(overrides = {}) {
  return {
    candidate_id: "tmp-1",
    full_name: "Ada Devlin",
    email: "ada.devlin@example.com",
    location: LOCATIONS[0],
    headline: "Senior Backend Engineer",
    years_experience: 8,
    current_company: "Fakerly Inc",
    top_skills: ["Go", "PostgreSQL", "Kafka"],
    education: EDUCATION[3],
    summary: "Payments-focused backend engineer with a track record of scaling ledgers.",
    desired_salary_usd: 185000,
    source: SOURCES[0],
    seniority: SENIORITY[2],
    status: STATUSES[0],
    match_score: 88,
    ...overrides,
  };
}

test("a well-formed candidate has no problems", () => {
  assert.deepEqual(validateCandidate(validCandidate()), []);
});

test("flags a missing required field", () => {
  const c = validCandidate();
  delete c.email;
  assert.ok(validateCandidate(c).some((p) => p.includes("email")));
});

test("flags a non-number years_experience / match_score", () => {
  assert.ok(validateCandidate(validCandidate({ years_experience: "8" })).some((p) => p.includes("years_experience")));
  assert.ok(validateCandidate(validCandidate({ match_score: "88" })).some((p) => p.includes("match_score")));
});

test("flags match_score outside 0..100", () => {
  assert.ok(validateCandidate(validCandidate({ match_score: 130 })).some((p) => p.includes("match_score")));
  assert.ok(validateCandidate(validCandidate({ match_score: -5 })).some((p) => p.includes("match_score")));
});

test("flags negative years_experience", () => {
  assert.ok(validateCandidate(validCandidate({ years_experience: -2 })).some((p) => p.includes("years_experience")));
});

test("flags top_skills that is not an array of strings", () => {
  assert.ok(validateCandidate(validCandidate({ top_skills: "Go" })).length > 0);
  assert.ok(validateCandidate(validCandidate({ top_skills: [1, 2] })).length > 0);
  assert.ok(validateCandidate(validCandidate({ top_skills: [] })).length > 0);
});

test("flags an enum value outside the allowed set", () => {
  assert.ok(validateCandidate(validCandidate({ seniority: "Wizard" })).some((p) => p.includes("seniority")));
  assert.ok(validateCandidate(validCandidate({ status: "Ghosted" })).some((p) => p.includes("status")));
  assert.ok(validateCandidate(validCandidate({ source: "Telepathy" })).some((p) => p.includes("source")));
});

test("flags an unexpected field", () => {
  assert.ok(validateCandidate(validCandidate({ ssn: "123-45-6789" })).some((p) => p.includes("ssn")));
});

test("non-object input is reported, not thrown", () => {
  assert.deepEqual(validateCandidate(null), ["not an object"]);
  assert.deepEqual(validateCandidate([]), ["not an object"]);
  assert.deepEqual(validateCandidate("nope"), ["not an object"]);
});

test("formatCandidateId zero-pads to 4 digits", () => {
  assert.equal(formatCandidateId(1), "CAND-0001");
  assert.equal(formatCandidateId(100), "CAND-0100");
  assert.equal(formatCandidateId(2026), "CAND-2026");
});
