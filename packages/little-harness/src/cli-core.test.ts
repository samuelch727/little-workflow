import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "./cli-core.js";
import { localHost } from "./local-host/index.js";
import type { LocalHarnessSession } from "./local-host/session-store.js";

async function invoke(
  args: readonly string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(args, {
    cwd,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { exitCode, stdout, stderr };
}

function traceEvent(type: string, sequence: number, metadata: Record<string, unknown> = {}) {
  return {
    schemaVersion: "lh.trace.v2",
    eventId: `evt_${sequence}`,
    sequence,
    type,
    sessionId: "chat_123",
    timestamp: "2026-06-03T00:00:00.000Z",
    metadata: { ...defaultMetadata(type), ...metadata },
  };
}

function defaultMetadata(type: string): Record<string, unknown> {
  switch (type) {
    case "harness.model.called":
      return {
        stepNumber: 1,
        model: { provider: "test", modelId: "test-model" },
        request: {
          promptHash: "a".repeat(64),
          system: { captured: false },
          messages: [{ role: "user", content: { captured: false } }],
          tools: [],
        },
      };
    case "harness.model.responded":
      return {
        stepNumber: 1,
        model: { provider: "test", modelId: "test-model" },
        text: { captured: false },
      };
    case "harness.model.failed":
      return {
        stepNumber: 1,
        model: { provider: "test", modelId: "test-model" },
        durationMs: 12,
        error: { name: "Error", message: "model failed" },
      };
    case "harness.tool_call.started":
    case "harness.tool_call.succeeded":
    case "harness.tool_call.failed":
      return { toolName: "lookup", toolCallId: "call_1", caller: "model" };
    case "harness.runtime.command.started":
      return { command: "echo ok" };
    case "harness.runtime.command.succeeded":
    case "harness.runtime.command.failed":
      return {
        command: "echo ok",
        exitCode: type === "harness.runtime.command.succeeded" ? 0 : 1,
        durationMs: 12,
        stdout: { captured: false },
        stderr: { captured: false },
      };
    case "harness.runtime.error":
      return { error: { name: "Error", message: "runtime failed" } };
    case "harness.file.created":
      return {
        path: "/session/file.txt",
        root: "session",
        after: { bytes: 3, sha256: "f".repeat(64) },
        diff: { available: false, reason: "disabled" },
      };
    case "harness.file.updated":
      return {
        path: "/session/file.txt",
        root: "session",
        before: { bytes: 3, sha256: "e".repeat(64) },
        after: { bytes: 3, sha256: "f".repeat(64) },
        diff: { available: false, reason: "disabled" },
      };
    case "harness.file.deleted":
      return {
        path: "/session/file.txt",
        root: "session",
        before: { bytes: 3, sha256: "e".repeat(64) },
        diff: { available: false, reason: "content_unavailable" },
      };
    case "harness.file.staged_from_message":
    case "harness.file.staged_from_host":
      return {
        path: "/session/file.txt",
        root: "session",
        source: "user-message",
        after: { bytes: 3, sha256: "f".repeat(64) },
      };
    case "harness.file.written_by_tool":
      return {
        path: "/session/file.txt",
        root: "session",
        source: "tool",
        after: { bytes: 3, sha256: "f".repeat(64) },
        diff: { available: false, reason: "disabled" },
      };
    case "harness.artifact.created":
      return {
        path: "/artifacts/out.txt",
        artifact: { id: "/artifacts/out.txt", path: "/artifacts/out.txt" },
      };
    case "harness.filesystem.mounted":
      return {
        root: "session",
        harnessDir: "/session",
        source: "session",
        writable: true,
        fileCount: 0,
        files: [],
      };
    case "harness.persistent_dir.loaded":
      return {
        harnessDir: "/persistent/project",
        commit: "after-turn",
        durationMs: 12,
        fileCount: 0,
        files: [],
      };
    case "harness.persistent_dir.commit.started":
      return {
        harnessDir: "/persistent/project",
        commit: "after-turn",
        changeCounts: { created: 0, updated: 0, deleted: 0 },
        changes: { created: [], updated: [], deleted: [] },
      };
    case "harness.persistent_dir.commit.succeeded":
      return {
        harnessDir: "/persistent/project",
        commit: "after-turn",
        durationMs: 12,
        changeCounts: { created: 0, updated: 0, deleted: 0 },
        changes: { created: [], updated: [], deleted: [] },
      };
    case "harness.persistent_dir.commit.failed":
      return {
        harnessDir: "/persistent/project",
        commit: "after-turn",
        durationMs: 12,
        changeCounts: { created: 0, updated: 0, deleted: 0 },
        changes: { created: [], updated: [], deleted: [] },
        error: { name: "Error", message: "commit failed" },
      };
    default:
      return {};
  }
}

async function snapshotTree(root: string, current = root): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const pathname = join(current, entry.name);
    if (entry.isDirectory()) {
      Object.assign(out, await snapshotTree(root, pathname));
      continue;
    }
    if (entry.isFile()) {
      out[relative(root, pathname)] = await readFile(pathname, "utf8");
    }
  }
  return Object.fromEntries(
    Object.entries(out).sort(([left], [right]) => left.localeCompare(right)),
  );
}

describe("little-harness CLI", () => {
  it("lists sessions from a Local Host data directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "little-harness-cli-"));
    const harnessHost = localHost({ dataDir: join(dir, ".little-harness") });
    const session = await harnessHost.sessions.getOrCreate({ id: "chat_123" });
    await session.files.writeText("/artifacts/out.txt", "artifact");

    const result = await invoke(["--data-dir", join(dir, ".little-harness"), "sessions"], dir);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual([
      expect.objectContaining({ id: "chat_123", state: "idle", artifactCount: 1 }),
    ]);
  });

  it("dumps trace NDJSON for a session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "little-harness-cli-trace-"));
    const host = localHost({ dataDir: join(dir, ".little-harness") });
    const session = (await host.sessions.getOrCreate({ id: "chat_123" })) as LocalHarnessSession;
    await writeFile(
      session.paths.traceFile,
      `${JSON.stringify(traceEvent("harness.session.started", 1))}\n`,
      "utf8",
    );

    const result = await invoke(
      ["--data-dir", join(dir, ".little-harness"), "trace", "chat_123"],
      dir,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ type: "harness.session.started", sequence: 1 }),
    ]);
  });

  it("lists files and artifacts without printing file contents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "little-harness-cli-files-"));
    const host = localHost({ dataDir: join(dir, ".little-harness") });
    const session = (await host.sessions.getOrCreate({ id: "chat_123" })) as LocalHarnessSession;
    await session.files.writeText("/session/secret.txt", "secret-value");
    await session.files.writeText("/artifacts/out.txt", "artifact-value");

    const files = await invoke(["--data-dir", join(dir, ".little-harness"), "files", "chat_123"], dir);
    const artifacts = await invoke(
      ["--data-dir", join(dir, ".little-harness"), "artifacts", "chat_123"],
      dir,
    );

    expect(files.exitCode).toBe(0);
    expect(files.stdout).toContain("/session/secret.txt");
    expect(files.stdout).toContain("/artifacts/out.txt");
    expect(files.stdout).not.toContain("secret-value");
    expect(files.stdout).not.toContain("artifact-value");
    expect(artifacts.exitCode).toBe(0);
    expect(artifacts.stdout).not.toContain("artifact-value");
    expect(JSON.parse(artifacts.stdout)).toEqual([
      expect.objectContaining({ path: "/artifacts/out.txt", bytes: expect.any(Number) }),
    ]);
  });

  it("prints the latest traced diff for a file path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "little-harness-cli-diff-"));
    const host = localHost({ dataDir: join(dir, ".little-harness") });
    const session = (await host.sessions.getOrCreate({ id: "chat_123" })) as LocalHarnessSession;
    await writeFile(
      session.paths.traceFile,
      `${JSON.stringify(
        traceEvent("harness.file.updated", 1, {
          path: "/persistent/note.md",
          root: "persistent",
          diff: {
            available: true,
            format: "unified",
            preview: "@@ -1 +1\n-old\n+new\n",
            truncated: false,
          },
        }),
      )}\n`,
      "utf8",
    );

    const result = await invoke(
      [
        "--data-dir",
        join(dir, ".little-harness"),
        "diff",
        "chat_123",
        "--path",
        "/persistent/note.md",
      ],
      dir,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      path: "/persistent/note.md",
      diff: { available: true, preview: expect.stringContaining("+new") },
    });
  });

  it("resolves traced diff content refs without mutating Local Host state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "little-harness-cli-diff-content-ref-"));
    const host = localHost({ dataDir: join(dir, ".little-harness") });
    const session = (await host.sessions.getOrCreate({ id: "chat_123" })) as LocalHarnessSession;
    await session.files.writeText("/artifacts/trace/file-diffs/diff.patch", "@@ -1 +1 @@\n-old\n+large\n");
    await writeFile(
      session.paths.traceFile,
      `${JSON.stringify(
        traceEvent("harness.file.updated", 1, {
          path: "/persistent/note.md",
          root: "persistent",
          diff: {
            available: true,
            format: "unified",
            preview: "@@ -1 +1 @@\n",
            truncated: true,
            contentRef: "/artifacts/trace/file-diffs/diff.patch",
            bytes: 24,
          },
        }),
      )}\n`,
      "utf8",
    );
    const before = await snapshotTree(join(dir, ".little-harness"));

    const result = await invoke(
      [
        "--data-dir",
        join(dir, ".little-harness"),
        "diff",
        "chat_123",
        "--path",
        "/persistent/note.md",
      ],
      dir,
    );
    const after = await snapshotTree(join(dir, ".little-harness"));

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      path: "/persistent/note.md",
      diff: {
        available: true,
        contentRef: "/artifacts/trace/file-diffs/diff.patch",
        content: expect.stringContaining("+large"),
      },
    });
    expect(after).toEqual(before);
  });

  it("summarizes failed model tool and persistence events in doctor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "little-harness-cli-doctor-"));
    const host = localHost({ dataDir: join(dir, ".little-harness") });
    const session = (await host.sessions.getOrCreate({ id: "chat_123" })) as LocalHarnessSession;
    await writeFile(
      session.paths.traceFile,
      [
        JSON.stringify(traceEvent("harness.model.failed", 1, { message: "provider failed", redacted: true })),
        JSON.stringify(
          traceEvent("harness.tool_call.failed", 2, {
            toolName: "shell",
            error: { name: "Error", message: "tool failed" },
          }),
        ),
        JSON.stringify(
          traceEvent("harness.persistent_dir.commit.failed", 3, {
            harnessDir: "/persistent/project",
            error: { name: "Error", message: "commit failed" },
          }),
        ),
        JSON.stringify(
          traceEvent("harness.model.responded", 4, {
            text: {
              captured: true,
              preview: "large",
              truncated: true,
              contentRef: "/artifacts/trace/model-response/text.txt",
              bytes: 2048,
            },
          }),
        ),
        JSON.stringify(
          traceEvent("harness.tool_call.succeeded", 5, {
            spooled: {
              path: "/artifacts/tool-results/lookup/call_1.txt",
              bytes: 2048,
              sha256: "b".repeat(64),
              mediaType: "text/plain",
            },
          }),
        ),
        "{invalid json}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await invoke(
      ["--data-dir", join(dir, ".little-harness"), "doctor", "chat_123"],
      dir,
    );

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      sessionId: "chat_123",
      failureCount: 3,
      invalidEventCount: 1,
      spooledOutputCount: 1,
      contentRefCount: 1,
      largeTraceArtifactCount: 1,
      redactionCount: 1,
    });
  });

  it("aggregates outcomes into success rates that always carry their sample size", async () => {
    const dir = await mkdtemp(join(tmpdir(), "little-harness-cli-outcomes-"));
    const dataDir = join(dir, ".little-harness");
    const host = localHost({ dataDir });
    const first = (await host.sessions.getOrCreate({ id: "chat_123" })) as LocalHarnessSession;
    const second = (await host.sessions.getOrCreate({ id: "chat_456" })) as LocalHarnessSession;

    const outcome = (
      sessionId: string,
      sequence: number,
      metadata: Record<string, unknown>,
    ) =>
      JSON.stringify({
        schemaVersion: "lh.trace.v2",
        eventId: `evt_${sessionId}_${sequence}`,
        sequence,
        type: "outcome.reported",
        sessionId,
        timestamp: "2026-08-07T00:00:00.000Z",
        metadata: { source: "chat-sdk", ...metadata },
      });

    const promptA = "a".repeat(64);
    const promptB = "b".repeat(64);
    await writeFile(
      first.paths.traceFile,
      [
        JSON.stringify(traceEvent("harness.model.called", 1)),
        // A thumbs-down toggled to a thumbs-up by the same rater: both are retained, the
        // later one is authoritative.
        outcome("chat_123", 3_000_000_000_000_001, {
          status: "failure",
          promptHash: promptA,
          reportKey: "k1",
        }),
        outcome("chat_123", 3_000_000_000_000_002, {
          status: "success",
          promptHash: promptA,
          reportKey: "k1",
        }),
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      second.paths.traceFile,
      [
        outcome("chat_456", 3_000_000_000_000_003, {
          status: "failure",
          promptHash: promptA,
          reportKey: "k2",
        }),
        outcome("chat_456", 3_000_000_000_000_004, {
          status: "success",
          promptHash: promptB,
          stepPath: "root/draft",
          reportKey: "k3",
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const all = await invoke(["--data-dir", dataDir, "outcomes"], dir);
    expect(all.exitCode).toBe(0);
    expect(all.stderr).toBe("");
    expect(JSON.parse(all.stdout)).toEqual({
      sessionIds: ["chat_123", "chat_456"],
      invalidEventCount: 0,
      eventCount: 4,
      countedCount: 3,
      supersededCount: 1,
      retractedCount: 0,
      clearedCount: 0,
      overall: { n: 3, success: 2, failure: 1, partial: 0, successRate: 2 / 3 },
      byPromptHash: [
        { key: promptA, n: 2, success: 1, failure: 1, partial: 0, successRate: 0.5 },
        { key: promptB, n: 1, success: 1, failure: 0, partial: 0, successRate: 1 },
      ],
      byStepPath: [
        { key: "root/draft", n: 1, success: 1, failure: 0, partial: 0, successRate: 1 },
      ],
      unattributed: { withoutPromptHash: 0, withoutStepPath: 2 },
    });

    const scoped = await invoke(["--data-dir", dataDir, "outcomes", "chat_123"], dir);
    expect(JSON.parse(scoped.stdout)).toMatchObject({
      sessionIds: ["chat_123"],
      eventCount: 2,
      countedCount: 1,
      overall: { n: 1, success: 1, failure: 0, partial: 0, successRate: 1 },
    });
  });

  it("reports an empty outcome sample as a null rate, never a fabricated zero", async () => {
    const dir = await mkdtemp(join(tmpdir(), "little-harness-cli-outcomes-empty-"));
    const dataDir = join(dir, ".little-harness");
    localHost({ dataDir });

    const result = await invoke(["--data-dir", dataDir, "outcomes"], dir);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      eventCount: 0,
      overall: { n: 0, successRate: null },
    });
  });

  it("does not count generic content refs as spooled tool outputs in doctor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "little-harness-cli-doctor-spooled-"));
    const host = localHost({ dataDir: join(dir, ".little-harness") });
    const session = (await host.sessions.getOrCreate({ id: "chat_123" })) as LocalHarnessSession;
    await writeFile(
      session.paths.traceFile,
      [
        JSON.stringify(
          traceEvent("harness.model.responded", 1, {
            text: {
              captured: true,
              truncated: true,
              contentRef: "/artifacts/trace/model-response/text.txt",
              bytes: 2048,
            },
          }),
        ),
        JSON.stringify(
          traceEvent("harness.file.updated", 2, {
            diff: {
              available: true,
              format: "unified",
              preview: "@@ -1 +1 @@\n",
              truncated: true,
              contentRef: "/artifacts/trace/file-diffs/diff.patch",
              bytes: 24,
            },
          }),
        ),
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await invoke(
      ["--data-dir", join(dir, ".little-harness"), "doctor", "chat_123"],
      dir,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      spooledOutputCount: 0,
      contentRefCount: 2,
    });
  });

  it("groups pretty trace output by turn step and tool call", async () => {
    const dir = await mkdtemp(join(tmpdir(), "little-harness-cli-pretty-"));
    const host = localHost({ dataDir: join(dir, ".little-harness") });
    const session = (await host.sessions.getOrCreate({ id: "chat_123" })) as LocalHarnessSession;
    await writeFile(
      session.paths.traceFile,
      [
        JSON.stringify({ ...traceEvent("harness.model.called", 1), turnId: "turn_1", stepId: "step_1" }),
        JSON.stringify({
          ...traceEvent("harness.tool_call.started", 2, { toolName: "lookup", toolCallId: "call_1" }),
          turnId: "turn_1",
          stepId: "step_1",
        }),
        JSON.stringify({
          ...traceEvent("harness.tool_call.succeeded", 3, { toolName: "lookup", toolCallId: "call_1" }),
          turnId: "turn_1",
          stepId: "step_1",
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await invoke(
      ["--data-dir", join(dir, ".little-harness"), "trace", "chat_123", "--format", "pretty"],
      dir,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("turn turn_1");
    expect(result.stdout).toContain("  step step_1");
    expect(result.stdout).toContain("    tool call_1 lookup");
    expect(result.stdout).toContain("      3  harness.tool_call.succeeded");
    expect(result.stdout).toContain("2026-06-03T00:00:00.000Z");
  });

  it("does not mutate Local Host state while inspecting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "little-harness-cli-readonly-"));
    const host = localHost({ dataDir: join(dir, ".little-harness") });
    const session = (await host.sessions.getOrCreate({ id: "chat_123" })) as LocalHarnessSession;
    await session.files.writeText("/session/input.txt", "input");
    await session.files.writeText("/artifacts/out.txt", "output");
    await writeFile(
      session.paths.traceFile,
      [
        JSON.stringify(traceEvent("harness.session.started", 1)),
        JSON.stringify(
          traceEvent("harness.file.updated", 2, {
            path: "/session/input.txt",
            diff: {
              available: true,
              format: "unified",
              preview: "@@ -1 +1\n-old\n+input\n",
              truncated: false,
            },
          }),
        ),
        "",
      ].join("\n"),
      "utf8",
    );

    const before = await snapshotTree(join(dir, ".little-harness"));
    await invoke(["--data-dir", join(dir, ".little-harness"), "sessions"], dir);
    await invoke(["--data-dir", join(dir, ".little-harness"), "trace", "chat_123"], dir);
    await invoke(["--data-dir", join(dir, ".little-harness"), "files", "chat_123"], dir);
    await invoke(["--data-dir", join(dir, ".little-harness"), "artifacts", "chat_123"], dir);
    await invoke(
      [
        "--data-dir",
        join(dir, ".little-harness"),
        "diff",
        "chat_123",
        "--path",
        "/session/input.txt",
      ],
      dir,
    );
    await invoke(["--data-dir", join(dir, ".little-harness"), "doctor", "chat_123"], dir);
    const after = await snapshotTree(join(dir, ".little-harness"));

    expect(after).toEqual(before);
  });

  it("keeps cli.ts as a thin binary wrapper", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./cli.ts", import.meta.url), "utf8"),
    );
    expect(source).toContain("#!/usr/bin/env node");
    expect(source).toContain('import { runCli } from "./cli-core.js";');
  });
});
