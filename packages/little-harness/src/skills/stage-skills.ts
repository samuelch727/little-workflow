import { HarnessInputError, HarnessPathError } from "../errors.js";
import { diskStorage, type WorkspaceStorage } from "../files/storage.js";
import type { ResolvedSkill } from "../types.js";

/**
 * Writes the turn's skills under `<sessionRoot>/.agents/skills`, replacing what was there.
 * `sessionRoot` is a session directory on disk, or "/" for a workspace kept in a just-bash
 * filesystem.
 */
export async function stageResolvedSkills(
  sessionRoot: string,
  skills: ResolvedSkill[],
  storage: WorkspaceStorage = diskStorage(),
): Promise<void> {
  const path = storage.path;
  const stagedSkills = resolveStagedSkills(path, sessionRoot, skills);
  await Promise.all([
    // A host directory from before skills moved under .agents; a filesystem workspace never had one.
    ...(storage.kind === "disk" ? [storage.removeTree(path.join(sessionRoot, "skills"))] : []),
    storage.removeTree(path.join(sessionRoot, ".agents", "skills")),
  ]);
  await storage.makeDir(path.join(sessionRoot, ".agents", "skills"));

  for (const { skill, skillRoot } of stagedSkills) {
    for (const [file, content] of Object.entries(skill.files)) {
      await storage.writeFile(resolveSkillFile(path, skillRoot, file), content);
    }
  }
}

function resolveStagedSkills(
  path: WorkspaceStorage["path"],
  sessionRoot: string,
  skills: readonly ResolvedSkill[],
): Array<{ readonly skill: ResolvedSkill; readonly skillRoot: string }> {
  const seenNames = new Map<string, ResolvedSkill>();
  const seenRoots = new Map<string, ResolvedSkill>();
  return skills.map((skill) => {
    const existingName = seenNames.get(skill.name);
    if (existingName !== undefined) {
      throw new HarnessInputError("Skill names must be unique.", {
        name: skill.name,
        firstHarnessDir: existingName.harnessDir,
        duplicateHarnessDir: skill.harnessDir,
      });
    }
    seenNames.set(skill.name, skill);

    const skillRoot = resolveSkillRoot(path, sessionRoot, skill.harnessDir);
    const existingRoot = seenRoots.get(skillRoot);
    if (existingRoot !== undefined) {
      throw new HarnessInputError("Skill harnessDir values must be unique.", {
        harnessDir: skill.harnessDir,
        firstName: existingRoot.name,
        duplicateName: skill.name,
      });
    }
    seenRoots.set(skillRoot, skill);
    return { skill, skillRoot };
  });
}

function resolveSkillRoot(path: WorkspaceStorage["path"], sessionRoot: string, harnessDir: string): string {
  const normalized = path.posix.normalize(harnessDir);
  if (normalized.startsWith(".agents/skills/")) {
    return resolveRelative(path, sessionRoot, normalized, "Skill harnessDir resolves outside .agents/skills");
  }

  throw new HarnessPathError("Skill harnessDir must be inside .agents/skills", { harnessDir });
}

function resolveSkillFile(path: WorkspaceStorage["path"], skillRoot: string, file: string): string {
  if (file.startsWith("/") || file.includes("\0") || file.split(/[\\/]/).includes("..")) {
    throw new HarnessPathError("Skill file paths must be relative", { path: file });
  }

  return resolveRelative(path, skillRoot, file, "Skill file resolves outside its skill directory");
}

function resolveRelative(path: WorkspaceStorage["path"], root: string, relative: string, message: string): string {
  const target = path.resolve(root, relative);
  const rel = path.relative(path.resolve(root), target);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    return target;
  }

  throw new HarnessPathError(message, { path: relative });
}
