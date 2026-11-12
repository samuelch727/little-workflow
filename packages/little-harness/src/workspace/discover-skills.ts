import { skill } from "../skills/skill.js";
import type { SkillInput } from "../types.js";
import { importDefault } from "./module-loader.js";
import { skillPaths } from "./folder-layout.js";

/** Module skills win over bare SKILL.md folders; ordering is shared with compilation. */
export async function discoverSkills(agentDir: string): Promise<SkillInput[]> {
  const skills: SkillInput[] = [];
  for (const found of await skillPaths(agentDir)) {
    skills.push(found.module === undefined ? skill(found.dir) : await importDefault<SkillInput>(found.module));
  }
  return skills;
}
