import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test/temp.js";
import type { RemoteSkillOptions, SkillInput, SkillOidcToken } from "../types.js";
import { resolveSkills, resolveSkillsWithWarnings, skill } from "./skill.js";

const execFileAsync = promisify(execFile);

const envAuthInput: SkillInput = skill("https://github.com/org/repo", {
  auth: { type: "bearer", token: process.env.GIT_TOKEN },
});
const undefinedOidcToken: SkillOidcToken = () => undefined;
const skillRiskOptions: RemoteSkillOptions = {
  skillRisk: { alpha: "LOW" },
};
const readonlySkillsOptions: RemoteSkillOptions = {
  skills: ["alpha"] as const,
};
// @ts-expect-error skillOidcToken belongs on createHarness/resolve defaults, not per-skill options.
const skillOidcTokenOptions: RemoteSkillOptions = { skillOidcToken: () => undefined };
// @ts-expect-error oidcToken is intentionally not part of the public remote skill API.
const oidcTokenOptions: RemoteSkillOptions = { oidcToken: "legacy-token" };
// @ts-expect-error ref is encoded in the URL fragment, not public options.
const refOptions: RemoteSkillOptions = { ref: "main" };
// @ts-expect-error cacheDir is an internal resolver concern, not public options.
const cacheDirOptions: RemoteSkillOptions = { cacheDir: "/tmp/little-harness-skills" };
void [
  envAuthInput,
  undefinedOidcToken,
  skillRiskOptions,
  readonlySkillsOptions,
  skillOidcTokenOptions,
  oidcTokenOptions,
  refOptions,
  cacheDirOptions,
];

describe("skill", () => {
  it("resolves a directory skill with frontmatter metadata", async () => {
    await withTempDir(async (dir) => {
      const root = path.join(dir, "skills/customer");
      await mkdir(path.join(root, "examples"), { recursive: true });
      await writeFile(
        path.join(root, "SKILL.md"),
        "---\nname: customer-briefs\ndescription: Use for renewal briefs.\n---\nBody",
      );
      await writeFile(path.join(root, "examples/one.md"), "Example");

      const [resolved] = await resolveSkills([skill(root)]);
      expect(resolved?.name).toBe("customer-briefs");
      expect(resolved?.description).toBe("Use for renewal briefs.");
      expect(resolved?.harnessDir).toBe(".agents/skills/customer-briefs");
      expect(Object.keys(resolved?.files ?? {})).toEqual(["SKILL.md", "examples/one.md"]);
    });
  });

  it("resolves existing two-segment local skill paths", async () => {
    await withTempDir(async (dir) => {
      const root = path.join(dir, "skills/foo");
      await mkdir(root, { recursive: true });
      await writeFile(
        path.join(root, "SKILL.md"),
        "---\nname: foo\ndescription: Local foo.\n---\nBody",
      );
      const cwd = process.cwd();
      process.chdir(dir);
      try {
        const [resolved] = await resolveSkills([skill("skills/foo")]);
        expect(resolved?.name).toBe("foo");
        expect(resolved?.harnessDir).toBe(".agents/skills/foo");
      } finally {
        process.chdir(cwd);
      }
    });
  });

  it("supports inline skill files", async () => {
    const [resolved] = await resolveSkills([
      skill({
        name: "support-triage",
        description: "Use for support triage.",
        files: { "SKILL.md": "Body" },
      }),
    ]);

    expect(resolved?.files["SKILL.md"]).toBeInstanceOf(Uint8Array);
    expect(resolved?.harnessDir).toBe(".agents/skills/support-triage");
  });

  it("rejects remote shorthand strings with explicit Git URL errors", async () => {
    await expect(resolveSkills([skill("github:org/repo")])).rejects.toThrow(/explicit Git URL/u);
    await expect(resolveSkills([skill("gitlab:org/repo")])).rejects.toThrow(/explicit Git URL/u);
    await expect(resolveSkills([skill("org/repo")])).rejects.toThrow(/explicit Git URL/u);
  });

  it("soft-fails unavailable remote skill sources with a warning", async () => {
    await withTempDir(async (dir) => {
      const remote = `${pathToFileURL(path.join(dir, "missing-repo")).href}#${"a".repeat(40)}`;
      const result = await resolveSkillsWithWarnings([
        skill(remote, { skills: ["missing"] }),
      ]);

      expect(result.skills).toEqual([]);
      expect(result.warnings).toEqual([
        expect.objectContaining({
          code: "policy_warning",
          message: expect.stringContaining("Remote skill source was skipped"),
          metadata: expect.objectContaining({
            reason: "remote_skill_unavailable",
            source: remote,
          }),
        }),
      ]);
    });
  });

  it("rejects invalid remote sources in warning mode", async () => {
    await expect(resolveSkillsWithWarnings([skill("github:org/repo")]))
      .rejects.toThrow(/explicit Git URL/u);
    await expect(resolveSkillsWithWarnings([skill("org/repo")]))
      .rejects.toThrow(/explicit Git URL/u);
  });

  it("rejects unsafe remote URLs in warning mode without leaking secrets", async () => {
    const credentialSource = "https://secret-token@example.com/org/repo.git";
    await expect(resolveSkillsWithWarnings([skill(credentialSource)]))
      .rejects.toThrow(/must not include credentials/u);
    await expect(resolveSkillsWithWarnings([skill(credentialSource)]))
      .rejects.not.toThrow(/secret-token/u);

    const querySource = "https://example.com/org/repo.git?token=secret";
    await expect(resolveSkillsWithWarnings([skill(querySource)]))
      .rejects.toThrow(/must not include query parameters/u);
    await expect(resolveSkillsWithWarnings([skill(querySource)]))
      .rejects.not.toThrow(/token=secret/u);
  });

  it("soft-fails remote audit failures with a warning", async () => {
    await withTempDir(async (dir) => {
      const repoDir = path.join(dir, "repo");
      await initRepo(repoDir);
      await writeRepoSkill(repoDir, "alpha", "Alpha", { internal: false });
      const sha = await commitAll(repoDir, "add alpha");
      const remote = `${pathToFileURL(repoDir).href}#${sha}`;

      const result = await resolveSkillsWithWarnings([
        skill(remote, { skillMaxRisk: "LOW" }),
      ]);

      expect(result.skills).toEqual([]);
      expect(result.warnings).toEqual([
        expect.objectContaining({
          code: "policy_warning",
          message: expect.stringContaining("Remote skill source was skipped"),
          metadata: expect.objectContaining({
            reason: "remote_skill_unavailable",
            source: remote,
          }),
        }),
      ]);
    });
  });

  it("still rejects missing local skills", async () => {
    await expect(resolveSkillsWithWarnings([skill("./missing-local-skill")]))
      .rejects.toThrow();
  });

  it("rejects ambiguous missing local-looking skills in warning mode", async () => {
    await withTempDir(async (dir) => {
      const cwd = process.cwd();
      process.chdir(dir);
      try {
        await expect(resolveSkillsWithWarnings([skill("skills/missing")]))
          .rejects.toThrow();
      } finally {
        process.chdir(cwd);
      }
    });
  });

  it("selects all non-internal remote skills by default", async () => {
    await withTempDir(async (dir) => {
      const repoDir = path.join(dir, "repo");
      await initRepo(repoDir);
      await writeRepoSkill(repoDir, "alpha", "Alpha", { internal: false });
      await writeRepoSkill(repoDir, "beta", "Beta", { internal: false });
      await writeRepoSkill(repoDir, "internal", "Internal", { internal: true });
      const sha = await commitAll(repoDir, "add skills");

      const resolved = await resolveSkills([skill(`${pathToFileURL(repoDir).href}#${sha}`)]);

      expect(resolved.map((item) => item.name).sort()).toEqual(["alpha", "beta"]);
      expect(resolved.map((item) => item.harnessDir).sort()).toEqual([
        ".agents/skills/alpha",
        ".agents/skills/beta",
      ]);
    });
  });

  it("adds non-secret remote source metadata to resolved skills", async () => {
    await withTempDir(async (dir) => {
      const repoDir = path.join(dir, "repo");
      await initRepo(repoDir);
      await writeRepoSkill(repoDir, "alpha", "Alpha", { internal: false });
      const sha = await commitAll(repoDir, "add alpha");
      const remote = `${pathToFileURL(repoDir).href}#${sha}`;

      const [resolved] = await resolveSkills([
        skill(remote, {
          skills: ["alpha"],
          auth: { type: "bearer", token: "secret-token" },
        }),
      ]);

      expect(resolved?.source).toMatchObject({
        type: "remote-git",
        original: remote,
        cloneUrl: pathToFileURL(repoDir).href,
        provider: "git",
        commitSha: sha,
        selectedSkill: "alpha",
        skillPath: "skills/alpha",
        contentHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      });
      expect(JSON.stringify(resolved?.source)).not.toContain("secret-token");
    });
  });

  it("selects requested remote skills by name or display name case-insensitively", async () => {
    await withTempDir(async (dir) => {
      const repoDir = path.join(dir, "repo");
      await initRepo(repoDir);
      await writeRepoSkill(repoDir, "alpha", "Frontend Design", { internal: false });
      await writeRepoSkill(repoDir, "beta", "Beta", { internal: false });
      const sha = await commitAll(repoDir, "add skills");

      const resolved = await resolveSkills([
        skill(`${pathToFileURL(repoDir).href}#${sha}`, {
          skills: ["frontend design", "BETA"],
        }),
      ]);

      expect(resolved.map((item) => item.name)).toEqual(["alpha", "beta"]);
    });
  });

  it("includes internal remote skills only when explicitly selected", async () => {
    await withTempDir(async (dir) => {
      const repoDir = path.join(dir, "repo");
      await initRepo(repoDir);
      await writeRepoSkill(repoDir, "internal-review", "Internal Review", { internal: true });
      const sha = await commitAll(repoDir, "add internal skill");

      const resolved = await resolveSkills([
        skill(`${pathToFileURL(repoDir).href}#${sha}`, {
          skills: ["internal review"],
        }),
      ]);

      expect(resolved.map((item) => item.name)).toEqual(["internal-review"]);
    });
  });

  it("fails missing requested remote skills with discovered names", async () => {
    await withTempDir(async (dir) => {
      const repoDir = path.join(dir, "repo");
      await initRepo(repoDir);
      await writeRepoSkill(repoDir, "alpha", "Alpha", { internal: false });
      const sha = await commitAll(repoDir, "add alpha");

      await expect(
        resolveSkills([
          skill(`${pathToFileURL(repoDir).href}#${sha}`, { skills: ["missing"] }),
        ]),
      ).rejects.toThrow(/missing.*alpha/u);
    });
  });

  it("fails when a remote source has zero valid selected skills", async () => {
    await withTempDir(async (dir) => {
      const repoDir = path.join(dir, "repo");
      await initRepo(repoDir);
      await writeRepoSkill(repoDir, "internal-only", "Internal Only", { internal: true });
      const sha = await commitAll(repoDir, "add internal-only");

      await expect(resolveSkills([skill(`${pathToFileURL(repoDir).href}#${sha}`)]))
        .rejects.toThrow(/No valid skills/u);
    });
  });

  it("fails when a remote skill file exceeds the discovery size limit", async () => {
    await withTempDir(async (dir) => {
      const repoDir = path.join(dir, "repo");
      await initRepo(repoDir);
      await writeRepoSkill(repoDir, "oversized", "Oversized", { internal: false });
      await writeFile(
        path.join(repoDir, "skills", "oversized", "large.bin"),
        new Uint8Array(1024 * 1024 + 1),
      );
      const sha = await commitAll(repoDir, "add oversized skill");

      await expect(resolveSkills([skill(`${pathToFileURL(repoDir).href}#${sha}`)]))
        .rejects.toThrow(/exceeds.*size limit/u);
    });
  });

  it("fails when a remote source selects too many skills", async () => {
    await withTempDir(async (dir) => {
      const repoDir = path.join(dir, "repo");
      await initRepo(repoDir);
      for (let index = 0; index < 33; index += 1) {
        await writeRepoSkill(repoDir, `skill-${index.toString().padStart(2, "0")}`, `Skill ${index}`, {
          internal: false,
        });
      }
      const sha = await commitAll(repoDir, "add many skills");

      await expect(resolveSkills([skill(`${pathToFileURL(repoDir).href}#${sha}`)]))
        .rejects.toThrow(/too many selected skills/u);
    });
  });

  it("rejects remote skills with unsafe names", async () => {
    for (const invalidName of [".", "..", "bad/name", "bad\\name", "   ", "-bad", "bad.", "CON", "éclair"]) {
      await withTempDir(async (dir) => {
        const repoDir = path.join(dir, "repo");
        await initRepo(repoDir);
        await writeRepoSkillWithName(repoDir, "bad-skill", invalidName, "Bad Skill", { internal: false });
        const sha = await commitAll(repoDir, `add invalid ${invalidName.trim() || "blank"} skill`);

        await expect(resolveSkills([skill(`${pathToFileURL(repoDir).href}#${sha}`)]))
          .rejects.toThrow(/Invalid remote skill name/u);
      });
    }
  });

  it("rejects remote skills with canonical name collisions", async () => {
    await withTempDir(async (dir) => {
      const repoDir = path.join(dir, "repo");
      await initRepo(repoDir);
      await writeRepoSkillWithName(repoDir, "one", "alpha", "Alpha", { internal: false });
      await writeRepoSkillWithName(repoDir, "two", "Alpha", "Alpha Duplicate", { internal: false });
      const sha = await commitAll(repoDir, "add colliding skills");

      await expect(resolveSkills([skill(`${pathToFileURL(repoDir).href}#${sha}`)]))
        .rejects.toThrow(/Remote skill names collide/u);
    });
  });
});

async function initRepo(repoDir: string): Promise<void> {
  await mkdir(repoDir, { recursive: true });
  await git(repoDir, ["init", "-b", "main"]);
  await git(repoDir, ["config", "user.name", "Little Harness Tests"]);
  await git(repoDir, ["config", "user.email", "tests@example.com"]);
}

async function writeRepoSkill(
  repoDir: string,
  name: string,
  displayName: string,
  options: { internal: boolean },
): Promise<void> {
  await writeRepoSkillWithName(repoDir, name, name, displayName, options);
}

async function writeRepoSkillWithName(
  repoDir: string,
  directoryName: string,
  frontmatterName: string,
  displayName: string,
  options: { internal: boolean },
): Promise<void> {
  const skillDir = path.join(repoDir, "skills", directoryName);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${frontmatterName}\ndisplay_name: ${displayName}\ndescription: ${displayName} skill.\nmetadata:\n  internal: ${options.internal ? "true" : "false"}\n---\n\nBody\n`,
    "utf8",
  );
}

async function commitAll(repoDir: string, message: string): Promise<string> {
  await git(repoDir, ["add", "."]);
  await git(repoDir, ["commit", "-m", message]);
  return git(repoDir, ["rev-parse", "HEAD"]);
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return stdout.trim();
}
