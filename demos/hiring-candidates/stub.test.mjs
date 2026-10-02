import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeterministicCandidates, buildDeterministicPost } from "./stub.mjs";
import { validateCandidate, postSchema } from "./candidate-schema.mjs";

test("buildDeterministicCandidates produces `count` schema-valid candidates", () => {
  const candidates = buildDeterministicCandidates({
    count: 12,
    startIndex: 5,
    role: { role_title: "Backend Engineer", key_skills: ["Go", "Kafka"] },
  });
  assert.equal(candidates.length, 12);
  for (const candidate of candidates) {
    assert.deepEqual(validateCandidate(candidate), [], `invalid: ${JSON.stringify(candidate)}`);
  }
});

test("deterministic candidates are distinct and carry non-empty skills", () => {
  const candidates = buildDeterministicCandidates({
    count: 8,
    startIndex: 1,
    role: { role_title: "X", key_skills: ["Rust", "WASM"] },
  });
  assert.equal(new Set(candidates.map((c) => c.email)).size, 8);
  assert.ok(candidates.every((c) => c.top_skills.length > 0));
});

test("buildDeterministicPost returns an object with every required post field", () => {
  const post = buildDeterministicPost();
  for (const field of postSchema.required) {
    assert.ok(Object.hasOwn(post, field), `missing post field '${field}'`);
  }
  assert.ok(Array.isArray(post.key_skills) && post.key_skills.length > 0);
});
