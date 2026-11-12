import { validateTraceEvent } from "../trace/validate.js";
import { expect, it } from "vitest";
import { createShellRuntime } from "./shell-runtime.js";
import { resolveTraceOptions } from "../trace/options.js";
import type { FileWriter, HarnessEventInput } from "../types.js";

it.each(["provider", "absent", "empty"])("exactly pairs overlapping identical commands (provider IDs: %s) without adding captured content", async mode => {
  const events: HarnessEventInput[] = [];
  const waiting: { id: string; finish: (exitCode: number) => void }[] = [];
  const runtime = createShellRuntime({
    workspace: { sessionId: "session", workingDir: "/session", mounts: [] },
    files: {} as FileWriter,
    traceOptions: resolveTraceOptions(false, undefined),
    emitToolEvents: false,
    emit: async event => {
      validateTraceEvent({ schemaVersion: "lh.trace.v2", eventId: `event-${events.length}`, sequence: events.length + 1, sessionId: "session", timestamp: new Date().toISOString(), ...event });
      events.push(event);
    },
    execute: async (_input, context) => new Promise(resolve => waiting.push({ id: context.executionId,
      finish: exitCode => resolve({ exitCode, stdout: "private stdout", stderr: "private stderr" }),
    })),
  });
  const tool = runtime.shellTool() as { execute(input: { command: string }, options: { toolCallId?: string; executionId?: string }): Promise<unknown> };
  const supplied = { executionId: "caller-reused-attempt" };
  const a = tool.execute({ command: "identical" }, { ...supplied, ...(mode === "provider" ? { toolCallId: "call-a" } : mode === "empty" ? { toolCallId: "" } : {}) });
  const b = tool.execute({ command: "identical" }, { ...supplied, ...(mode === "provider" ? { toolCallId: "call-b" } : mode === "empty" ? { toolCallId: "" } : {}) });
  await expect.poll(() => waiting.length).toBe(2);
  waiting[1]!.finish(1); await b; waiting[0]!.finish(0); await a;
  const starts = events.filter(event => event.type === "harness.runtime.command.started");
  const finishes = events.filter(event => event.type !== "harness.runtime.command.started");
  expect(starts).toHaveLength(2); expect(finishes).toHaveLength(2);
  expect(new Set(starts.map(event => event.metadata!.executionId)).size).toBe(2);
  expect(starts.every(event => event.metadata!.executionId !== supplied.executionId)).toBe(true);
  for (const start of starts) {
    const end = finishes.find(event => event.metadata!.executionId === start.metadata!.executionId)!;
    expect(end).toBeDefined(); expect(end.metadata!.toolCallId).toBe(start.metadata!.toolCallId);
    expect(end.occurrenceId).toBe(start.occurrenceId); expect(start.occurrenceId).toBe(start.metadata!.executionId);
    expect(end.metadata!.stdout).toMatchObject({ captured: false });
    expect(end.metadata!.stderr).toMatchObject({ captured: false });
  }
  expect(finishes.map(event => event.metadata!.executionId)).toEqual([waiting[1]!.id, waiting[0]!.id]);
  expect(starts.map(event => event.metadata!.toolCallId)).toEqual(mode === "provider" ? ["call-a", "call-b"] : ["runtime_bash", "runtime_bash"]);
  expect(JSON.stringify(events)).not.toContain("private stdout"); expect(JSON.stringify(events)).not.toContain("private stderr");
});

it("links re-executed attempts by tool ID while keeping attempt occurrence IDs distinct", async () => {
  const events: HarnessEventInput[] = [];
  const contexts: { executionId: string; toolCallId: string }[] = [];
  const runtime = createShellRuntime({
    workspace: { sessionId: "session", workingDir: "/session", mounts: [] }, files: {} as FileWriter,
    traceOptions: resolveTraceOptions(false, undefined), emitToolEvents: false,
    emit: async event => {
      validateTraceEvent({ schemaVersion: "lh.trace.v2", eventId: `event-${events.length}`, sequence: events.length + 1, sessionId: "session", timestamp: new Date().toISOString(), ...event });
      events.push(event);
    },
    execute: async (_input, context) => { contexts.push(context); return { stdout: "", stderr: "", exitCode: 0 }; },
  });
  const tool = runtime.shellTool() as { execute(input: { command: string }, options: { toolCallId: string; executionId?: string }): Promise<unknown> };
  await tool.execute({ command: "same" }, { toolCallId: "recorded-call" });
  await tool.execute({ command: "same" }, { toolCallId: "recorded-call" });
  expect(contexts[0]!.toolCallId).toBe(contexts[1]!.toolCallId);
  expect(contexts[0]!.executionId).not.toBe(contexts[1]!.executionId);
  await tool.execute({ command: "same" }, { toolCallId: "recorded-call", executionId: contexts[0]!.executionId });
  expect(new Set(contexts.map(context => context.executionId)).size).toBe(3);
  expect(events.at(-1)!.occurrenceId).toBe(contexts[2]!.executionId);
});
