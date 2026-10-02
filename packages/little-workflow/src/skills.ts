import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveSkills as rawResolveHarnessSkills,
  type SkillInput,
} from "little-harness";
import { sha256Digest } from "./canonical.js";
import type { SkillDescriptor } from "./harness/types.js";

type ResolvedSkillSource = {
  readonly absoluteSource: string;
  readonly bodyPath: string;
  readonly sourceType: "directory" | "file";
  readonly auxFiles?: readonly string[];
};

type Frontmatter = {
  readonly name: string;
  readonly description: string;
  readonly model?: string;
  readonly allowedTools?: readonly string[];
  readonly frontmatterHash: string;
};

type WorkflowOverrideWarning = {
  readonly code: "workflow_overrides_org_skill";
  readonly name: string;
  readonly message: string;
};

export type WorkflowSkillWarning = {
  readonly code: "policy_warning";
  readonly message: string;
  readonly metadata?: Record<string, unknown>;
};

const WORKFLOW_SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const WINDOWS_RESERVED_SKILL_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

export type RemoteSkillIdentity = {
  readonly normalizedSource: string;
  readonly commitSha: string;
  readonly selectedSkill: string;
  readonly skillPath: string;
  readonly sourceSubpath?: string;
  readonly contentHash?: string;
};

export type Skill = {
  readonly kind: "skill";
  readonly source: string;
  readonly name?: string;
  readonly frontmatterHash?: string;
  readonly remote?: RemoteSkillIdentity;
} & RemoteSkillOptions;

export type SkillRiskLevel = "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type SkillOidcToken =
  | string
  | undefined
  | (() => string | undefined | Promise<string | undefined>);

export type SkillGitAuth = {
  readonly type: "bearer";
  readonly token: string | undefined;
};

export type RemoteSkillOptions = {
  readonly skills?: readonly string[];
  readonly skillMaxRisk?: SkillRiskLevel;
  readonly skillRisk?: Record<string, SkillRiskLevel>;
  readonly auth?: SkillGitAuth;
};

type HarnessSkillInput = {
  readonly source: string;
} & RemoteSkillOptions;

type HarnessResolvedSkill = {
  readonly name: string;
  readonly description: string;
  readonly harnessDir: string;
  readonly files: Record<string, Uint8Array>;
  readonly source?: {
    readonly type: "remote-git";
    readonly original: string;
    readonly cloneUrl: string;
    readonly provider: string;
    readonly host?: string;
    readonly ownerRepo?: string;
    readonly ref?: string;
    readonly subpath?: string;
    readonly commitSha: string;
    readonly selectedSkill: string;
    readonly skillPath: string;
    readonly contentHash?: string;
  };
};

type HarnessSkillsWithWarningsResolver = (
  inputs: readonly HarnessSkillInput[],
  options?: { readonly skillMaxRisk?: SkillRiskLevel; readonly skillOidcToken?: SkillOidcToken },
) => Promise<{ readonly skills: readonly HarnessResolvedSkill[]; readonly warnings: readonly WorkflowSkillWarning[] }>;

export type ResolveSkillsOptions = {
  readonly baseDir: string;
  readonly orgSkillDir?: string;
  readonly skillsCacheDir?: string;
  /**
   * Directory names (relative, e.g. ".agents/skills") to auto-discover skills
   * from, walking up from baseDir to the git/filesystem root. The shared
   * cross-harness convention (pi, opencode, …) is ".agents/skills". Discovered
   * skills are the lowest precedence — explicit workflow + org skills override
   * them by name. Off unless provided.
   */
  readonly discoverDirs?: readonly string[];
  readonly signal?: AbortSignal;
  readonly skillMaxRisk?: SkillRiskLevel;
  readonly skillOidcToken?: SkillOidcToken;
};

export type ResolvedSkillDescriptor = SkillDescriptor & {
  readonly source: string;
  readonly backingPath?: string;
  readonly sourceType: "directory" | "file";
  readonly origin: "workflow" | "org" | "discovered";
  readonly frontmatterHash: string;
  readonly mountPath: string;
  readonly remote?: RemoteSkillIdentity;
  readonly warnings?: readonly WorkflowOverrideWarning[];
};

export type ResolveSkillsWithWarningsResult = {
  readonly skills: readonly ResolvedSkillDescriptor[];
  readonly warnings: readonly WorkflowSkillWarning[];
};

export function skill(pathOrUrl: string, options?: RemoteSkillOptions): Skill {
  return {
    kind: "skill",
    source: pathOrUrl,
    ...options,
  };
}

export async function resolveSkills(
  skills: readonly Skill[],
  options: ResolveSkillsOptions,
): Promise<readonly ResolvedSkillDescriptor[]> {
  return (await resolveSkillsInternal(skills, options, false)).skills;
}

export async function resolveSkillsWithWarnings(
  skills: readonly Skill[],
  options: ResolveSkillsOptions,
): Promise<ResolveSkillsWithWarningsResult> {
  return resolveSkillsInternal(skills, options, true);
}

export async function resolveHarnessSkillInputs(
  inputs: readonly SkillInput[],
  options: ResolveSkillsOptions,
): Promise<readonly ResolvedSkillDescriptor[]> {
  const resolved = await resolveSharedHarnessSkills(inputs as readonly HarnessSkillInput[], {
    ...(options.skillMaxRisk === undefined ? {} : { skillMaxRisk: options.skillMaxRisk }),
    ...(options.skillOidcToken === undefined ? {} : { skillOidcToken: options.skillOidcToken }),
  });
  return Promise.all(resolved.map((skill) => resolvedHarnessSkillDescriptor("mcp-gateway", skill, options)));
}

async function resolveSkillsInternal(
  skills: readonly Skill[],
  options: ResolveSkillsOptions,
  softFailRemote: boolean,
): Promise<ResolveSkillsWithWarningsResult> {
  const workflowResults = await Promise.all(
    skills.map((entry) => resolveWorkflowSkillWithWarnings(entry, options, softFailRemote)),
  );
  const warnings = workflowResults.flatMap((entry) => entry.warnings);
  const workflowSkills = workflowResults.map((entry) => entry.skills);
  const flatWorkflowSkills = workflowSkills.flat();
  ensureUniqueNames(flatWorkflowSkills, "workflow-declared skills");

  const orgSkills = await resolveOrgSkills(options);
  ensureUniqueNames(orgSkills, "org-mounted skills");

  const discoveredSkills = await discoverAgentSkills(options);

  const workflowNames = new Set(flatWorkflowSkills.map((entry) => entry.name));
  const orgByName = new Map(orgSkills.map((entry) => [entry.name, entry]));

  const mergedWorkflow = flatWorkflowSkills.map((entry) => {
    const orgSkill = orgByName.get(entry.name);
    if (orgSkill === undefined) {
      return entry;
    }
    return {
      ...entry,
      warnings: [
        {
          code: "workflow_overrides_org_skill",
          name: entry.name,
          message: `Skill '${entry.name}' from workflow overrides org-level skill of same name.`,
        },
      ],
    } satisfies ResolvedSkillDescriptor;
  });

  const orgNames = new Set(orgSkills.map((entry) => entry.name));
  const merged = [
    ...mergedWorkflow,
    ...orgSkills.filter((entry) => !workflowNames.has(entry.name)),
    // discovered skills fill in only where neither a workflow nor org skill claims the name
    ...discoveredSkills.filter((entry) => !workflowNames.has(entry.name) && !orgNames.has(entry.name)),
  ];
  return { skills: merged, warnings };
}

export function skillsHash(skills: readonly SkillDescriptor[]): string {
  return sha256Digest(
    [...skills]
      .map(skillIdentity)
      .sort((left, right) =>
        compareStrings(left.name, right.name) ||
        compareStrings(left.frontmatterHash, right.frontmatterHash) ||
        compareStrings(remoteSkillIdentityKey(left.remote), remoteSkillIdentityKey(right.remote))
      ),
  );
}

function escapeXml(value: string): string {
  return value.replace(/[&<>]/gu, (char) => (char === "&" ? "&amp;" : char === "<" ? "&lt;" : "&gt;"));
}

/** The command that loads a skill's instructions, by on-disk shape. */
function skillReadPath(entry: SkillDescriptor): string {
  return entry.sourceType === "file"
    ? `.agents/skills/${entry.name}/SKILL.md`
    : `.agents/skills/${entry.name}/SKILL.md`;
}

export function skillPromptSection(skills: readonly SkillDescriptor[]): string | undefined {
  if (skills.length === 0) {
    return undefined;
  }
  const lines = [
    "Skills are specialized instructions for specific tasks. When a task matches a skill's description, read that skill before acting and follow it. A skill lives in its own directory under .agents/skills/ — resolve any relative paths it mentions (e.g. references/, scripts/) against that directory.",
    "",
    "<available_skills>",
  ];
  for (const entry of skills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(entry.name)}</name>`);
    lines.push(`    <description>${escapeXml(entry.description)}</description>`);
    lines.push(`    <read>cat ${skillReadPath(entry)}</read>`);
    const aux = Array.isArray(entry.auxFiles) ? entry.auxFiles : [];
    if (aux.length > 0) {
      lines.push(`    <bundled_files>${aux.length} more file(s) — list with: ls -R .agents/skills/${escapeXml(entry.name)}/</bundled_files>`);
    }
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

async function resolveOrgSkills(options: ResolveSkillsOptions): Promise<readonly ResolvedSkillDescriptor[]> {
  if (options.orgSkillDir === undefined) {
    return [];
  }

  const absoluteOrgDir = resolvePathSource(options.orgSkillDir, options.baseDir);
  const dirStats = await safeStat(absoluteOrgDir);
  if (dirStats?.isDirectory() !== true) {
    return [];
  }

  const entries = (await readdir(absoluteOrgDir, { withFileTypes: true }))
    .filter((entry) => !entry.name.startsWith("."))
    .sort((left, right) => compareStrings(left.name, right.name));
  const skills: ResolvedSkillDescriptor[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      skills.push(await resolveSkillDescriptor(join(absoluteOrgDir, entry.name), "org"));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      skills.push(await resolveSkillDescriptor(join(absoluteOrgDir, entry.name), "org"));
    }
  }
  return skills;
}

async function resolveWorkflowSkill(
  entry: Skill,
  options: ResolveSkillsOptions,
): Promise<readonly ResolvedSkillDescriptor[]> {
  const resolved = await isRemoteWorkflowSkillSource(entry.source, options.baseDir)
    ? await resolveRemoteGitSkills(entry, options)
    : [await resolveSkillDescriptor(resolvePathSource(entry.source, options.baseDir), "workflow")];
  for (const descriptor of resolved) {
    assertSkillIdentityPin(entry, descriptor);
  }
  return resolved;
}

async function resolveWorkflowSkillWithWarnings(
  entry: Skill,
  options: ResolveSkillsOptions,
  softFailRemote: boolean,
): Promise<ResolveSkillsWithWarningsResult> {
  if (!softFailRemote || !(await isRemoteWorkflowSkillSource(entry.source, options.baseDir))) {
    return { skills: await resolveWorkflowSkill(entry, options), warnings: [] };
  }
  const resolved = await resolveRemoteGitSkillsWithWarnings(entry, options);
  for (const descriptor of resolved.skills) {
    assertSkillIdentityPin(entry, descriptor);
  }
  return resolved;
}

async function resolveRemoteGitSkills(
  entry: Skill,
  options: ResolveSkillsOptions,
): Promise<readonly ResolvedSkillDescriptor[]> {
  const harnessInput: HarnessSkillInput = {
    source: entry.source,
    ...(entry.skills === undefined ? {} : { skills: entry.skills }),
    ...(entry.skillMaxRisk === undefined ? {} : { skillMaxRisk: entry.skillMaxRisk }),
    ...(entry.skillRisk === undefined ? {} : { skillRisk: entry.skillRisk }),
    ...(entry.auth === undefined ? {} : { auth: entry.auth }),
  };
  const resolved = await resolveSharedHarnessSkills([harnessInput], {
    ...(options.skillMaxRisk === undefined ? {} : { skillMaxRisk: options.skillMaxRisk }),
    ...(options.skillOidcToken === undefined ? {} : { skillOidcToken: options.skillOidcToken }),
  });
  return Promise.all(resolved.map((skill) => resolvedHarnessSkillDescriptor(entry.source, skill, options)));
}

async function resolveRemoteGitSkillsWithWarnings(
  entry: Skill,
  options: ResolveSkillsOptions,
): Promise<ResolveSkillsWithWarningsResult> {
  const harnessInput: HarnessSkillInput = {
    source: entry.source,
    ...(entry.skills === undefined ? {} : { skills: entry.skills }),
    ...(entry.skillMaxRisk === undefined ? {} : { skillMaxRisk: entry.skillMaxRisk }),
    ...(entry.skillRisk === undefined ? {} : { skillRisk: entry.skillRisk }),
    ...(entry.auth === undefined ? {} : { auth: entry.auth }),
  };
  const resolved = await resolveSharedHarnessSkillsWithWarnings([harnessInput], {
    ...(options.skillMaxRisk === undefined ? {} : { skillMaxRisk: options.skillMaxRisk }),
    ...(options.skillOidcToken === undefined ? {} : { skillOidcToken: options.skillOidcToken }),
  });
  return {
    skills: await Promise.all(resolved.skills.map((skill) => resolvedHarnessSkillDescriptor(entry.source, skill, options))),
    warnings: resolved.warnings,
  };
}

async function resolveSharedHarnessSkills(
  inputs: readonly HarnessSkillInput[],
  options: { readonly skillMaxRisk?: SkillRiskLevel; readonly skillOidcToken?: SkillOidcToken },
): Promise<readonly HarnessResolvedSkill[]> {
  const resolver = rawResolveHarnessSkills as unknown as (
    inputs: readonly HarnessSkillInput[],
    options?: { readonly skillMaxRisk?: SkillRiskLevel; readonly skillOidcToken?: SkillOidcToken },
  ) => Promise<readonly HarnessResolvedSkill[]>;
  try {
    return await resolver(inputs, options);
  } catch (error) {
    if (!isStaleHarnessResolverError(error)) {
      throw error;
    }
    const sourceResolver = await importSharedHarnessSourceResolver();
    return sourceResolver(inputs, options);
  }
}

async function resolveSharedHarnessSkillsWithWarnings(
  inputs: readonly HarnessSkillInput[],
  options: { readonly skillMaxRisk?: SkillRiskLevel; readonly skillOidcToken?: SkillOidcToken },
): Promise<{ readonly skills: readonly HarnessResolvedSkill[]; readonly warnings: readonly WorkflowSkillWarning[] }> {
  const resolver =
    await importSharedHarnessSourceResolverWithWarnings().catch(async () => {
      const packageResolver = await importSharedHarnessPackageResolverWithWarnings();
      if (packageResolver === undefined) {
        throw new Error("little-harness does not export resolveSkillsWithWarnings.");
      }
      return packageResolver;
    });
  const result = await resolver(inputs, options);
  return {
    skills: result.skills,
    warnings: result.warnings.map(workflowSkillWarningFromHarness),
  };
}

function isStaleHarnessResolverError(error: unknown): boolean {
  return error instanceof Error && /Directory skills require path/u.test(error.message);
}

async function importSharedHarnessSourceResolver(): Promise<(
  inputs: readonly HarnessSkillInput[],
  options?: { readonly skillMaxRisk?: SkillRiskLevel; readonly skillOidcToken?: SkillOidcToken },
) => Promise<readonly HarnessResolvedSkill[]>> {
  const moduleUrl = new URL("../../little-harness/src/skills/skill.js", import.meta.url).href;
  const module = await import(/* @vite-ignore */ moduleUrl) as { readonly resolveSkills: unknown };
  return module.resolveSkills as (
    inputs: readonly HarnessSkillInput[],
    options?: { readonly skillMaxRisk?: SkillRiskLevel; readonly skillOidcToken?: SkillOidcToken },
  ) => Promise<readonly HarnessResolvedSkill[]>;
}

async function importSharedHarnessPackageResolverWithWarnings(): Promise<HarnessSkillsWithWarningsResolver | undefined> {
  const module = await import("little-harness") as { readonly resolveSkillsWithWarnings?: unknown };
  if (typeof module.resolveSkillsWithWarnings !== "function") {
    return undefined;
  }
  return module.resolveSkillsWithWarnings as HarnessSkillsWithWarningsResolver;
}

async function importSharedHarnessSourceResolverWithWarnings(): Promise<HarnessSkillsWithWarningsResolver> {
  const moduleUrl = new URL("../../little-harness/src/skills/skill.js", import.meta.url).href;
  const module = await import(/* @vite-ignore */ moduleUrl) as { readonly resolveSkillsWithWarnings: unknown };
  return module.resolveSkillsWithWarnings as HarnessSkillsWithWarningsResolver;
}

async function resolvedHarnessSkillDescriptor(
  source: string,
  skill: HarnessResolvedSkill,
  options: ResolveSkillsOptions,
): Promise<ResolvedSkillDescriptor> {
  const cacheRoot = options.skillsCacheDir ?? join(options.baseDir, "skills-cache");
  const skillParent = join(cacheRoot, "remote-git", remoteSkillCacheKey(source), skill.name);
  await mkdir(skillParent, { recursive: true });
  const skillRoot = await mkdtemp(join(skillParent, "resolved-"));
  const auxFiles: string[] = [];
  for (const [relativePath, contents] of Object.entries(skill.files)) {
    const filePath = join(skillRoot, relativePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, contents);
    if (relativePath !== "SKILL.md") {
      auxFiles.push(relativePath);
    }
  }
  const bodyPath = join(skillRoot, "SKILL.md");
  const raw = await readFile(bodyPath, "utf8");
  const frontmatter = parseFrontmatter(raw, bodyPath);
  const remote = remoteSkillIdentity(skill.source);
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    bodyPath,
    ...(auxFiles.length === 0 ? {} : { auxFiles: auxFiles.sort(compareStrings) }),
    ...(frontmatter.model === undefined ? {} : { model: frontmatter.model }),
    ...(frontmatter.allowedTools === undefined ? {} : { allowedTools: frontmatter.allowedTools }),
    source: skillRoot,
    backingPath: skillRoot,
    sourceType: "directory",
    origin: "workflow",
    frontmatterHash: frontmatter.frontmatterHash,
    mountPath: `.agents/skills/${frontmatter.name}/`,
    ...(remote === undefined ? {} : { remote }),
  };
}

function remoteSkillIdentity(source: HarnessResolvedSkill["source"]): RemoteSkillIdentity | undefined {
  if (source?.type !== "remote-git") {
    return undefined;
  }
  return {
    normalizedSource: source.cloneUrl,
    commitSha: source.commitSha,
    selectedSkill: source.selectedSkill,
    skillPath: source.skillPath,
    ...(source.subpath === undefined ? {} : { sourceSubpath: source.subpath }),
    ...(source.contentHash === undefined ? {} : { contentHash: source.contentHash }),
  };
}

function workflowSkillWarningFromHarness(warning: unknown): WorkflowSkillWarning {
  if (typeof warning !== "object" || warning === null) {
    return {
      code: "policy_warning",
      message: String(warning),
    };
  }
  const record = warning as Record<string, unknown>;
  const metadata = typeof record.metadata === "object" && record.metadata !== null
    ? record.metadata as Record<string, unknown>
    : undefined;
  return {
    code: "policy_warning",
    message: typeof record.message === "string" ? record.message : "Remote skill source was skipped.",
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function remoteSkillCacheKey(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function assertSkillIdentityPin(
  declared: Skill,
  resolved: { readonly name: string; readonly frontmatterHash: string },
): void {
  if (declared.name !== undefined && declared.name !== resolved.name) {
    throw new Error(
      `resolveSkills: skill '${declared.source}' expected name '${declared.name}' but resolved '${resolved.name}'.`,
    );
  }
  if (
    declared.frontmatterHash !== undefined &&
    declared.frontmatterHash !== resolved.frontmatterHash
  ) {
    throw new Error(
      `resolveSkills: skill '${declared.source}' expected frontmatterHash '${declared.frontmatterHash}' but resolved '${resolved.frontmatterHash}'.`,
    );
  }
}

/**
 * Auto-discover directory/single-file skills from `discoverDirs` (e.g.
 * ".agents/skills") by walking up from baseDir to the git/filesystem root. The
 * nearest ancestor wins on a name clash; invalid non-skill entries are skipped
 * (lenient, since the dirs may hold unrelated files), but unsafe skill names are
 * rejected before they can enter prompts or mount paths. Lowest precedence overall.
 */
async function discoverAgentSkills(options: ResolveSkillsOptions): Promise<readonly ResolvedSkillDescriptor[]> {
  const dirNames = options.discoverDirs;
  if (dirNames === undefined || dirNames.length === 0) {
    return [];
  }
  const found: ResolvedSkillDescriptor[] = [];
  const seen = new Set<string>();
  let current = resolve(options.baseDir);
  for (;;) {
    for (const dirName of dirNames) {
      const dir = join(current, dirName);
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries.sort((left, right) => compareStrings(left.name, right.name))) {
        if (entry.name.startsWith(".")) continue;
        const isFileSkill = entry.isFile() && entry.name.endsWith(".md");
        if (!entry.isDirectory() && !isFileSkill) continue;
        try {
          const descriptor = await resolveSkillDescriptor(join(dir, entry.name), "discovered");
          if (!seen.has(descriptor.name)) {
            seen.add(descriptor.name);
            found.push(descriptor);
          }
        } catch (error) {
          if (isInvalidSkillNameError(error)) {
            throw error;
          }
          // not a valid skill (no SKILL.md / bad frontmatter) — skip it
        }
      }
    }
    const isGitRoot = (await safeStat(join(current, ".git"))) !== undefined;
    const parent = dirname(current);
    if (isGitRoot || parent === current) {
      break;
    }
    current = parent;
  }
  return found;
}

function isInvalidSkillNameError(error: unknown): boolean {
  return error instanceof Error && /Invalid skill name/u.test(error.message);
}

async function resolveSkillDescriptor(
  source: string,
  origin: "workflow" | "org" | "discovered",
): Promise<ResolvedSkillDescriptor> {
  const resolvedSource = await resolveSkillSource(source);
  const raw = await readFile(resolvedSource.bodyPath, "utf8");
  const frontmatter = parseFrontmatter(raw, resolvedSource.bodyPath);
  const mountPath = resolvedSource.sourceType === "directory"
    ? `.agents/skills/${frontmatter.name}/`
    : `.agents/skills/${frontmatter.name}/SKILL.md`;

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    bodyPath: resolvedSource.bodyPath,
    ...(resolvedSource.auxFiles === undefined ? {} : { auxFiles: resolvedSource.auxFiles }),
    ...(frontmatter.model === undefined ? {} : { model: frontmatter.model }),
    ...(frontmatter.allowedTools === undefined ? {} : { allowedTools: frontmatter.allowedTools }),
    source: resolvedSource.absoluteSource,
    backingPath: resolvedSource.absoluteSource,
    sourceType: resolvedSource.sourceType,
    origin,
    frontmatterHash: frontmatter.frontmatterHash,
    mountPath,
  };
}

async function resolveSkillSource(source: string): Promise<ResolvedSkillSource> {
  const sourceStats = await safeStat(source);
  if (sourceStats === undefined) {
    throw new Error(`resolveSkills: skill source '${source}' does not exist.`);
  }

  if (sourceStats.isDirectory()) {
    const bodyPath = join(source, "SKILL.md");
    const bodyStats = await safeStat(bodyPath);
    if (bodyStats?.isFile() !== true) {
      throw new Error(
        `resolveSkills: skill directory '${source}' must contain SKILL.md.`,
      );
    }
    return {
      absoluteSource: source,
      bodyPath,
      sourceType: "directory",
      auxFiles: await collectAuxFiles(source),
    };
  }

  if (sourceStats.isFile()) {
    return {
      absoluteSource: source,
      bodyPath: source,
      sourceType: "file",
    };
  }

  throw new Error(
    `resolveSkills: skill source '${source}' must be a directory or a markdown file.`,
  );
}

async function collectAuxFiles(skillDir: string): Promise<readonly string[]> {
  const files: string[] = [];
  await walk(skillDir, "", files);
  return files.sort(compareStrings);
}

async function walk(root: string, prefix: string, files: string[]): Promise<void> {
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => !(prefix.length === 0 && entry.name === "SKILL.md"))
    .sort((left, right) => compareStrings(left.name, right.name));

  for (const entry of entries) {
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) {
      await walk(absolute, relative, files);
      continue;
    }
    if (entry.isFile()) {
      files.push(relative);
    }
  }
}

function parseFrontmatter(contents: string, bodyPath: string): Frontmatter {
  const rawFrontmatter = leadingFrontmatter(contents);
  if (rawFrontmatter === undefined) {
    throw new Error(
      `resolveSkills: skill '${bodyPath}' must start with YAML frontmatter delimited by --- markers.`,
    );
  }

  const parsed = parseFrontmatterLines(rawFrontmatter);
  const name = requiredString(parsed, "name", bodyPath);
  validateWorkflowSkillName(name, bodyPath);
  const description = requiredString(parsed, "description", bodyPath);
  const model = optionalString(parsed, "model");
  const allowedTools = optionalStringArray(parsed, "allowed-tools");

  return {
    name,
    description,
    ...(model === undefined ? {} : { model }),
    ...(allowedTools === undefined ? {} : { allowedTools }),
    frontmatterHash: sha256Digest({ frontmatter: rawFrontmatter }),
  };
}

function validateWorkflowSkillName(name: string, bodyPath: string): void {
  const trimmed = name.trim();
  if (
    trimmed.length === 0 ||
    trimmed !== name ||
    name.normalize("NFC") !== name ||
    !WORKFLOW_SKILL_NAME_PATTERN.test(name) ||
    name.endsWith(".") ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    WINDOWS_RESERVED_SKILL_NAMES.has(name.split(".")[0]!.toUpperCase())
  ) {
    throw new Error(`Invalid skill name '${name}' in '${bodyPath}'.`);
  }
}

function parseFrontmatterLines(frontmatter: string): Record<string, unknown> {
  const parsed: Record<string, unknown> = {};
  const lines = frontmatter.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trimEnd() ?? "";
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) {
      continue;
    }

    const keyValue = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/u.exec(line);
    if (keyValue === null) {
      continue;
    }
    const key = keyValue[1] ?? "";
    const rawValue = (keyValue[2] ?? "").trim();

    if (rawValue.length > 0) {
      parsed[key] = parseScalar(rawValue);
      continue;
    }

    const listItems: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const next = lines[cursor] ?? "";
      const item = /^\s*-\s*(.+?)\s*$/u.exec(next);
      if (item === null) {
        break;
      }
      listItems.push(String(parseScalar(item[1] ?? "")));
      cursor += 1;
    }
    if (listItems.length > 0) {
      parsed[key] = listItems;
      index = cursor - 1;
      continue;
    }

    parsed[key] = "";
  }
  return parsed;
}

function parseScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function requiredString(
  frontmatter: Record<string, unknown>,
  field: string,
  bodyPath: string,
): string {
  const value = optionalString(frontmatter, field);
  if (value === undefined || value.length === 0) {
    throw new Error(
      `resolveSkills: skill '${bodyPath}' frontmatter must include a non-empty '${field}'.`,
    );
  }
  return value;
}

function optionalString(
  frontmatter: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = frontmatter[field];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function optionalStringArray(
  frontmatter: Record<string, unknown>,
  field: string,
): readonly string[] | undefined {
  const value = frontmatter[field];
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    const parsed = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return parsed.length === 0 ? undefined : parsed;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return [value.trim()];
  }
  return undefined;
}

function leadingFrontmatter(contents: string): string | undefined {
  if (!contents.startsWith("---\n") && !contents.startsWith("---\r\n")) {
    return undefined;
  }

  const newline = contents.startsWith("---\r\n") ? "\r\n" : "\n";
  const start = 3 + newline.length;
  const endMarker = `${newline}---`;
  const end = contents.indexOf(endMarker, start);
  if (end === -1) {
    return undefined;
  }

  return contents.slice(start, end);
}

function skillIdentity(
  skill: SkillDescriptor,
): { readonly name: string; readonly frontmatterHash: string; readonly remote?: RemoteSkillIdentity } {
  const frontmatterHash = propertyValue(skill, "frontmatterHash");
  const remote = remoteSkillIdentityFromValue(propertyValue(skill, "remote"));
  if (typeof frontmatterHash === "string" && frontmatterHash.length > 0) {
    return { name: skill.name, frontmatterHash, ...(remote === undefined ? {} : { remote }) };
  }
  return {
    name: skill.name,
    frontmatterHash: sha256Digest({ name: skill.name, description: skill.description }),
    ...(remote === undefined ? {} : { remote }),
  };
}

export function remoteSkillIdentityFromValue(value: unknown): RemoteSkillIdentity | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const normalizedSource = propertyValue(value, "normalizedSource");
  const commitSha = propertyValue(value, "commitSha");
  const selectedSkill = propertyValue(value, "selectedSkill");
  const skillPath = propertyValue(value, "skillPath");
  if (
    typeof normalizedSource !== "string" ||
    typeof commitSha !== "string" ||
    typeof selectedSkill !== "string" ||
    typeof skillPath !== "string"
  ) {
    return undefined;
  }
  const sourceSubpath = propertyValue(value, "sourceSubpath");
  const contentHash = propertyValue(value, "contentHash");
  return {
    normalizedSource,
    commitSha,
    selectedSkill,
    skillPath,
    ...(typeof sourceSubpath === "string" ? { sourceSubpath } : {}),
    ...(typeof contentHash === "string" ? { contentHash } : {}),
  };
}

export function remoteSkillIdentityKey(remote: RemoteSkillIdentity | undefined): string {
  return remote === undefined
    ? ""
    : [
      remote.normalizedSource,
      remote.commitSha,
      remote.selectedSkill,
      remote.skillPath,
      remote.sourceSubpath ?? "",
      remote.contentHash ?? "",
    ].join("\0");
}

function ensureUniqueNames(
  skills: readonly ResolvedSkillDescriptor[],
  source: string,
): void {
  const seen = new Set<string>();
  for (const entry of skills) {
    if (!seen.has(entry.name)) {
      seen.add(entry.name);
      continue;
    }
    throw new Error(`resolveSkills: Skill name '${entry.name}' declared twice in ${source}.`);
  }
}

function propertyValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}

function resolvePathSource(source: string, baseDir: string): string {
  if (source.startsWith("file://")) {
    return fileURLToPath(source);
  }
  if (isAbsolute(source)) {
    return source;
  }
  return resolve(baseDir, source);
}

function isUrl(source: string): boolean {
  try {
    const url = new URL(source);
    return url.protocol.length > 1 && url.protocol !== "file:";
  } catch {
    return false;
  }
}

async function isRemoteWorkflowSkillSource(source: string, baseDir: string): Promise<boolean> {
  if (isRemoteShorthandSource(source)) {
    return !(await hasLocalSkillSource(resolvePathSource(source, baseDir)));
  }
  return isExplicitRemoteSkillSource(source);
}

function isExplicitRemoteSkillSource(source: string): boolean {
  if (isUrl(source)) {
    return true;
  }
  if (source.startsWith("file://") && source.includes("#")) {
    return true;
  }
  return /^([^@\s]+)@([^:\s]+):(.+)$/u.test(source);
}

function isRemoteShorthandSource(source: string): boolean {
  const [owner, repo, extra] = source.split("/");
  return extra === undefined &&
    owner !== undefined &&
    repo !== undefined &&
    /^[A-Za-z0-9_.-]+$/u.test(owner) &&
    /^[A-Za-z0-9_.-]+$/u.test(repo);
}

async function hasLocalSkillSource(source: string): Promise<boolean> {
  const sourceStats = await safeStat(source);
  if (sourceStats?.isFile() === true) {
    return true;
  }
  if (sourceStats?.isDirectory() !== true) {
    return false;
  }
  const bodyStats = await safeStat(join(source, "SKILL.md"));
  return bodyStats?.isFile() === true;
}

async function safeStat(path: string): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

// ─── skill content capture (for tracing) ─────────────────────────────────────
// The recorded manifest carries only {name, frontmatterHash} per skill, which is
// enough for drift detection but tells a developer nothing about what the model
// was actually given. These helpers read the resolved skills' SKILL.md body and
// bundled files so a session-start event can carry the *content* — what the model
// sees mounted under .agents/skills — for inspection in the trace viewer.

/** One bundled file under a skill mount, with its text (or a size marker when large). */
export type SkillFileContent = {
  readonly path: string;
  readonly bytes: number;
  readonly content?: string;
  /** content omitted because it exceeded the inline cap (binary or large file). */
  readonly elided?: true;
};

/** A skill's inspectable content: identity + SKILL.md body + bundled files. */
export type SkillContent = {
  readonly name: string;
  readonly description: string;
  readonly origin?: string;
  readonly sourceType?: string;
  readonly mountPath?: string;
  readonly frontmatterHash?: string;
  readonly body?: string;
  readonly files: readonly SkillFileContent[];
};

/** Inline cap per skill file — large/binary files are recorded as a marker, not embedded. */
const SKILL_CONTENT_MAX_BYTES = 64 * 1024;

async function readSkillFile(path: string): Promise<{ content?: string; bytes: number }> {
  try {
    const buf = await readFile(path);
    if (buf.byteLength > SKILL_CONTENT_MAX_BYTES) {
      return { bytes: buf.byteLength };
    }
    return { content: buf.toString("utf8"), bytes: buf.byteLength };
  } catch {
    return { bytes: 0 };
  }
}

/**
 * Read the inspectable content of resolved skills: each skill's SKILL.md body and
 * its bundled files (relative to the skill directory). Best-effort and size-capped
 * so it never fails a session nor bloats an event; unreadable files are skipped.
 * Returns [] for an empty skill list.
 */
export async function readSkillContents(
  skills: readonly SkillDescriptor[],
): Promise<readonly SkillContent[]> {
  const out: SkillContent[] = [];
  for (const entry of skills) {
    const bodyPath = typeof entry.bodyPath === "string" ? entry.bodyPath : undefined;
    const body = bodyPath ? await readSkillFile(bodyPath) : { content: undefined, bytes: 0 };
    const baseDir = bodyPath ? dirname(bodyPath) : undefined;
    const auxFiles = Array.isArray(entry.auxFiles) ? entry.auxFiles : [];
    const files: SkillFileContent[] = [];
    for (const rel of auxFiles) {
      if (typeof rel !== "string" || baseDir === undefined) continue;
      const abs = isAbsolute(rel) ? rel : join(baseDir, rel);
      const file = await readSkillFile(abs);
      files.push({
        path: rel,
        bytes: file.bytes,
        ...(file.content === undefined ? { elided: true as const } : { content: file.content }),
      });
    }
    out.push({
      name: entry.name,
      description: entry.description,
      ...(typeof entry.origin === "string" ? { origin: entry.origin } : {}),
      ...(typeof entry.sourceType === "string" ? { sourceType: entry.sourceType } : {}),
      ...(typeof entry.mountPath === "string" ? { mountPath: entry.mountPath } : {}),
      ...(typeof entry.frontmatterHash === "string" ? { frontmatterHash: entry.frontmatterHash } : {}),
      ...(body.content === undefined ? {} : { body: body.content }),
      files,
    });
  }
  return out;
}
