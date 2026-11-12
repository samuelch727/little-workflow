import { describe, expect, it } from "vitest";
import { validateTraceEvent } from "./validate.js";

const baseEvent = {
  schemaVersion: "lh.trace.v2",
  eventId: "evt_1",
  sequence: 1,
  sessionId: "chat_123",
  timestamp: "2026-06-03T00:00:00.000Z",
} as const;

const contentRef = {
  captured: true,
  preview: "hello",
  truncated: false,
  bytes: 5,
  sha256: "a".repeat(64),
  mediaType: "text/plain",
};

describe("validateTraceEvent", () => {
  it("accepts honest storage-limit omissions and rejects contradictory content evidence", () => {
    const unavailable = { ...contentRef, captured: false, truncated: true, bytes: 20, unavailableReason: "storage_limit", storageLimitBytes: 10 };
    const event = (text: object) => ({ ...baseEvent, type: "harness.model.responded", metadata: { stepNumber: 1, model: { provider: "test", modelId: "test" }, text } });
    expect(validateTraceEvent(event(unavailable)).metadata?.text).toEqual(unavailable);
    for (const changed of [{ captured: true }, { contentRef: "/artifacts/trace/phantom.txt" }, { truncated: false }, { bytes: 10 }, { storageLimitBytes: undefined }]) {
      expect(() => validateTraceEvent(event({ ...unavailable, ...changed }))).toThrow(/Unavailable trace content/u);
    }
  });

  it("accepts a versioned Little Harness trace event", () => {
    expect(
      validateTraceEvent({
        ...baseEvent,
        type: "harness.model.called",
        turnId: "turn_123",
        stepId: "step_1",
        metadata: {
          stepNumber: 1,
          model: { provider: "test", modelId: "test-model" },
          request: {
            promptHash: "b".repeat(64),
            system: contentRef,
            messages: [{ role: "user", content: contentRef }],
            tools: [{ toolName: "lookup", descriptionHash: "c".repeat(64) }],
          },
        },
      }),
    ).toEqual({
      ...baseEvent,
      type: "harness.model.called",
      turnId: "turn_123",
      stepId: "step_1",
      metadata: {
        stepNumber: 1,
        model: { provider: "test", modelId: "test-model" },
        request: {
          promptHash: "b".repeat(64),
          system: contentRef,
          messages: [{ role: "user", content: contentRef }],
          tools: [{ toolName: "lookup", descriptionHash: "c".repeat(64) }],
        },
      },
    });
  });

  it("rejects events with missing envelope fields", () => {
    expect(() =>
      validateTraceEvent({
        type: "harness.model.called",
        sessionId: "chat_123",
        timestamp: "2026-06-03T00:00:00.000Z",
      }),
    ).toThrow(/schemaVersion/);
  });

  it("rejects legacy trace schema versions", () => {
    expect(() =>
      validateTraceEvent({
        ...baseEvent,
        schemaVersion: "lh.trace.v1",
        type: "harness.session.started",
      }),
    ).toThrow(/schemaVersion/);
  });

  it("rejects empty occurrence ids when present", () => {
    expect(() =>
      validateTraceEvent({
        ...baseEvent,
        type: "harness.session.started",
        occurrenceId: "",
      }),
    ).toThrow(/occurrenceId/);
  });

  it("rejects unknown event types", () => {
    expect(() =>
      validateTraceEvent({
        ...baseEvent,
        type: "workflow.started",
        metadata: {},
      }),
    ).toThrow(/type/);
  });

  it("rejects legacy /skills filesystem mount metadata", () => {
    expect(() =>
      validateTraceEvent({
        ...baseEvent,
        type: "harness.filesystem.mounted",
        metadata: {
          root: "skills",
          harnessDir: "/skills",
          source: "skill",
          writable: false,
          fileCount: 0,
          files: [],
        },
      }),
    ).toThrow(/root|Invalid option/u);
  });

  it("accepts workflow execute-step trace events", () => {
    expect(
      validateTraceEvent({
        ...baseEvent,
        type: "harness.execute_step.started",
        metadata: {
          runId: "run_1",
          stepPath: "draft",
          stepId: "draft",
          uses: "ai.generate",
        },
      }),
    ).toMatchObject({
      type: "harness.execute_step.started",
      metadata: { stepPath: "draft", uses: "ai.generate" },
    });
  });

  it("accepts tool calls initiated by workflow code", () => {
    expect(
      validateTraceEvent({
        ...baseEvent,
        type: "harness.tool_call.started",
        metadata: {
          toolName: "lookup",
          toolCallId: "call_code_1",
          caller: "code",
          input: contentRef,
        },
      }),
    ).toMatchObject({
      type: "harness.tool_call.started",
      metadata: { toolName: "lookup", toolCallId: "call_code_1", caller: "code" },
    });
  });

  it("rejects malformed required metadata by event family", () => {
    const malformedEvents = [
      {
        type: "harness.model.responded",
        metadata: { stepNumber: 1, model: {}, text: { preview: "missing captured" } },
        expected: /captured/,
      },
      {
        type: "harness.tool_call.started",
        metadata: { toolCallId: "call_1" },
        expected: /toolName/,
      },
      {
        type: "harness.runtime.command.succeeded",
        metadata: { command: "echo ok", exitCode: "0", stdout: contentRef, stderr: contentRef },
        expected: /exitCode/,
      },
      {
        type: "harness.runtime.command.succeeded",
        metadata: { command: "echo ok", exitCode: 0, stdout: contentRef, stderr: contentRef },
        expected: /durationMs/,
      },
      {
        type: "harness.file.updated",
        metadata: {
          path: "/session/a.txt",
          diff: { available: true, preview: "@@ -1 +1\n-old\n+new\n" },
        },
        expected: /format/,
      },
      {
        type: "harness.artifact.created",
        metadata: { path: "/artifacts/out.txt", artifact: { id: "artifact_1" } },
        expected: /artifact/,
      },
      {
        type: "harness.filesystem.mounted",
        metadata: { root: "session", harnessDir: "/session", source: "session", writable: true, files: [] },
        expected: /fileCount/,
      },
      {
        type: "harness.persistent_dir.commit.started",
        metadata: { harnessDir: "/persistent/project", commit: "automatic" },
        expected: /commit/,
      },
      {
        type: "harness.persistent_dir.loaded",
        metadata: { harnessDir: "/persistent/project", commit: "after-turn" },
        expected: /fileCount/,
      },
      {
        type: "harness.persistent_dir.commit.succeeded",
        metadata: { harnessDir: "/persistent/project", commit: "after-turn" },
        expected: /changeCounts/,
      },
    ] as const;

    for (const event of malformedEvents) {
      expect(() =>
        validateTraceEvent({
          ...baseEvent,
          type: event.type,
          metadata: event.metadata,
        }),
      ).toThrow(event.expected);
    }
  });

  it("validates TraceContentRef, TraceFileDiff, and TraceErrorEnvelope shapes when present", () => {
    expect(
      validateTraceEvent({
        ...baseEvent,
        type: "harness.runtime.command.failed",
        metadata: {
          command: "cat missing",
          exitCode: 1,
          durationMs: 12,
          stdout: { ...contentRef, contentRef: "/artifacts/trace/runtime/stdout.txt" },
          stderr: { ...contentRef, preview: "missing", bytes: 7 },
          error: {
            name: "Error",
            message: "failed",
            cause: { exitCode: 1 },
          },
        },
      }),
    ).toMatchObject({ metadata: { error: { name: "Error", message: "failed" } } });

    expect(() =>
      validateTraceEvent({
        ...baseEvent,
        type: "harness.tool_call.failed",
        metadata: {
          toolName: "lookup",
          toolCallId: "call_1",
          caller: "model",
          output: { captured: true, contentRef: "/session/not-trace.txt" },
        },
      }),
    ).toThrow(/contentRef/);

    expect(() =>
      validateTraceEvent({
        ...baseEvent,
        type: "harness.tool_call.succeeded",
        metadata: {
          toolName: "lookup",
          toolCallId: "call_1",
          caller: "model",
          output: { ...contentRef, content: "raw secret" },
        },
      }),
    ).toThrow(/content|Unrecognized/);

    expect(() =>
      validateTraceEvent({
        ...baseEvent,
        type: "harness.file.updated",
        metadata: {
          path: "/persistent/note.md",
          diff: {
            available: false,
            reason: "missing",
          },
        },
      }),
    ).toThrow(/reason/);

    expect(() =>
      validateTraceEvent({
        ...baseEvent,
        type: "harness.runtime.error",
        metadata: {
          error: { name: "Error" },
        },
      }),
    ).toThrow(/message/);
  });

  it("rejects tool and file events that drift from required telemetry metadata", () => {
    expect(() =>
      validateTraceEvent({
        ...baseEvent,
        type: "harness.tool_call.started",
        metadata: { toolName: "lookup", toolCallId: "call_1" },
      }),
    ).toThrow(/caller/);

    expect(() =>
      validateTraceEvent({
        ...baseEvent,
        type: "harness.tool_call.started",
        metadata: { toolName: "lookup", caller: "model" },
      }),
    ).toThrow(/toolCallId/);

    expect(() =>
      validateTraceEvent({
        ...baseEvent,
        type: "harness.file.deleted",
        metadata: { path: "/persistent/note.md", root: "persistent" },
      }),
    ).toThrow(/before/);

    expect(() =>
      validateTraceEvent({
        ...baseEvent,
        type: "harness.file.written_by_tool",
        metadata: { path: "/artifacts/out.txt", root: "artifacts", source: "tool" },
      }),
    ).toThrow(/after/);
  });

  it("rejects permissive metadata that violates the alpha event spec", () => {
    expect(
      validateTraceEvent({
        ...baseEvent,
        type: "harness.tool_call.succeeded",
        metadata: {
          toolName: "lookup",
          toolCallId: "call_1",
          caller: "model",
          spooled: {
            path: "/artifacts/custom-tool-output/lookup/call_1.txt",
            bytes: 12,
            sha256: "d".repeat(64),
          },
        },
      }),
    ).toMatchObject({
      metadata: {
        spooled: { path: "/artifacts/custom-tool-output/lookup/call_1.txt" },
      },
    });

    expect(
      validateTraceEvent({
        ...baseEvent,
        type: "harness.filesystem.mounted",
        metadata: {
          root: "agents",
          harnessDir: "/.agents",
          source: "skill",
          writable: false,
          fileCount: 1,
          files: [
            {
              path: "/.agents/skills/report/SKILL.md",
              kind: "file",
              bytes: 12,
              sha256: "e".repeat(64),
              mediaType: "text/plain",
            },
          ],
        },
      }),
    ).toMatchObject({
      metadata: {
        files: [{ path: "/.agents/skills/report/SKILL.md", sha256: "e".repeat(64), mediaType: "text/plain" }],
      },
    });

    expect(() =>
      validateTraceEvent({
        ...baseEvent,
        type: "harness.filesystem.mounted",
        metadata: {
          root: "session",
          harnessDir: "/session",
          source: "session",
          writable: true,
          fileCount: 1,
          files: [{ path: "/session/secret.txt", kind: "file", bytes: 6, content: "secret" }],
        },
      }),
    ).toThrow(/content|Unrecognized/);

    expect(() =>
      validateTraceEvent({
        ...baseEvent,
        type: "harness.filesystem.mounted",
        metadata: {
          root: "session",
          harnessDir: "/session",
          source: "session",
          writable: true,
          fileCount: 1,
          files: [{ path: "/persistent/note.md", kind: "file", bytes: 4 }],
        },
      }),
    ).toThrow(/files|path/);

    expect(() =>
      validateTraceEvent({
        ...baseEvent,
        type: "harness.file.created",
        metadata: {
          path: "/persistent/note.md",
          root: "session",
          after: { bytes: 1, sha256: "a".repeat(64) },
          diff: { available: false, reason: "disabled" },
        },
      }),
    ).toThrow(/path|root/);

    // Custom workspace mounts are valid roots, but the path must still belong to them.
    expect(() =>
      validateTraceEvent({
        ...baseEvent,
        type: "harness.file.created",
        metadata: {
          path: "/elsewhere/outside.txt",
          root: "tmp",
          after: { bytes: 1, sha256: "a".repeat(64) },
          diff: { available: false, reason: "disabled" },
        },
      }),
    ).toThrow(/root/);

    for (const metadata of [
      // A custom mount at /agents must not be conflated with the managed /.agents root…
      { path: "/agents/plan.md", root: "agents" },
      // …while the historical managed shape keeps validating.
      { path: "/.agents/skills/x.md", root: "agents" },
      { path: "/data/report.csv", root: "data" },
    ]) {
      expect(() =>
        validateTraceEvent({
          ...baseEvent,
          type: "harness.file.created",
          metadata: {
            ...metadata,
            after: { bytes: 1, sha256: "a".repeat(64) },
            diff: { available: false, reason: "disabled" },
          },
        }),
      ).not.toThrow();
    }

    expect(() =>
      validateTraceEvent({
        ...baseEvent,
        type: "harness.tool_call.failed",
        metadata: { toolName: "lookup", toolCallId: "call_1", caller: "model" },
      }),
    ).toThrow(/error/);

    expect(() =>
      validateTraceEvent({
        ...baseEvent,
        type: "harness.model.failed",
        metadata: { message: "provider failed" },
      }),
    ).toThrow(/error|durationMs/);

    expect(() =>
      validateTraceEvent({
        ...baseEvent,
        type: "harness.tool_call.failed",
        metadata: {
          toolName: "lookup",
          toolCallId: "call_1",
          caller: "model",
          error: "lookup failed",
        },
      }),
    ).toThrow(/error/);

    expect(() =>
      validateTraceEvent({
        ...baseEvent,
        type: "harness.tool_call.succeeded",
        metadata: {
          toolName: "lookup",
          toolCallId: "call_1",
          caller: "model",
          spooled: { path: "/session/raw-output.txt", bytes: "12" },
        },
      }),
    ).toThrow(/spooled/);

    for (const path of ["/session/raw-output.txt", "/persistent/raw-output.txt"]) {
      expect(() =>
        validateTraceEvent({
          ...baseEvent,
          type: "harness.tool_call.succeeded",
          metadata: {
            toolName: "lookup",
            toolCallId: "call_1",
            caller: "model",
            spooled: {
              path,
              bytes: 12,
              sha256: "d".repeat(64),
            },
          },
        }),
      ).toThrow(/spooled/);
    }

    expect(() =>
      validateTraceEvent({
        ...baseEvent,
        type: "harness.persistent_dir.commit.failed",
        metadata: { harnessDir: "/persistent/project", commit: "after-turn" },
      }),
    ).toThrow(/error/);
  });

  it("accepts tier events with their escalation cause, and requires the cause", () => {
    expect(
      validateTraceEvent({
        ...baseEvent,
        type: "harness.runtime.tier.escalated",
        metadata: {
          from: "tier-0",
          to: "next-tier",
          trigger: "classification",
          command: "cargo build",
          decision: "escalate",
          reasons: [{ kind: "needs-real-exec", command: "cargo", reason: "build-toolchain" }],
        },
      }),
    ).toMatchObject({ metadata: { trigger: "classification" } });

    expect(
      validateTraceEvent({
        ...baseEvent,
        type: "harness.runtime.tier.unavailable",
        metadata: {
          from: "tier-0",
          to: "next-tier",
          trigger: "emulation-gap",
          command: "sh ./build.sh",
          gap: { kind: "emulation-gap", signal: "command-not-found", command: "cargo" },
          detail: "no higher execution tier is configured",
        },
      }),
    ).toMatchObject({ metadata: { detail: "no higher execution tier is configured" } });

    // Escalation telemetry is only useful if it says what triggered it.
    expect(() =>
      validateTraceEvent({
        ...baseEvent,
        type: "harness.runtime.tier.escalated",
        metadata: { from: "tier-0", to: "next-tier", command: "cargo build" },
      }),
    ).toThrow(/trigger/);

    expect(() =>
      validateTraceEvent({
        ...baseEvent,
        type: "harness.runtime.command.denied",
        metadata: { command: "docker ps" },
      }),
    ).toThrow(/reasons/);
  });

  it("accepts the turn's usage event, and requires the tier and the sandbox's active time", () => {
    expect(
      validateTraceEvent({
        ...baseEvent,
        type: "harness.runtime.usage",
        metadata: {
          tier: "next-tier",
          commands: { tier0: 2, nextTier: 1, denied: 0 },
          escalations: 1,
          sandbox: { provider: "cloudflare-sandbox", instanceType: "standard-1", vcpu: 0.5, memoryGiB: 4, activeMs: 300000, awakeMs: 900000, costUsd: 0.0125 },
        },
      }),
    ).toMatchObject({ metadata: { tier: "next-tier", sandbox: { provider: "cloudflare-sandbox" } } });

    expect(
      validateTraceEvent({
        ...baseEvent,
        type: "harness.runtime.usage",
        metadata: { tier: "tier-0", commands: { tier0: 4, nextTier: 0, denied: 0 }, escalations: 0, sandbox: { provider: "just-bash", activeMs: 31 } },
      }).metadata,
    ).toMatchObject({ tier: "tier-0" });

    expect(() =>
      validateTraceEvent({
        ...baseEvent,
        type: "harness.runtime.usage",
        metadata: { tier: "tier-1", commands: { tier0: 0, nextTier: 0, denied: 0 }, escalations: 0, sandbox: { provider: "x", activeMs: 1 } },
      }),
    ).toThrow(/tier/);
    expect(() =>
      validateTraceEvent({
        ...baseEvent,
        type: "harness.runtime.usage",
        metadata: { tier: "tier-0", commands: { tier0: 0, nextTier: 0, denied: 0 }, escalations: 0, sandbox: { provider: "x" } },
      }),
    ).toThrow(/activeMs/);
  });
});

it.each(["harness.runtime.command.started", "harness.runtime.command.succeeded", "harness.runtime.command.failed", "harness.runtime.command.denied"])("keeps old %s traces readable and validates additive exact IDs", type => {
  const metadata = { command: "echo synthetic", ...(type.endsWith("denied") ? { reasons: [] } : type.endsWith("started") ? {} : {
    exitCode: 0, durationMs: 1, stdout: { captured: false }, stderr: { captured: false },
  }) };
  expect(() => validateTraceEvent({ ...baseEvent, type, metadata })).not.toThrow();
  expect(() => validateTraceEvent({ ...baseEvent, type, occurrenceId: "exec-id", metadata: { ...metadata, executionId: "exec-id", toolCallId: "call-id" } })).not.toThrow();
  expect(() => validateTraceEvent({ ...baseEvent, type, metadata: { ...metadata, executionId: 123 } })).toThrow();
  expect(() => validateTraceEvent({ ...baseEvent, type, metadata: { ...metadata, toolCallId: "" } })).toThrow();
});

it.each(["harness.runtime.tier.escalated", "harness.runtime.tier.unavailable"])("accepts historical %s and validates invocation links when present", type => {
  const metadata = { from: "tier-0", to: "next-tier", trigger: "classification", command: "cargo build", ...(type.endsWith("unavailable") ? { detail: "unavailable" } : {}) };
  expect(() => validateTraceEvent({ ...baseEvent, type, metadata })).not.toThrow();
  expect(() => validateTraceEvent({ ...baseEvent, type, occurrenceId: "attempt", metadata: { ...metadata, executionId: "attempt", toolCallId: "call" } })).not.toThrow();
  expect(() => validateTraceEvent({ ...baseEvent, type, metadata: { ...metadata, executionId: "" } })).toThrow();
  expect(() => validateTraceEvent({ ...baseEvent, type, metadata: { ...metadata, toolCallId: 12 } })).toThrow();
});
