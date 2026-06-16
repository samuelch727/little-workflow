import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test/temp.js";
import {
  cacheScopeForTest,
  materializeRemoteGitSource,
  cloneArgsForTest,
  credentialResponseForTest,
  fetchArgsForTest,
  prepareGitInvocationForTest,
  resolveGitAuthForTest,
  sparseCheckoutArgsForTest,
  snapshotPathForTest,
} from "./git-cache.js";
import { parseRemoteSkillSource } from "./remote-source.js";

const execFileAsync = promisify(execFile);

describe("materializeRemoteGitSource", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("caches snapshots by resolved commit SHA", async () => {
    await withTempDir(async (dir) => {
      const repoDir = join(dir, "repo");
      const cacheDir = join(dir, "cache");
      await initRepo(repoDir);
      await writeSkill(repoDir, "foo", "v1");
      await git(repoDir, ["add", "."]);
      const firstSha = await commit(repoDir, "add foo");

      const source = parseRemoteSkillSource(`${pathToFileURL(repoDir).href}#main`);
      const first = await materializeRemoteGitSource(source, { cacheDir });
      const second = await materializeRemoteGitSource(source, { cacheDir });

      expect(first.commitSha).toBe(firstSha);
      expect(second).toMatchObject({
        commitSha: firstSha,
        snapshotDir: first.snapshotDir,
        cacheHit: true,
      });
      await expect(readFile(join(first.snapshotDir, "skills", "foo", "SKILL.md"), "utf8"))
        .resolves.toContain("v1");
    });
  });

  it("reuses a cached commit-SHA ref without touching the remote", async () => {
    await withTempDir(async (dir) => {
      const repoDir = join(dir, "repo");
      const cacheDir = join(dir, "cache");
      await initRepo(repoDir);
      await writeSkill(repoDir, "foo", "pinned");
      await git(repoDir, ["add", "."]);
      const sha = await commit(repoDir, "add pinned foo");

      const source = parseRemoteSkillSource(`${pathToFileURL(repoDir).href}#${sha}`);
      const first = await materializeRemoteGitSource(source, { cacheDir });
      await rm(repoDir, { recursive: true, force: true });
      const second = await materializeRemoteGitSource(source, { cacheDir });

      expect(second).toMatchObject({
        commitSha: sha,
        snapshotDir: first.snapshotDir,
        cacheHit: true,
      });
      await expect(readFile(join(second.snapshotDir, "skills", "foo", "SKILL.md"), "utf8"))
        .resolves.toContain("pinned");
    });
  });

  it("keeps subpath snapshots separate for the same repo commit in either order", async () => {
    await withTempDir(async (dir) => {
      const repoDir = join(dir, "repo");
      const cacheDir = join(dir, "cache");
      await initRepo(repoDir);
      await writeSkill(repoDir, "alpha", "alpha body");
      await writeSkill(repoDir, "beta", "beta body");
      await git(repoDir, ["add", "."]);
      const sha = await commit(repoDir, "add two skills");
      const base = parseRemoteSkillSource(`${pathToFileURL(repoDir).href}#${sha}`);
      const alpha = { ...base, subpath: "skills/alpha" };
      const beta = { ...base, subpath: "skills/beta" };

      const alphaFirst = await materializeRemoteGitSource(alpha, { cacheDir });
      const betaSecond = await materializeRemoteGitSource(beta, { cacheDir });
      expect(alphaFirst.snapshotDir).not.toBe(betaSecond.snapshotDir);
      await expect(readFile(join(alphaFirst.snapshotDir, "skills", "alpha", "SKILL.md"), "utf8"))
        .resolves.toContain("alpha body");
      await expect(readFile(join(betaSecond.snapshotDir, "skills", "beta", "SKILL.md"), "utf8"))
        .resolves.toContain("beta body");

      const reverseCacheDir = join(dir, "reverse-cache");
      const betaFirst = await materializeRemoteGitSource(beta, { cacheDir: reverseCacheDir });
      const alphaSecond = await materializeRemoteGitSource(alpha, { cacheDir: reverseCacheDir });
      expect(betaFirst.snapshotDir).not.toBe(alphaSecond.snapshotDir);
      await expect(readFile(join(betaFirst.snapshotDir, "skills", "beta", "SKILL.md"), "utf8"))
        .resolves.toContain("beta body");
      await expect(readFile(join(alphaSecond.snapshotDir, "skills", "alpha", "SKILL.md"), "utf8"))
        .resolves.toContain("alpha body");
    });
  });

  it("creates a new cache entry when a branch moves", async () => {
    await withTempDir(async (dir) => {
      const repoDir = join(dir, "repo");
      const cacheDir = join(dir, "cache");
      await initRepo(repoDir);
      await writeSkill(repoDir, "foo", "v1");
      await git(repoDir, ["add", "."]);
      const firstSha = await commit(repoDir, "add foo v1");

      const source = parseRemoteSkillSource(`${pathToFileURL(repoDir).href}#main`);
      const first = await materializeRemoteGitSource(source, { cacheDir });

      await writeSkill(repoDir, "foo", "v2");
      await git(repoDir, ["add", "."]);
      const secondSha = await commit(repoDir, "add foo v2");
      const second = await materializeRemoteGitSource(source, { cacheDir });

      expect(first.commitSha).toBe(firstSha);
      expect(second.commitSha).toBe(secondSha);
      expect(second.snapshotDir).not.toBe(first.snapshotDir);
      await expect(readFile(join(second.snapshotDir, "skills", "foo", "SKILL.md"), "utf8"))
        .resolves.toContain("v2");
    });
  });

  it("redacts auth tokens from git errors", async () => {
    await withTempDir(async (dir) => {
      vi.stubEnv("LITTLE_SKILLS_GIT_TOKEN", "super-secret-token");
      vi.stubEnv("LITTLE_SKILLS_GIT_TOKEN_HOSTS", "example.invalid");

      const source = parseRemoteSkillSource("https://example.invalid/org/repo.git#main");
      await expect(
        materializeRemoteGitSource(source, { cacheDir: join(dir, "cache") }),
      ).rejects.toThrow(/Failed to resolve remote skill ref/u);

      try {
        await materializeRemoteGitSource(source, { cacheDir: join(dir, "cache") });
      } catch (error) {
        const serialized = JSON.stringify(error);
        expect(serialized).not.toContain("super-secret-token");
      }
    });
  });

  it("uses env git bearer auth only for HTTPS remotes", () => {
    vi.stubEnv("LITTLE_SKILLS_GIT_TOKEN", "env-token");
    vi.stubEnv("LITTLE_SKILLS_GIT_TOKEN_HOSTS", "git.company.com");

    expect(resolveGitAuthForTest(parseRemoteSkillSource("https://git.company.com/org/repo.git")))
      .toMatchObject({ token: "env-token" });
    expect(resolveGitAuthForTest(parseRemoteSkillSource("ssh://git@git.company.com/org/repo.git")))
      .toBeUndefined();
    expect(resolveGitAuthForTest(parseRemoteSkillSource("git@git.company.com:org/repo.git")))
      .toBeUndefined();
    expect(resolveGitAuthForTest(parseRemoteSkillSource("file:///tmp/repo.git")))
      .toBeUndefined();
  });

  it("requires exact env git bearer auth host allowlist entries for non-default ports", () => {
    vi.stubEnv("LITTLE_SKILLS_GIT_TOKEN", "env-token");
    vi.stubEnv("LITTLE_SKILLS_GIT_TOKEN_HOSTS", "git.company.com");

    expect(resolveGitAuthForTest(parseRemoteSkillSource("https://git.company.com/org/repo.git")))
      .toMatchObject({ token: "env-token" });
    expect(resolveGitAuthForTest(parseRemoteSkillSource("https://git.company.com:8443/org/repo.git")))
      .toBeUndefined();

    vi.stubEnv("LITTLE_SKILLS_GIT_TOKEN_HOSTS", "git.company.com:8443");
    expect(resolveGitAuthForTest(parseRemoteSkillSource("https://git.company.com:8443/org/repo.git")))
      .toMatchObject({
        token: "env-token",
        headerScope: "https://git.company.com:8443/",
        credentialScope: expect.objectContaining({ host: "git.company.com:8443" }),
      });
  });

  it("keeps bearer tokens out of git argv and environment", async () => {
    const auth = resolveGitAuthForTest(
      parseRemoteSkillSource("https://git.company.com/org/repo.git"),
      { type: "bearer", token: "super-secret-token" },
    )!;
    const invocation = await prepareGitInvocationForTest(["ls-remote", "https://git.company.com/org/repo.git"], auth);
    try {
      expect(invocation.args.join("\n")).not.toContain("super-secret-token");
      expect(Object.values(invocation.env).join("\n")).not.toContain("super-secret-token");
      expect(invocation.authFilePaths?.length).toBeGreaterThan(0);
      for (const authFilePath of invocation.authFilePaths ?? []) {
        expect(await readFile(authFilePath, "utf8")).not.toContain("super-secret-token");
        expect((await stat(authFilePath)).mode & 0o777).toBe(0o700);
      }
    } finally {
      await invocation.cleanup();
    }
  });

  it("strips inherited git auth env from git child processes", async () => {
    vi.stubEnv("GIT_ASKPASS", "/tmp/leaky-askpass");
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/tmp/leaky-gitconfig");
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "credential.helper");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "!echo password=ambient-secret");
    vi.stubEnv("GIT_CREDENTIAL_HELPER", "ambient-secret");
    vi.stubEnv("HOME", "/tmp/home-with-gitconfig");
    vi.stubEnv("XDG_CONFIG_HOME", "/tmp/xdg-with-gitconfig");
    vi.stubEnv("SSH_AUTH_SOCK", "/tmp/leaky-agent.sock");
    vi.stubEnv("SSH_AGENT_PID", "12345");

    const invocation = await prepareGitInvocationForTest(["ls-remote", "https://git.company.com/org/repo.git"], undefined);
    try {
      expect(invocation.cwd).toMatch(/little-harness-git-/u);
      expect(invocation.env.GIT_ASKPASS).toBeUndefined();
      expect(invocation.env.GIT_CONFIG_GLOBAL).not.toBe("/tmp/leaky-gitconfig");
      expect(invocation.env.GIT_CONFIG_COUNT).toBeUndefined();
      expect(invocation.env.GIT_CONFIG_KEY_0).toBeUndefined();
      expect(invocation.env.GIT_CONFIG_VALUE_0).toBeUndefined();
      expect(invocation.env.GIT_CREDENTIAL_HELPER).toBeUndefined();
      expect(invocation.env.HOME).not.toBe("/tmp/home-with-gitconfig");
      expect(invocation.env.XDG_CONFIG_HOME).not.toBe("/tmp/xdg-with-gitconfig");
      expect(invocation.env.SSH_AUTH_SOCK).toBeUndefined();
      expect(invocation.env.SSH_AGENT_PID).toBeUndefined();
      expect(Object.values(invocation.env).join("\n")).not.toContain("ambient-secret");
    } finally {
      await invocation.cleanup();
    }
  });

  it("strips little skills token env vars from git child environment", async () => {
    vi.stubEnv("LITTLE_SKILLS_GIT_TOKEN", "env-secret-token");
    vi.stubEnv("LITTLE_SKILLS_GIT_TOKEN_HOSTS", "git.company.com");

    const auth = resolveGitAuthForTest(parseRemoteSkillSource("https://git.company.com/org/repo.git"))!;
    const invocation = await prepareGitInvocationForTest(["ls-remote", "https://git.company.com/org/repo.git"], auth);
    try {
      expect(invocation.env.LITTLE_SKILLS_GIT_TOKEN).toBeUndefined();
      expect(invocation.env.LITTLE_SKILLS_GIT_TOKEN_HOSTS).toBeUndefined();
      expect(Object.values(invocation.env).join("\n")).not.toContain("env-secret-token");
    } finally {
      await invocation.cleanup();
    }
  });

  it("partitions authenticated cache snapshots from unauthenticated snapshots", async () => {
    const source = parseRemoteSkillSource("https://git.company.com/org/repo.git#1234567890abcdef1234567890abcdef12345678");
    const auth = { type: "bearer" as const, token: "private-token" };

    const unauthenticated = snapshotPathForTest("/cache", source, undefined);
    const authenticated = snapshotPathForTest("/cache", source, auth);

    expect(authenticated).not.toBe(unauthenticated);
    expect(authenticated).toContain(cacheScopeForTest(resolveGitAuthForTest(source, auth)!));
    expect(authenticated).not.toContain("private-token");
  });

  it("partitions cache snapshots by normalized subpath", async () => {
    const base = parseRemoteSkillSource("https://git.company.com/org/repo.git#1234567890abcdef1234567890abcdef12345678");
    const root = snapshotPathForTest("/cache", base, undefined);
    const alpha = snapshotPathForTest("/cache", { ...base, subpath: "skills/alpha" }, undefined);
    const alphaWithSlashes = snapshotPathForTest("/cache", { ...base, subpath: "/skills/alpha/" }, undefined);
    const beta = snapshotPathForTest("/cache", { ...base, subpath: "skills/beta" }, undefined);

    expect(alpha).not.toBe(root);
    expect(beta).not.toBe(alpha);
    expect(alphaWithSlashes).toBe(alpha);
  });

  it("does not share full-SHA authenticated cache snapshots between different tokens", async () => {
    const source = parseRemoteSkillSource("https://git.company.com/org/repo.git#1234567890abcdef1234567890abcdef12345678");
    const first = snapshotPathForTest("/cache", source, { type: "bearer", token: "first-token" });
    const second = snapshotPathForTest("/cache", source, { type: "bearer", token: "second-token" });

    expect(first).not.toBe(second);
    expect(first).not.toContain("first-token");
    expect(second).not.toContain("second-token");
  });

  it("creates cache directories with owner-only permissions", async () => {
    await withTempDir(async (dir) => {
      const repoDir = join(dir, "repo");
      const cacheDir = join(dir, "cache");
      await initRepo(repoDir);
      await writeSkill(repoDir, "foo", "private");
      await git(repoDir, ["add", "."]);
      const sha = await commit(repoDir, "add private foo");

      await materializeRemoteGitSource(parseRemoteSkillSource(`${pathToFileURL(repoDir).href}#${sha}`), { cacheDir });

      expect((await stat(cacheDir)).mode & 0o777).toBe(0o700);
    });
  });

  it("uses conservative clone args and disables lfs smudge", async () => {
    const invocation = await prepareGitInvocationForTest(
      cloneArgsForTest("https://git.company.com/org/repo.git", "/tmp/repo"),
      undefined,
    );
    try {
      expect(invocation.args).toEqual([
        "clone",
        "--quiet",
        "--no-checkout",
        "--depth=1",
        "--single-branch",
        "--filter=blob:none",
        "--no-tags",
        "https://git.company.com/org/repo.git",
        "/tmp/repo",
      ]);
      expect(invocation.env.GIT_LFS_SKIP_SMUDGE).toBe("1");
    } finally {
      await invocation.cleanup();
    }
  });

  it("builds bounded fetch args for pinned commits", () => {
    expect(fetchArgsForTest("/tmp/repo", "origin", "1234567890abcdef1234567890abcdef12345678")).toEqual([
      "-C",
      "/tmp/repo",
      "fetch",
      "--quiet",
      "--depth=1",
      "--filter=blob:none",
      "--no-tags",
      "origin",
      "1234567890abcdef1234567890abcdef12345678",
    ]);
  });

  it("builds sparse checkout args for remote subpaths", () => {
    expect(sparseCheckoutArgsForTest("/tmp/repo", "skills/frontend")).toEqual([
      "-C",
      "/tmp/repo",
      "sparse-checkout",
      "set",
      "--no-cone",
      "skills/frontend",
    ]);
  });

  it("returns credentials only for the expected protocol host and repo path", () => {
    const auth = resolveGitAuthForTest(
      parseRemoteSkillSource("https://git.company.com/org/repo.git"),
      { type: "bearer", token: "scoped-token" },
    )!;

    expect(credentialResponseForTest(auth, "protocol=https\nhost=git.company.com\npath=org/repo.git\n\n"))
      .toContain("scoped-token");
    expect(credentialResponseForTest(auth, "protocol=http\nhost=git.company.com\npath=org/repo.git\n\n"))
      .toBe("");
    expect(credentialResponseForTest(auth, "protocol=https\nhost=evil.example\npath=org/repo.git\n\n"))
      .toBe("");
    expect(credentialResponseForTest(auth, "protocol=https\nhost=git.company.com\npath=other/repo.git\n\n"))
      .toBe("");
  });

  it("matches credential requests for explicit HTTPS ports", () => {
    const auth = resolveGitAuthForTest(
      parseRemoteSkillSource("https://git.company.com:8443/org/repo.git"),
      { type: "bearer", token: "port-token" },
    )!;

    expect(credentialResponseForTest(auth, "protocol=https\nhost=git.company.com:8443\npath=org/repo.git\n\n"))
      .toContain("port-token");
    expect(credentialResponseForTest(auth, "protocol=https\nhost=git.company.com\npath=org/repo.git\n\n"))
      .toBe("");
  });
});

async function initRepo(repoDir: string): Promise<void> {
  await mkdir(repoDir, { recursive: true });
  await git(repoDir, ["init", "-b", "main"]);
  await git(repoDir, ["config", "user.name", "Little Harness Tests"]);
  await git(repoDir, ["config", "user.email", "tests@example.com"]);
}

async function writeSkill(repoDir: string, name: string, body: string): Promise<void> {
  const skillDir = join(repoDir, "skills", name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} skill.\n---\n\n${body}\n`,
    "utf8",
  );
}

async function commit(repoDir: string, message: string): Promise<string> {
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
