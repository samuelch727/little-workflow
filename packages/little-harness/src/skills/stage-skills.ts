import { mkdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { HarnessPathError } from "../errors.js";
import type { ResolvedSkill } from "../types.js";

export async function stageResolvedSkills(
  sessionRoot: string,
  skills: ResolvedSkill[],
): Promise<void> {
  await Promise.all([
    rm(path.join(sessionRoot, "skills"), { recursive: true, force: true }),
    rm(path.join(sessionRoot, ".agents", "skills"), { recursive: true, force: true }),
  ]);
  await mkdir(path.join(sessionRoot, ".agents", "skills"), { recursive: true });

  for (const skill of skills) {
    const skillRoot = resolveSkillRoot(sessionRoot, skill.harnessDir);
    for (const [file, content] of Object.entries(skill.files)) {
      const target = resolveSkillFile(skillRoot, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
  }
}

function resolveSkillRoot(sessionRoot: string, harnessDir: string): string {
  const normalized = path.posix.normalize(harnessDir);
  if (normalized === ".agents/skills" || normalized.startsWith(".agents/skills/")) {
    return resolveRelative(sessionRoot, normalized, "Skill harnessDir resolves outside .agents/skills");
  }

  throw new HarnessPathError("Skill harnessDir must be inside .agents/skills", { harnessDir });
}

function resolveSkillFile(skillRoot: string, file: string): string {
  if (file.startsWith("/") || file.includes("\0") || file.split(/[\\/]/).includes("..")) {
    throw new HarnessPathError("Skill file paths must be relative", { path: file });
  }

  return resolveRelative(skillRoot, file, "Skill file resolves outside its skill directory");
}

function resolveRelative(root: string, relative: string, message: string): string {
  const target = path.resolve(root, relative);
  const rel = path.relative(path.resolve(root), target);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    return target;
  }

  throw new HarnessPathError(message, { path: relative });
}
