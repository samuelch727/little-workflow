import test from "node:test";
import assert from "node:assert/strict";
import { localWorld } from "little-workflow";
import { runDelegatedCandidates } from "./run.mjs";
import { LOCATIONS, EDUCATION, SOURCES, SENIORITY, STATUSES } from "./candidate-schema.mjs";

const REQUIRED = [
  "candidate_id", "full_name", "email", "location", "headline",
  "years_experience", "current_company", "top_skills", "education",
  "summary", "desired_salary_usd", "source", "seniority", "status", "match_score",
];

function assertValidCandidate(c) {
  for (const f of REQUIRED) assert.ok(f in c, `missing field ${f}`);
  assert.equal(Object.keys(c).length, REQUIRED.length, "no extra fields (additionalProperties: false)");
  assert.ok(LOCATIONS.includes(c.location), `bad location: ${c.location}`);
  assert.ok(EDUCATION.includes(c.education), `bad education: ${c.education}`);
  assert.ok(SOURCES.includes(c.source), `bad source: ${c.source}`);
  assert.ok(SENIORITY.includes(c.seniority), `bad seniority: ${c.seniority}`);
  assert.ok(STATUSES.includes(c.status), `bad status: ${c.status}`);
  assert.equal(typeof c.years_experience, "number");
  assert.ok(c.match_score >= 0 && c.match_score <= 100, `match_score out of range: ${c.match_score}`);
}

test("stub run completes keyless and yields N schema-valid candidates", async () => {
  const world = localWorld({ dataDir: ".little-workflow-test-delegated" });
  const { result, candidates, subRuns } = await runDelegatedCandidates({ useStub: true, count: 6, world });
  assert.equal(result.status, "completed", `run status: ${result.status}`);
  assert.equal(candidates.length, 6);
  assert.equal(subRuns.length, 0, "the stub path runs the workflow directly (no orchestrator sub-runs)");
  for (const c of candidates) assertValidCandidate(c);
});
