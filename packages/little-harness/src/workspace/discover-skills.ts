import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { skill } from "../skills/skill.js";
import type { SkillInput } from "../types.js";
import { importDefault } from "./module-loader.js";

const SKILL_MODULE_NAMES = ["skill.ts", "skill.mts", "skill.js", "skill.mjs"];

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function findSkillModule(dir: string): Promise<string | undefined> {
  for (const name of SKILL_MODULE_NAMES) {
    const candidate = join(dir, name);
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Discover an agent folder's skills from `<agentDir>/skills/*\/`. For each subdirectory: a `skill.ts`
 * (default-exporting a `SkillInput`) wins and is used directly (covers remote/GitHub + local-with-options);
 * otherwise a bare `SKILL.md` becomes a local `skill(<dir>)`. Returns `[]` when there is no `skills/` dir.
 */
export async function discoverSkills(agentDir: string): Promise<SkillInput[]> {
  const skillsDir = join(agentDir, "skills");
  let entries: Dirent[];
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: SkillInput[] = [];
  const subdirs = entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of subdirs) {
    const dir = join(skillsDir, entry.name);
    const skillModule = await findSkillModule(dir);
    if (skillModule !== undefined) {
      skills.push(await importDefault<SkillInput>(skillModule));
    } else if (await exists(join(dir, "SKILL.md"))) {
      skills.push(skill(dir));
    }
  }
  return skills;
}
