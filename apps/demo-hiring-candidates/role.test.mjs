import { test } from "node:test";
import assert from "node:assert/strict";
import { isPostOutput, resolveRole } from "./role.mjs";

test("isPostOutput accepts a post object and rejects candidate arrays / non-objects", () => {
  assert.equal(isPostOutput({ role_title: "Backend Engineer" }), true);
  assert.equal(isPostOutput([{ role_title: "x" }]), false); // candidate array
  assert.equal(isPostOutput({ company: "Acme" }), false); // no role_title
  assert.equal(isPostOutput(null), false);
  assert.equal(isPostOutput("nope"), false);
});

test("resolveRole passes through a well-formed post", () => {
  const role = resolveRole({
    role_title: "Senior Backend Engineer",
    company: "Nimbus AI",
    location: "Remote (US)",
    seniority_focus: "Senior",
    role_brief: "ships ledgers",
    key_skills: ["Go", "Kafka"],
    hiring_post_markdown: "# hi",
  });
  assert.equal(role.role_title, "Senior Backend Engineer");
  assert.equal(role.company, "Nimbus AI");
  assert.deepEqual(role.key_skills, ["Go", "Kafka"]);
  assert.equal(role.hiring_post_markdown, "# hi");
});

test("resolveRole fills per-field defaults for a partial post", () => {
  const role = resolveRole({ role_title: "Engineer" });
  assert.equal(role.company, "Unknown Co");
  assert.equal(role.location, "Unknown");
  assert.equal(role.seniority_focus, "Unknown");
  assert.equal(role.role_brief, "Engineer"); // brief → title fallback
  assert.deepEqual(role.key_skills, ["Communication"]); // empty/missing → default
  assert.equal(role.hiring_post_markdown, "");
});

test("resolveRole falls back to a complete default role for malformed input", () => {
  for (const bad of [null, {}, { role_title: "" }, [{ role_title: "x" }], "nope"]) {
    const role = resolveRole(bad);
    assert.ok(typeof role.role_title === "string" && role.role_title.length > 0);
    assert.ok(Array.isArray(role.key_skills) && role.key_skills.length > 0);
    assert.ok(typeof role.hiring_post_markdown === "string");
  }
});
