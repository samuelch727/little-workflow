import { MockLanguageModelV3 } from "ai/test";
import { expect, it } from "vitest";
import { createHarness } from "../create-harness.js";
import { localHost } from "../local-host/index.js";
import { inMemorySessionLog } from "../remote-session/session-log-store.js";
import { createShellRuntime } from "../runtime/shell-runtime.js";
import { withTempDir } from "../test/temp.js";
import type { HarnessEvent, HarnessSandboxFactory } from "../types.js";
import { generateHarness } from "./generate-harness.js";
import { streamHarness } from "./stream-harness.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function shellModel(commands: readonly string[]) {
  const calls = commands.map((command, index) => ({
    type: "tool-call" as const, toolName: "bash", toolCallId: `bash-${index}`, input: JSON.stringify({ command }),
  }));
  return new MockLanguageModelV3({
    doGenerate: async ({ prompt }) => prompt.some(message => message.role === "tool")
      ? { content: [{ type: "text", text: "done" }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] }
      : { content: calls, finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage, warnings: [] },
    doStream: async ({ prompt }) => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (prompt.some(message => message.role === "tool")) {
            controller.enqueue({ type: "text-start", id: "text" });
            controller.enqueue({ type: "text-delta", id: "text", delta: "done" });
            controller.enqueue({ type: "text-end", id: "text" });
            controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
          } else {
            calls.forEach(call => controller.enqueue(call));
            controller.enqueue({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage });
          }
          controller.close();
        },
      }),
    }),
  });
}

it.each([
  ["generate", true], ["generate", false], ["stream", true], ["stream", false],
] as const)("%s keeps both shell attempts traced with an actual session log (identical commands: %s)", async (api, identical) => {
  await withTempDir(async dir => {
    const log = inMemorySessionLog();
    const events: HarnessEvent[] = [];
    const executed: { command: string; executionId: string }[] = [];
    const sandbox: HarnessSandboxFactory = async options => {
      const runtime = createShellRuntime({
        workspace: options.workspace, files: options.files, emit: options.emit,
        traceOptions: options.traceOptions, emitToolEvents: false,
        execute: async (input, context) => {
          executed.push({ command: input.command, executionId: context.executionId });
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      });
      const shell = runtime.shellTool() as any;
      return {
        ...runtime,
        shellTool: () => ({ ...shell, execute: (input: unknown, executeOptions: object) =>
          shell.execute(input, { ...executeOptions, toolCallId: "embedded-call", executionId: "caller-reused-attempt" }),
        }),
      };
    };
    const commands = ["echo one", identical ? "echo one" : "echo two"];
    const harness = createHarness({
      host: localHost({ dataDir: dir, sandbox }), model: shellModel(commands), sessionLog: log,
      onEvent: event => { events.push(event); },
    });
    const options = { harness, session: "shell-attempts", runId: "run-shell-attempts", prompt: "Run both commands." };
    const result = await (api === "generate" ? generateHarness(options) : streamHarness(options).finished);
    expect(result.status).toBe("completed");
    expect(executed.map(call => call.command).sort()).toEqual([...commands].sort());
    const starts = events.filter(event => event.type === "harness.runtime.command.started");
    const ends = events.filter(event => event.type === "harness.runtime.command.succeeded");
    expect(starts).toHaveLength(2); expect(ends).toHaveLength(2);
    // Runtime lifecycle events currently carry metadata only: neither call is a durable append.
    expect(log.events.filter(event => event.type.startsWith("harness.runtime.command."))).toHaveLength(0);
    expect(log.events.filter(event => event.type === "harness.tool_call.succeeded" && event.payload?.toolName === "bash")).toHaveLength(2);
    expect(new Set(starts.map(event => event.occurrenceId)).size).toBe(2);
    for (const start of starts) {
      expect(start.occurrenceId).not.toBe("caller-reused-attempt");
      const end = ends.find(event => event.occurrenceId === start.occurrenceId)!;
      expect(end).toBeDefined(); expect(end.metadata!.executionId).toBe(start.metadata!.executionId);
      expect(executed.find(call => call.executionId === start.occurrenceId)?.command).toBe(start.metadata!.command);
    }
  });
});
