/** Portable runtime assembly for generated agent-folder modules. No filesystem or TS loader. */
export { assembleHarness, instantiateHarness, type HarnessDefinition, type CompiledHarnessOptions } from "./workspace/assemble-harness.js";
export { validateDiscoveredWorkflow } from "./workspace/validate-workflow.js";

import type { SkillInput } from "./types.js";
import { HarnessInputError } from "./errors.js";

/** Compiled deployments must not fall back to Node disk/git or silently skip remote skills. */
export function assertBundledSkills(skills: readonly SkillInput[]): void {
  for (const skill of skills) {
    // resolveSkill checks `source` before `files`, including inherited/undefined selectors.
    // Reject that branch outright so mixed inputs cannot bypass offline compilation.
    if (typeof skill !== "object" || skill === null || "source" in skill ||
      typeof skill.name !== "string" || !skill.name.trim() ||
      typeof skill.description !== "string" || !skill.description.trim() ||
      !("files" in skill) || skill.files === null || typeof skill.files !== "object" ||
      Array.isArray(skill.files) || Object.values(skill.files).some(value =>
        typeof value !== "string" && !(value instanceof Uint8Array))) {
      throw new HarnessInputError("Compiled agents require inline skill files. Put local assets in skills/<name>/SKILL.md; skill.ts and configured skills must supply { name, description, files }.");
    }
  }
}
