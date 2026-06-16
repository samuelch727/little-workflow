import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { createHarness } from "../create-harness.js";
import { inputType } from "../input-types/input-type.js";
import { localHost } from "../local-host/index.js";
import { memory } from "../memory/memory.js";
import { skill } from "../skills/skill.js";
import { withTempDir } from "../test/temp.js";
import { buildModelMessages } from "./messages.js";

const model = { provider: "test", modelId: "test" } as any;
const execFileAsync = promisify(execFile);

describe("buildModelMessages", () => {
  it("accepts raw UIMessage arrays", async () => {
    const harness = createHarness({ host: localHost(), model });
    const session = await harness.sessions.getOrCreate({ id: "chat" });
    const messages = [{ id: "m1", role: "user", parts: [{ type: "text", text: "Hi" }] }] as UIMessage[];
    const result = await buildModelMessages({ harness, config: harness.config, session, messages });
    expect(result.messages.at(-1)?.role).toBe("user");
  });

  it("soft-fails remote audit failures while resolving configured skills", async () => {
    await withTempDir(async (dir) => {
      const repoDir = path.join(dir, "repo");
      await initRepo(repoDir);
      await writeRepoSkill(repoDir, "alpha");
      const sha = await commitAll(repoDir, "add alpha");

      const harness = createHarness({
        host: localHost({ dataDir: path.join(dir, "host") }),
        model,
        skillMaxRisk: "LOW",
        skillOidcToken: "oidc-token",
        skills: [skill(`${pathToFileURL(repoDir).href}#${sha}`)],
      });
      const session = await harness.sessions.getOrCreate({ id: "chat" });

      const result = await buildModelMessages({
        harness,
        config: harness.config,
        session,
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Hi" }] }] as UIMessage[],
      });

      expect(result.system).not.toContain("alpha");
      expect(result.warnings).toEqual([
        expect.objectContaining({
          code: "policy_warning",
          metadata: expect.objectContaining({
            reason: "remote_skill_unavailable",
            source: `${pathToFileURL(repoDir).href}#${sha}`,
          }),
        }),
      ]);
    });
  });

  it("strips staged UI file parts before converting model messages", async () => {
    const harness = createHarness({ host: localHost(), model });
    const session = await harness.sessions.getOrCreate({ id: "chat" });
    const messages = [
      {
        id: "m1",
        role: "user",
        parts: [
          { type: "text", text: "Review the staged file." },
          {
            type: "file",
            filename: "input.txt",
            mediaType: "text/plain",
            data: new TextEncoder().encode("file"),
          },
        ],
      },
    ] as unknown as UIMessage[];

    const result = await buildModelMessages({
      harness,
      config: harness.config,
      session,
      messages,
      stripStagedFileParts: true,
      stagingNotices: ["/session/user-input/m1/input.txt"],
    });

    expect(result.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Review the staged file." }] },
      {
        role: "user",
        content: "Files staged into the harness filesystem:\n/session/user-input/m1/input.txt",
      },
    ]);
  });

  it("strips staged UI file parts even when no staging notice is present", async () => {
    const harness = createHarness({ host: localHost(), model });
    const session = await harness.sessions.getOrCreate({ id: "chat" });
    const messages = [
      {
        id: "m1",
        role: "user",
        parts: [
          { type: "text", text: "Review the staged file." },
          {
            type: "file",
            filename: "input.txt",
            mediaType: "text/plain",
            data: new TextEncoder().encode("file"),
          },
        ],
      },
    ] as unknown as UIMessage[];

    const result = await buildModelMessages({
      harness,
      config: harness.config,
      session,
      messages,
      stripStagedFileParts: true,
    });

    expect(result.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Review the staged file." }] },
    ]);
  });

  it("converts registered input types and applies descriptions", async () => {
    const harness = createHarness({
      host: localHost(),
      model,
      inputTypes: {
        "support.ticket_triage": inputType({
          description: "Triage one support ticket.",
          toMessages: ({ input }) => [{ role: "user", content: `Ticket: ${(input as any).id}` }],
        }),
      },
    });
    const session = await harness.sessions.getOrCreate({ id: "ticket" });
    const result = await buildModelMessages({
      harness,
      config: harness.config,
      session,
      type: "support.ticket_triage",
      input: { id: "t1" },
    });
    expect(result.messages.at(-1)?.content).toBe("Ticket: t1");
    expect(result.warnings).toEqual([]);
  });

  it("injects memory context into raw chat messages", async () => {
    await withTempDir(async (dir) => {
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        memory: memory({ sourceDir: "memory/db-query-agent" }),
      });
      const session = await harness.sessions.getOrCreate({ id: "chat-memory" });
      await session.files.writeText(
        "/persistent/memory/MEMORY.md",
        "# Memory Index\n- billing_invoices: Check invoice history before answering billing questions.\n",
      );
      const messages = [{ id: "m1", role: "user", parts: [{ type: "text", text: "Hi" }] }] as UIMessage[];

      const result = await buildModelMessages({
        harness,
        config: harness.config,
        session,
        files: session.files,
        messages,
      });

      expect(result.system).toContain("Long-term memory is mounted at /persistent/memory.");
      expect(result.system).toContain("billing_invoices");
    });
  });

  it("injects memory context into registered typed input messages", async () => {
    await withTempDir(async (dir) => {
      const harness = createHarness({
        host: localHost({ dataDir: dir }),
        model,
        memory: memory({ sourceDir: "memory/db-query-agent" }),
        inputTypes: {
          "support.ticket_triage": inputType({
            description: "Triage one support ticket.",
            toMessages: ({ input }) => [{ role: "user", content: `Ticket: ${(input as any).id}` }],
          }),
        },
      });
      const session = await harness.sessions.getOrCreate({ id: "typed-memory" });
      await session.files.writeText(
        "/persistent/memory/MEMORY.md",
        "# Memory Index\n- billing_invoices: Check invoice history before answering billing questions.\n",
      );

      const result = await buildModelMessages({
        harness,
        config: harness.config,
        session,
        files: session.files,
        type: "support.ticket_triage",
        input: { id: "t1" },
      });

      expect(result.messages.at(-1)?.content).toBe("Ticket: t1");
      expect(result.system).toContain("Long-term memory is mounted at /persistent/memory.");
      expect(result.system).toContain("billing_invoices");
    });
  });

  it("warns for undefined input types and still creates a generic user message", async () => {
    const harness = createHarness({ host: localHost(), model });
    const session = await harness.sessions.getOrCreate({ id: "job" });
    const result = await buildModelMessages({
      harness,
      config: harness.config,
      session,
      type: "unknown.kind",
      input: { ok: true },
    });
    expect(result.warnings[0]?.code).toBe("undefined_input_type");
    expect(result.messages.at(-1)?.content).toContain("unknown.kind");
  });
});

async function initRepo(repoDir: string): Promise<void> {
  await mkdir(repoDir, { recursive: true });
  await git(repoDir, ["init", "-b", "main"]);
  await git(repoDir, ["config", "user.name", "Little Harness Tests"]);
  await git(repoDir, ["config", "user.email", "tests@example.com"]);
}

async function writeRepoSkill(repoDir: string, name: string): Promise<void> {
  const skillDir = path.join(repoDir, "skills", name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} skill.\n---\n\nBody\n`,
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
