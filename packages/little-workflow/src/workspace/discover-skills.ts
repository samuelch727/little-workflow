import type { Dirent } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { sha256Digest } from "../canonical.js";
import { skill, type Skill } from "../skills.js";
import { importDefault } from "./module-loader.js";

const SKILL_MODULE_NAMES = ["skill.ts", "skill.mts", "skill.js", "skill.mjs"];

export type DiscoveredSkills = {
  readonly skills: readonly Skill[];
  readonly modulePaths: readonly string[];
  readonly sourcePaths: readonly string[];
  readonly skillDirs: readonly string[];
};

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

export async function discoverSkills(
  workflowDir: string,
  workspaceRoot: string,
): Promise<DiscoveredSkills> {
  const skillsDir = join(workflowDir, "skills");
  let entries: Dirent[];
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return { skills: [], modulePaths: [], sourcePaths: [], skillDirs: [] };
  }

  const skills: Skill[] = [];
  const modulePaths: string[] = [];
  const sourcePaths: string[] = [];
  const skillDirs: string[] = [];
  const subdirs = entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of subdirs) {
    const skillDir = join(skillsDir, entry.name);
    const skillModule = await findSkillModule(skillDir);
    if (skillModule !== undefined) {
      const raw = await importDefault<Skill | string>(skillModule, workspaceRoot);
      const normalized = await normalizeSkillExport(raw, skillDir);
      skills.push(normalized.skill);
      skillDirs.push(skillDir);
      modulePaths.push(skillModule);
      if (normalized.sourcePath !== undefined) sourcePaths.push(normalized.sourcePath);
      continue;
    }

    const markdown = join(skillDir, "SKILL.md");
    if (await exists(markdown)) {
      skills.push(await markdownSkill(skillDir, markdown));
      skillDirs.push(skillDir);
      sourcePaths.push(markdown);
    }
  }

  return { skills, modulePaths, sourcePaths, skillDirs };
}

async function markdownSkill(skillDir: string, markdown: string): Promise<Skill> {
  const contents = await readFile(markdown, "utf8");
  const frontmatter = leadingFrontmatter(contents);
  const name = frontmatter === undefined ? basename(skillDir) : frontmatterName(frontmatter) ?? basename(skillDir);
  return {
    ...skill(skillDir),
    name,
    frontmatterHash: sha256Digest(frontmatter === undefined ? { source: contents } : { frontmatter }),
  };
}

async function normalizeSkillExport(
  value: Skill | string,
  skillDir: string,
): Promise<{ readonly skill: Skill; readonly sourcePath?: string }> {
  const base = typeof value === "string" ? skill(value) : value;
  if (base.kind !== "skill" || typeof base.source !== "string") {
    throw new Error(`Skill module '${skillDir}' must default-export a Workflow Skill or source string.`);
  }

  const source = normalizeSkillSource(base.source, skillDir);
  const normalized: Skill = { ...base, source };
  if (isRemoteSource(source)) {
    if (normalized.name === undefined || normalized.frontmatterHash === undefined) {
      throw new Error(
        `Skill module '${skillDir}' uses remote/unreadable source '${source}' and must provide name and frontmatterHash.`,
      );
    }
    return { skill: normalized };
  }

  const sourcePath = await readableSkillSourcePath(source);
  if (sourcePath === undefined) {
    if (normalized.name === undefined || normalized.frontmatterHash === undefined) {
      throw new Error(
        `Skill module '${skillDir}' source '${source}' is unreadable and must provide name and frontmatterHash.`,
      );
    }
    return { skill: normalized };
  }

  if (normalized.name !== undefined && normalized.frontmatterHash !== undefined) {
    return { skill: normalized, sourcePath };
  }

  const contents = await readFile(sourcePath, "utf8");
  return {
    skill: {
      ...normalized,
      name: normalized.name ?? synthesizedSkillName(skillDir, sourcePath),
      frontmatterHash: normalized.frontmatterHash ?? sha256Digest({ source: contents }),
    },
    sourcePath,
  };
}

function normalizeSkillSource(source: string, skillDir: string): string {
  if (isRemoteSource(source) || isAbsolute(source)) return source;
  return resolve(skillDir, source);
}

async function readableSkillSourcePath(source: string): Promise<string | undefined> {
  try {
    const stats = await stat(source);
    return stats.isDirectory() ? join(source, "SKILL.md") : source;
  } catch {
    return undefined;
  }
}

function synthesizedSkillName(skillDir: string, sourcePath: string): string {
  const stem = basename(sourcePath, extname(sourcePath));
  return stem === "SKILL" || stem === "skill-body" ? basename(skillDir) : basename(skillDir) || stem;
}

function isRemoteSource(source: string): boolean {
  try {
    const url = new URL(source);
    return url.protocol !== "file:";
  } catch {
    return false;
  }
}

function leadingFrontmatter(contents: string): string | undefined {
  if (!contents.startsWith("---\n") && !contents.startsWith("---\r\n")) {
    return undefined;
  }
  const newline = contents.startsWith("---\r\n") ? "\r\n" : "\n";
  const start = 3 + newline.length;
  const end = contents.indexOf(`${newline}---`, start);
  return end === -1 ? undefined : contents.slice(start, end);
}

function frontmatterName(frontmatter: string): string | undefined {
  for (const line of frontmatter.split(/\r?\n/u)) {
    const match = /^name:\s*(.+?)\s*$/u.exec(line);
    if (match === null) continue;
    const name = (match[1] ?? "").replace(/^["']|["']$/gu, "").trim();
    return name.length === 0 ? undefined : name;
  }
  return undefined;
}
