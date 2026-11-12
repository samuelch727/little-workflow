import { expect, it } from "vitest";
import { assertBundledSkills } from "./compiled.js";
import type { SkillInput } from "./types.js";

it.each([
  { name: "", description: "guide", files: { "SKILL.md": "hello" } },
  { name: "guide", description: null, files: { "SKILL.md": "hello" } },
  { name: "guide", description: "guide", source: "github:owner/repo", files: { "SKILL.md": "hello" } },
  { name: "guide", description: "guide", source: undefined, files: { "SKILL.md": "hello" } },
  { name: "guide", description: "guide", files: null },
  { name: "guide", description: "guide", files: [] },
  { name: "guide", description: "guide", files: "not-a-record" },
  { name: "guide", description: "guide", files: { "SKILL.md": null } },
])("refuses non-inline or malformed compiled skill %# before runtime resolution", skill => {
  expect(() => assertBundledSkills([skill as unknown as SkillInput])).toThrow(/inline skill files/);
});
it("accepts inline text and byte assets, including empty files", () => {
  expect(() => assertBundledSkills([{ name: "guide", description: "guide", files: {
    "SKILL.md": "", "asset.bin": new Uint8Array([0, 255]),
  } }])).not.toThrow();
});
it("rejects inherited source selectors too, matching runtime source precedence", () => {
  const skill = Object.assign(Object.create({ source: "github:owner/repo" }), {
    name: "guide", description: "guide", files: { "SKILL.md": "hello" },
  });
  expect(() => assertBundledSkills([skill])).toThrow(/inline skill files/);
});
