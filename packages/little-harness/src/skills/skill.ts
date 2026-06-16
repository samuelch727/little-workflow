import { access, readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { HarnessInputError } from "../errors.js";
import type {
  LocalSkillInput,
  RemoteSkillInput,
  RemoteSkillOptions,
  ResolvedSkill,
  HarnessWarning,
  SkillOidcToken,
  SkillRiskLevel,
  SkillInput,
} from "../types.js";
import { auditRemoteSkills, type AuditRemoteSkillsOptions } from "./audit.js";
import { discoverRemoteSkills } from "./discover.js";
import {
  materializeRemoteGitSource,
  type MaterializeRemoteGitSourceOptions,
} from "./git-cache.js";
import { parseRemoteSkillSource, type ParsedRemoteSkillSource } from "./remote-source.js";

export function skill(input: string, options?: RemoteSkillOptions): SkillInput;
export function skill(input: Exclude<SkillInput, string>): SkillInput;
export function skill(input: SkillInput | string, options?: RemoteSkillOptions): SkillInput {
  if (typeof input === "string" && options !== undefined) {
    return { source: input, ...options };
  }
  return input;
}

export type ResolveSkillsOptions = {
  skillMaxRisk?: SkillRiskLevel | undefined;
  skillOidcToken?: SkillOidcToken;
};

export type ResolveSkillsWithWarningsResult = {
  skills: ResolvedSkill[];
  warnings: HarnessWarning[];
};

export async function resolveSkills(
  inputs: SkillInput[] = [],
  options: ResolveSkillsOptions = {},
): Promise<ResolvedSkill[]> {
  const out: ResolvedSkill[] = [];
  for (const input of inputs) {
    out.push(...await resolveSkill(input, options));
  }
  return out;
}

export async function resolveSkillsWithWarnings(
  inputs: SkillInput[] = [],
  options: ResolveSkillsOptions = {},
): Promise<ResolveSkillsWithWarningsResult> {
  const skills: ResolvedSkill[] = [];
  const warnings: HarnessWarning[] = [];
  for (const input of inputs) {
    const remote = await remoteSkillInputForSoftFail(input);
    if (remote !== undefined) {
      try {
        skills.push(...await resolveRemoteSkill(remote.input, options, remote.parsed));
      } catch (error) {
        warnings.push(remoteSkillUnavailableWarning(remote.input.source, error));
      }
      continue;
    }
    skills.push(...await resolveSkill(input, options));
  }
  return { skills, warnings };
}

async function resolveSkill(
  input: SkillInput,
  options: ResolveSkillsOptions,
): Promise<ResolvedSkill[]> {
  if (typeof input === "string") {
    if (looksLikeRemoteSkillSource(input) && !(await hasLocalSkillFile(input))) {
      return resolveRemoteSkill({ source: input }, options, parseRemoteSkillSource(input));
    }
    return [await resolveDirectorySkill({ path: input })];
  }

  if ("source" in input) {
    return resolveRemoteSkill(input, options);
  }

  if (input.files) {
    const name = input.name;
    const description = input.description;
    if (!name || !description) {
      throw new HarnessInputError("Inline skills require name and description");
    }

    return [{
      name,
      description,
      harnessDir: input.harnessDir ?? `.agents/skills/${name}`,
      files: encodeFiles(input.files),
    }];
  }

  return [await resolveDirectorySkill(input)];
}

async function resolveRemoteSkill(
  input: RemoteSkillInput,
  defaults: ResolveSkillsOptions,
  parsed = parseRemoteSkillSource(input.source),
): Promise<ResolvedSkill[]> {
  const source = parsed;
  const materializeOptions: MaterializeRemoteGitSourceOptions = {};
  if (input.auth !== undefined) {
    materializeOptions.auth = input.auth;
  }

  const materialized = await materializeRemoteGitSource(source, materializeOptions);
  const discoverOptions: Pick<RemoteSkillOptions, "skills"> & { commitSha: string } = {
    commitSha: materialized.commitSha,
  };
  if (input.skills !== undefined) {
    discoverOptions.skills = input.skills;
  }
  const skills = await discoverRemoteSkills(source, materialized.snapshotDir, discoverOptions);

  const auditOptions: AuditRemoteSkillsOptions = {};
  const skillMaxRisk = input.skillMaxRisk ?? defaults.skillMaxRisk;
  const skillOidcToken = defaults.skillOidcToken;
  if (skillMaxRisk !== undefined) {
    auditOptions.skillMaxRisk = skillMaxRisk;
  }
  if (input.skillRisk !== undefined) {
    auditOptions.skillRisk = input.skillRisk;
  }
  if (skillOidcToken !== undefined) {
    auditOptions.skillOidcToken = skillOidcToken;
  }
  await auditRemoteSkills(source, skills, auditOptions);
  return skills;
}

async function resolveDirectorySkill(input: LocalSkillInput): Promise<ResolvedSkill> {
  if (!input.path) {
    throw new HarnessInputError("Directory skills require path");
  }

  const root = path.resolve(input.path);
  const skillMd = await readFile(path.join(root, "SKILL.md"), "utf8");
  const metadata = parseFrontmatter(skillMd);
  const name = input.name ?? metadata.name;
  const description = input.description ?? metadata.description;

  if (!name || !description) {
    throw new HarnessInputError("Skill metadata requires name and description", { path: root });
  }

  return {
    name,
    description,
    harnessDir: input.harnessDir ?? `.agents/skills/${name}`,
    files: await readTree(root),
  };
}

function parseFrontmatter(markdown: string): { name?: string; description?: string } {
  if (!markdown.startsWith("---\n")) {
    return {};
  }

  const end = markdown.indexOf("\n---", 4);
  if (end === -1) {
    return {};
  }

  const out: { name?: string; description?: string } = {};
  const block = markdown.slice(4, end).split("\n");
  for (const line of block) {
    const match = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }

    const value = match[2]!.replace(/^["']|["']$/g, "");
    if (match[1] === "name") {
      out.name = value;
    }
    if (match[1] === "description") {
      out.description = value;
    }
  }

  return out;
}

async function readTree(root: string, relative = ""): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {};
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries) {
    const next = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) {
      Object.assign(files, await readTree(root, next));
    } else if (entry.isFile()) {
      files[next.split(path.sep).join("/")] = await readFile(path.join(root, next));
    }
  }
  return files;
}

function encodeFiles(files: Record<string, string | Uint8Array>): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) {
    out[name] = typeof content === "string" ? new TextEncoder().encode(content) : content;
  }
  return out;
}

function looksLikeRemoteSkillSource(input: string): boolean {
  const source = input.split("#", 1)[0] ?? input;
  return source.includes("://") ||
    source.startsWith("github:") ||
    source.startsWith("gitlab:") ||
    /^([^@\s]+)@([^:\s]+):(.+)$/u.test(source) ||
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(source);
}

async function hasLocalSkillFile(input: string): Promise<boolean> {
  if (input.includes("://") || input.startsWith("github:") || input.startsWith("gitlab:")) {
    return false;
  }
  try {
    await access(path.join(path.resolve(input), "SKILL.md"));
    return true;
  } catch {
    return false;
  }
}

async function remoteSkillInputForSoftFail(input: SkillInput): Promise<
  { input: RemoteSkillInput; parsed: ParsedRemoteSkillSource } | undefined
> {
  if (typeof input === "string") {
    if (isExplicitLocalPath(input)) {
      return undefined;
    }
    if (!looksLikeRemoteSkillSource(input) || await hasLocalSkillFile(input)) {
      return undefined;
    }
    return { input: { source: input }, parsed: parseRemoteSkillSource(input) };
  }
  if (typeof input === "object" && input !== null && "source" in input) {
    return { input, parsed: parseRemoteSkillSource(input.source) };
  }
  return undefined;
}

function isExplicitLocalPath(input: string): boolean {
  return input.startsWith("./") || input.startsWith("../") || path.isAbsolute(input);
}

function remoteSkillUnavailableWarning(source: string, error: unknown): HarnessWarning {
  return {
    code: "policy_warning",
    message: `Remote skill source was skipped because it could not be loaded: ${source}`,
    metadata: {
      reason: "remote_skill_unavailable",
      source,
      error: errorMessage(error),
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
