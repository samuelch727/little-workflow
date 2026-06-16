import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSkills, resolveSkillsWithWarnings, skill, skillPromptSection, skillsHash } from "./skills.js";

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function skillMarkdown(frontmatter: string, body = "Use this skill."): string {
  return `---\n${frontmatter.trim()}\n---\n\n${body}\n`;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd });
  return stdout.trim();
}

async function initRepo(repoDir: string): Promise<void> {
  await mkdir(repoDir, { recursive: true });
  await git(repoDir, ["init", "-b", "main"]);
  await git(repoDir, ["config", "user.name", "Little Workflow Tests"]);
  await git(repoDir, ["config", "user.email", "tests@example.com"]);
}

async function commitAll(repoDir: string, message: string): Promise<string> {
  await git(repoDir, ["add", "."]);
  await git(repoDir, ["commit", "-m", message]);
  return git(repoDir, ["rev-parse", "HEAD"]);
}

async function writeRepoSkill(repoDir: string, name: string, description: string, body = "Use this skill."): Promise<void> {
  const skillDir = join(repoDir, "skills", name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    skillMarkdown(`\nname: ${name}\ndescription: ${description}\n`, body),
    "utf8",
  );
}

function harnessSnapshotPath(cacheDir: string, cloneUrl: string, commitSha: string): string {
  const normalizedIdentity = normalizedHarnessRemoteIdentity(cloneUrl);
  return join(cacheDir, "snapshots", shortHash(normalizedIdentity), "public", "root", commitSha);
}

function normalizedHarnessRemoteIdentity(cloneUrl: string): string {
  try {
    const url = new URL(cloneUrl);
    url.username = "";
    url.password = "";
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.toLowerCase();
    return url.toString();
  } catch {
    return cloneUrl.replace(/^[^@\s]+@/u, "git@");
  }
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

async function expectRemoteRejectionWithoutLeak(
  action: () => Promise<unknown>,
  expectedMessage: RegExp,
  forbidden: RegExp,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(expectedMessage);
    expect(JSON.stringify(error)).not.toMatch(forbidden);
    return;
  }
  throw new Error("Expected remote skill resolution to reject.");
}

describe("resolveSkills", () => {
  it("resolves directory-form skills and lists auxiliary files", async () => {
    const baseDir = await tempDir("little-workflow-skills-directory-");
    const skillDir = join(baseDir, "skills", "writing-loop-lwir");
    await mkdir(join(skillDir, "examples"), { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      skillMarkdown(
        `
name: writing-loop-lwir
description: Design back-edge loops for iterative refinement.
model: reasoning
allowed-tools:
  - bash
  - validate_lwir
`,
      ),
      "utf8",
    );
    await writeFile(join(skillDir, "anti-patterns.md"), "# Anti-patterns\n", "utf8");
    await writeFile(join(skillDir, "examples", "candidate-review.json"), "{}", "utf8");

    const [resolved] = await resolveSkills([skill("./skills/writing-loop-lwir")], { baseDir });

    expect(resolved).toMatchObject({
      name: "writing-loop-lwir",
      description: "Design back-edge loops for iterative refinement.",
      bodyPath: join(skillDir, "SKILL.md"),
      auxFiles: ["anti-patterns.md", "examples/candidate-review.json"],
      model: "reasoning",
      allowedTools: ["bash", "validate_lwir"],
      mountPath: ".agents/skills/writing-loop-lwir/",
      origin: "workflow",
      sourceType: "directory",
    });
    expect(resolved?.frontmatterHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("resolves existing two-segment local skill directories in warning mode", async () => {
    const baseDir = await tempDir("little-workflow-skills-two-segment-local-");
    const skillDir = join(baseDir, "docs", "foo");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      skillMarkdown(`
name: foo
description: Local docs foo.
`),
      "utf8",
    );

    const result = await resolveSkillsWithWarnings([skill("docs/foo")], { baseDir });

    expect(result.warnings).toEqual([]);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toMatchObject({
      name: "foo",
      description: "Local docs foo.",
      bodyPath: join(skillDir, "SKILL.md"),
      mountPath: ".agents/skills/foo/",
      origin: "workflow",
      sourceType: "directory",
    });
  });

  it("resolves single-file shorthand skills", async () => {
    const baseDir = await tempDir("little-workflow-skills-file-");
    const filePath = join(baseDir, "skills", "output-schema-validation.md");
    await mkdir(join(baseDir, "skills"), { recursive: true });
    await writeFile(
      filePath,
      skillMarkdown(
        `
name: output-schema-validation
description: Validate ai.generate output against declared schemas.
`,
      ),
      "utf8",
    );

    const [resolved] = await resolveSkills([skill("./skills/output-schema-validation.md")], { baseDir });

    expect(resolved).toMatchObject({
      name: "output-schema-validation",
      description: "Validate ai.generate output against declared schemas.",
      bodyPath: filePath,
      mountPath: ".agents/skills/output-schema-validation/SKILL.md",
      origin: "workflow",
      sourceType: "file",
    });
    expect(resolved?.auxFiles).toBeUndefined();
  });

  it("resolves remote Git skills through the harness resolver and selected names", async () => {
    const baseDir = await tempDir("little-workflow-skills-remote-git-");
    const repoDir = join(baseDir, "repo");
    await initRepo(repoDir);
    await writeRepoSkill(repoDir, "foo", "Foo skill.");
    await writeRepoSkill(repoDir, "bar", "Bar skill.");
    const sha = await commitAll(repoDir, "add remote skills");

    const resolved = await resolveSkills([
      skill(`${pathToFileURL(repoDir).href}#${sha}`, { skills: ["foo"] }),
    ], { baseDir });
    const section = skillPromptSection(resolved);

    expect(resolved.map((entry) => entry.name)).toEqual(["foo"]);
    expect(resolved[0]).toMatchObject({
      name: "foo",
      description: "Foo skill.",
      mountPath: ".agents/skills/foo/",
      origin: "workflow",
      sourceType: "directory",
    });
    expect(resolved[0]?.source).toContain("skills-cache");
    expect(resolved[0]?.remote?.normalizedSource).toBe(pathToFileURL(repoDir).href);
    expect(resolved[0]?.frontmatterHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(section).toContain("<read>cat .agents/skills/foo/SKILL.md</read>");
    expect(section).not.toContain("/mnt/skills");
  });

  it("recognizes scp-style Git URLs as remote skill sources", async () => {
    const baseDir = await tempDir("little-workflow-skills-scp-remote-");
    const remote = "git@localhost:group/project.git";

    await expect(resolveSkills([
      skill(remote, { skills: ["scp-skill"] }),
    ], { baseDir })).rejects.toThrow(/Failed to resolve remote skill ref/u);
  });

  it("soft-fails unavailable remote Git skills without adding them to the skills hash", async () => {
    const baseDir = await tempDir("little-workflow-skills-remote-soft-fail-");
    const remote = `${pathToFileURL(join(baseDir, "missing-repo")).href}#${"a".repeat(40)}`;

    const result = await resolveSkillsWithWarnings([
      skill(remote, { skills: ["missing"] }),
    ], { baseDir });

    expect(result.skills).toEqual([]);
    expect(skillsHash(result.skills)).toBe(skillsHash([]));
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "policy_warning",
        metadata: expect.objectContaining({
          reason: "remote_skill_unavailable",
          source: remote,
        }),
      }),
    ]);
  });

  it("rejects invalid remote sources in warning mode", async () => {
    const baseDir = await tempDir("little-workflow-skills-invalid-remote-");

    await expect(resolveSkillsWithWarnings([skill("github:org/repo")], { baseDir }))
      .rejects.toThrow(/explicit Git URL/u);
    await expect(resolveSkillsWithWarnings([skill("org/repo")], { baseDir }))
      .rejects.toThrow(/explicit Git URL/u);
  });

  it("rejects unsafe remote URLs in warning mode without leaking secrets", async () => {
    const baseDir = await tempDir("little-workflow-skills-unsafe-remote-");

    await expectRemoteRejectionWithoutLeak(
      () => resolveSkillsWithWarnings([skill("https://secret-token@example.com/org/repo.git")], { baseDir }),
      /must not include credentials/u,
      /secret-token/u,
    );
    await expectRemoteRejectionWithoutLeak(
      () => resolveSkillsWithWarnings([skill("https://example.com/org/repo.git?token=secret")], { baseDir }),
      /must not include query parameters/u,
      /token=secret/u,
    );
  });

  it("includes remote commit identity in skillsHash even when frontmatter is unchanged", async () => {
    const baseDir = await tempDir("little-workflow-skills-remote-hash-");
    const repoDir = join(baseDir, "repo");
    await initRepo(repoDir);
    await writeRepoSkill(repoDir, "foo", "Foo skill.", "Body v1.");
    const firstSha = await commitAll(repoDir, "add v1");
    await writeRepoSkill(repoDir, "foo", "Foo skill.", "Body v2.");
    const secondSha = await commitAll(repoDir, "add v2");

    const [first] = await resolveSkills([
      skill(`${pathToFileURL(repoDir).href}#${firstSha}`, { skills: ["foo"] }),
    ], { baseDir });
    const [second] = await resolveSkills([
      skill(`${pathToFileURL(repoDir).href}#${secondSha}`, { skills: ["foo"] }),
    ], { baseDir });

    expect(first?.frontmatterHash).toBe(second?.frontmatterHash);
    expect(first?.remote?.commitSha).toBe(firstSha);
    expect(second?.remote?.commitSha).toBe(secondSha);
    expect(skillsHash([first!])).not.toBe(skillsHash([second!]));
  });

  it("applies remote risk precedence from skill override to source default to role default to no gate", async () => {
    const baseDir = await tempDir("little-workflow-skills-risk-precedence-");
    const sha = "1234567890abcdef1234567890abcdef12345678";
    const remote = `https://github.com/org/repo#${sha}`;
    const snapshotDir = harnessSnapshotPath(
      join(tmpdir(), "little-harness-skills-cache"),
      "https://github.com/org/repo.git",
      sha,
    );
    tempDirs.push(snapshotDir);
    await rm(snapshotDir, { recursive: true, force: true });
    await mkdir(join(snapshotDir, "skills", "foo"), { recursive: true });
    await writeFile(
      join(snapshotDir, "skills", "foo", "SKILL.md"),
      skillMarkdown(`\nname: foo\ndescription: Foo skill.\n`),
      "utf8",
    );
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ riskLevel: "MEDIUM" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveSkills([
      skill(remote, { skills: ["foo"], skillMaxRisk: "MEDIUM", skillRisk: { foo: "LOW" } }),
    ], { baseDir, skillMaxRisk: "HIGH", skillOidcToken: "oidc-token" })).rejects.toThrow(/exceeds maximum risk/u);

    await expect(resolveSkills([
      skill(remote, { skills: ["foo"], skillMaxRisk: "MEDIUM" }),
    ], { baseDir, skillMaxRisk: "LOW", skillOidcToken: "oidc-token" })).resolves.toHaveLength(1);

    await expect(resolveSkills([
      skill(remote, { skills: ["foo"] }),
    ], { baseDir, skillMaxRisk: "LOW", skillOidcToken: "oidc-token" })).rejects.toThrow(/exceeds maximum risk/u);

    fetchMock.mockClear();
    await expect(resolveSkills([
      skill(remote, { skills: ["foo"] }),
    ], { baseDir })).resolves.toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a non-empty name in frontmatter", async () => {
    const baseDir = await tempDir("little-workflow-skills-missing-name-");
    const skillDir = join(baseDir, "skills", "missing-name");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      skillMarkdown(
        `
description: Missing name.
`,
      ),
      "utf8",
    );

    await expect(resolveSkills([skill("./skills/missing-name")], { baseDir })).rejects.toThrow(
      /must include a non-empty 'name'/u,
    );
  });

  it("requires a non-empty description in frontmatter", async () => {
    const baseDir = await tempDir("little-workflow-skills-missing-description-");
    const skillDir = join(baseDir, "skills", "missing-description");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      skillMarkdown(
        `
name: missing-description
`,
      ),
      "utf8",
    );

    await expect(resolveSkills([skill("./skills/missing-description")], { baseDir })).rejects.toThrow(
      /must include a non-empty 'description'/u,
    );
  });

  it.each([
    "../escape",
    "bad/name",
    "bad name",
    ".",
    "..",
    "semi;colon",
    "$(touch hacked)",
  ])("rejects unsafe local skill name %s", async (unsafeName) => {
    const baseDir = await tempDir("little-workflow-skills-unsafe-name-");
    const skillDir = join(baseDir, "skills", "unsafe");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      skillMarkdown(`\nname: ${unsafeName}\ndescription: Unsafe name.\n`),
      "utf8",
    );

    await expect(resolveSkills([skill("./skills/unsafe")], { baseDir })).rejects.toThrow(/Invalid skill name/u);
  });

  it("rejects unsafe org-mounted skill names", async () => {
    const baseDir = await tempDir("little-workflow-skills-unsafe-org-name-");
    const orgSkillDir = join(baseDir, "memory", "org", "skills");
    const skillDir = join(orgSkillDir, "unsafe");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      skillMarkdown("\nname: org/name\ndescription: Unsafe org name.\n"),
      "utf8",
    );

    await expect(resolveSkills([], { baseDir, orgSkillDir })).rejects.toThrow(/Invalid skill name/u);
  });

  it("rejects duplicate skill names within workflow-declared skills", async () => {
    const baseDir = await tempDir("little-workflow-skills-duplicates-");
    const first = join(baseDir, "skills", "team-a", "loops");
    const second = join(baseDir, "skills", "team-b", "loops");
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    const contents = skillMarkdown(
      `
name: loops
description: Build decision loops.
`,
    );
    await writeFile(join(first, "SKILL.md"), contents, "utf8");
    await writeFile(join(second, "SKILL.md"), contents, "utf8");

    await expect(
      resolveSkills(
        [skill("./skills/team-a/loops"), skill("./skills/team-b/loops")],
        { baseDir },
      ),
    ).rejects.toThrow(/Skill name 'loops' declared twice in workflow-declared skills/u);
  });

  it("lets workflow-declared skills override org-mounted skills and records warning metadata", async () => {
    const baseDir = await tempDir("little-workflow-skills-org-override-");
    const orgSkillDir = join(baseDir, "memory", "org", "skills");
    const workflowSkillDir = join(baseDir, "skills", "output-schema-validation");
    const orgOverrideDir = join(orgSkillDir, "output-schema-validation");
    const orgExtraDir = join(orgSkillDir, "pii-handling");

    await mkdir(workflowSkillDir, { recursive: true });
    await mkdir(orgOverrideDir, { recursive: true });
    await mkdir(orgExtraDir, { recursive: true });

    await writeFile(
      join(workflowSkillDir, "SKILL.md"),
      skillMarkdown(
        `
name: output-schema-validation
description: Workflow-specific output schema handling.
`,
      ),
      "utf8",
    );
    await writeFile(
      join(orgOverrideDir, "SKILL.md"),
      skillMarkdown(
        `
name: output-schema-validation
description: Org-default output schema handling.
`,
      ),
      "utf8",
    );
    await writeFile(
      join(orgExtraDir, "SKILL.md"),
      skillMarkdown(
        `
name: pii-handling
description: Handle PII safely.
`,
      ),
      "utf8",
    );

    const resolved = await resolveSkills(
      [skill("./skills/output-schema-validation")],
      { baseDir, orgSkillDir },
    );

    expect(resolved.map((entry) => entry.name)).toEqual([
      "output-schema-validation",
      "pii-handling",
    ]);
    expect(resolved[0]).toMatchObject({
      description: "Workflow-specific output schema handling.",
      warnings: [
        {
          code: "workflow_overrides_org_skill",
          name: "output-schema-validation",
        },
      ],
    });
  });

});

describe("skillsHash", () => {
  it("is stable regardless of skill descriptor order", async () => {
    const baseDir = await tempDir("little-workflow-skills-hash-");
    const firstDir = join(baseDir, "skills", "first");
    const secondDir = join(baseDir, "skills", "second");
    await mkdir(firstDir, { recursive: true });
    await mkdir(secondDir, { recursive: true });
    await writeFile(
      join(firstDir, "SKILL.md"),
      skillMarkdown(
        `
name: first
description: First skill.
`,
      ),
      "utf8",
    );
    await writeFile(
      join(secondDir, "SKILL.md"),
      skillMarkdown(
        `
name: second
description: Second skill.
`,
      ),
      "utf8",
    );

    const resolved = await resolveSkills(
      [skill("./skills/first"), skill("./skills/second")],
      { baseDir },
    );

    expect(skillsHash(resolved)).toBe(skillsHash([...resolved].reverse()));
  });
});

describe("skillPromptSection", () => {
  it("returns undefined when no skills are available", () => {
    expect(skillPromptSection([])).toBeUndefined();
  });

  it("formats skill summaries for system prompt injection", async () => {
    const baseDir = await tempDir("little-workflow-skills-prompt-");
    const firstDir = join(baseDir, "skills", "writing-loop-lwir");
    await mkdir(firstDir, { recursive: true });
    await writeFile(
      join(firstDir, "SKILL.md"),
      skillMarkdown(
        `
name: writing-loop-lwir
description: Design back-edge loops with decision steps.
`,
      ),
      "utf8",
    );

    const resolved = await resolveSkills([skill("./skills/writing-loop-lwir")], { baseDir });
    const section = skillPromptSection(resolved);
    // structured, with the two instructions both pi and opencode emphasise
    expect(section).toContain("<available_skills>");
    expect(section).toContain("When a task matches a skill's description, read that skill before acting");
    expect(section).toContain("resolve any relative paths it mentions");
    expect(section).toContain("<name>writing-loop-lwir</name>");
    expect(section).toContain("<description>Design back-edge loops with decision steps.</description>");
    expect(section).toContain("<read>cat .agents/skills/writing-loop-lwir/SKILL.md</read>");
    expect(section).not.toContain("/mnt/skills");
  });

  it("documents single-file skill mount paths", async () => {
    const baseDir = await tempDir("little-workflow-skills-single-file-prompt-");
    const filePath = join(baseDir, "skills", "output-schema-validation.md");
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      skillMarkdown(
        `
name: output-schema-validation
description: Ensure output schema matches runtime constraints.
`,
      ),
      "utf8",
    );

    const resolved = await resolveSkills(
      [skill("./skills/output-schema-validation.md")],
      { baseDir },
    );

    const section = skillPromptSection(resolved);
    expect(section).toContain("<read>cat .agents/skills/output-schema-validation/SKILL.md</read>");
    expect(section).not.toContain("/mnt/skills");
  });

  it("surfaces a directory skill's bundled reference files", async () => {
    const baseDir = await tempDir("little-workflow-skills-aux-prompt-");
    const dir = join(baseDir, "skills", "deploy");
    await mkdir(join(dir, "references"), { recursive: true });
    await writeFile(join(dir, "SKILL.md"), skillMarkdown(`\nname: deploy\ndescription: Deploy services.\n`), "utf8");
    await writeFile(join(dir, "references", "aws.md"), "aws notes\n", "utf8");

    const resolved = await resolveSkills([skill("./skills/deploy")], { baseDir });
    expect(skillPromptSection(resolved)).toContain("bundled_files");
  });
});

describe("auto-discovery (.agents/skills)", () => {
  async function withDiscoveredSkill(prefix: string, name: string, description: string) {
    const baseDir = await tempDir(prefix);
    await mkdir(join(baseDir, ".git"), { recursive: true }); // stop the walk here
    const dir = join(baseDir, ".agents", "skills", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), skillMarkdown(`\nname: ${name}\ndescription: ${description}\n`), "utf8");
    return baseDir;
  }

  it("discovers .agents/skills when discoverDirs is set (the shared cross-harness convention)", async () => {
    const baseDir = await withDiscoveredSkill("little-workflow-discover-", "house-style", "Project house style.");
    const resolved = await resolveSkills([], { baseDir, discoverDirs: [".agents/skills"] });
    expect(resolved.map((s) => s.name)).toContain("house-style");
  });

  it("does not discover unless discoverDirs is set (no surprise behaviour)", async () => {
    const baseDir = await withDiscoveredSkill("little-workflow-nodiscover-", "house-style", "Project house style.");
    const resolved = await resolveSkills([], { baseDir });
    expect(resolved.map((s) => s.name)).not.toContain("house-style");
  });

  it("an explicit workflow skill overrides a discovered skill of the same name", async () => {
    const baseDir = await withDiscoveredSkill("little-workflow-override-", "house-style", "discovered version.");
    const explicit = join(baseDir, "skills", "house-style");
    await mkdir(explicit, { recursive: true });
    await writeFile(join(explicit, "SKILL.md"), skillMarkdown(`\nname: house-style\ndescription: workflow version.\n`), "utf8");

    const resolved = await resolveSkills([skill("./skills/house-style")], { baseDir, discoverDirs: [".agents/skills"] });
    const houseStyle = resolved.filter((s) => s.name === "house-style");
    expect(houseStyle).toHaveLength(1);
    expect(houseStyle[0].description).toBe("workflow version.");
  });

  it("rejects unsafe discovered skill names", async () => {
    const baseDir = await tempDir("little-workflow-discover-unsafe-");
    await mkdir(join(baseDir, ".git"), { recursive: true });
    const dir = join(baseDir, ".agents", "skills", "unsafe");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      skillMarkdown("\nname: discovered/name\ndescription: Unsafe discovered name.\n"),
      "utf8",
    );

    await expect(resolveSkills([], { baseDir, discoverDirs: [".agents/skills"] })).rejects.toThrow(/Invalid skill name/u);
  });
});
