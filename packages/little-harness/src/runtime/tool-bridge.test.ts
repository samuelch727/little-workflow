import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { findToolReplay, type DurableHarnessEvent } from "../events/durability.js";
import { localHost } from "../local-host/index.js";
import { withTempDir } from "../test/temp.js";
import { resolveTraceOptions } from "../trace/options.js";
import type {
  HarnessEvent,
  HarnessEventInput,
  HarnessRuntimeToolReplay,
  HarnessSession,
  HarnessToolExecutionContext,
} from "../types.js";
import { createRuntimeToolBridge } from "./tool-bridge.js";

const RUNTIME_TOOL_NO_ARGS = { type: "harness.runtime_tool.no_args" };

function runtimeToolArgs(value: unknown): { type: "harness.runtime_tool.args"; value: unknown } {
  return { type: "harness.runtime_tool.args", value };
}

describe("createRuntimeToolBridge", () => {
  it("invokes configured tools and emits started/succeeded runtime events", async () => {
    await withTempDir(async (dir) => {
      const { bridge, events, session } = await setupBridge(dir, {
        tools: {
          lookup: tool({
            description: "Look up a value.",
            inputSchema: z.object({ id: z.string() }),
            execute: async ({ id }, ctx: any) => {
              await ctx.files.writeJSON("/artifacts/lookups/result.json", {
                id,
                sessionId: ctx.session.id,
              });
              return { id, sessionId: ctx.session.id };
            },
          }),
          alpha: tool({
            description: "Sort before lookup.",
            inputSchema: z.object({}),
            execute: async () => ({ ok: true }),
          }),
          bash: tool({
            description: "Shell is not exposed through the bridge.",
            inputSchema: z.object({ command: z.string() }),
            execute: async () => ({ ignored: true }),
          }),
        },
      });

      expect(bridge?.toolNames).toEqual(["alpha", "lookup"]);

      const result = await bridge!.invokeTool("lookup", "{\"id\":\"acct_1\"}");

      expect(result).toBe(JSON.stringify({ id: "acct_1", sessionId: "chat" }));
      expect((await session.files.read("/artifacts/lookups/result.json")).json()).toEqual({
        id: "acct_1",
        sessionId: "chat",
      });
      expect(events).toHaveLength(2);
      expect(events[0]?.occurrenceId).toBe(events[0]?.payload?.callId);
      expect(events[0]).toMatchObject({
        type: "harness.tool_call.started",
        payload: {
          caller: "runtime",
          toolName: "lookup",
          args: runtimeToolArgs({ id: "acct_1" }),
          callIndex: 1,
        },
        metadata: {
          caller: "runtime",
          toolName: "lookup",
          input: expect.objectContaining({ captured: true }),
        },
      });
      expect(events[0]?.payload?.callId).toEqual(events[0]?.metadata?.toolCallId);
      expect(events[1]?.occurrenceId).toBe(events[1]?.payload?.callId);
      expect(events[1]).toMatchObject({
        type: "harness.tool_call.succeeded",
        payload: {
          caller: "runtime",
          toolName: "lookup",
          args: runtimeToolArgs({ id: "acct_1" }),
          callIndex: 1,
          result: { id: "acct_1", sessionId: "chat" },
        },
        metadata: {
          caller: "runtime",
          toolName: "lookup",
          output: expect.objectContaining({ captured: true }),
        },
      });
      expect(events[1]?.payload?.callId).toEqual(events[0]?.payload?.callId);
    });
  });

  it("assigns increasing call indexes for repeated identical runtime calls", async () => {
    await withTempDir(async (dir) => {
      const { bridge, events } = await setupBridge(dir, {
        tools: {
          echo: tool({
            description: "Echo input.",
            inputSchema: z.object({ value: z.string() }),
            execute: async (input) => input,
          }),
        },
      });

      await bridge!.invokeTool("echo", "{\"value\":\"same\"}");
      await bridge!.invokeTool("echo", "{\"value\":\"same\"}");

      const started = events.filter((event) => event.type === "harness.tool_call.started");
      expect(started.map((event) => event.payload?.callIndex)).toEqual([1, 2]);
      expect(started.map((event) => event.payload?.args)).toEqual([
        runtimeToolArgs({ value: "same" }),
        runtimeToolArgs({ value: "same" }),
      ]);
    });
  });

  it("passes undefined input for blank args and serializes undefined results as empty output", async () => {
    await withTempDir(async (dir) => {
      const execute = vi.fn(async () => undefined);
      const { bridge, events } = await setupBridge(dir, {
        tools: {
          optional: tool({
            description: "Accept optional input.",
            inputSchema: z.any(),
            execute,
          }),
        },
      });

      const result = await bridge!.invokeTool("optional", "  ");

      expect(result).toBe("");
      expect(execute).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ toolCallId: expect.any(String) }),
      );
      expect(events[0]).toMatchObject({
        type: "harness.tool_call.started",
        payload: {
          caller: "runtime",
          toolName: "optional",
          args: RUNTIME_TOOL_NO_ARGS,
          callIndex: 1,
        },
      });
      expect(events[1]).toMatchObject({
        type: "harness.tool_call.succeeded",
        payload: {
          caller: "runtime",
          toolName: "optional",
          args: RUNTIME_TOOL_NO_ARGS,
          callIndex: 1,
          resultUndefined: true,
        },
      });
      expect(events[1]?.payload).not.toHaveProperty("result");
    });
  });

  it("keeps explicit no-args-shaped JSON distinct from blank args", async () => {
    await withTempDir(async (dir) => {
      const execute = vi.fn(async (input) => ({ input }));
      const { bridge, events } = await setupBridge(dir, {
        tools: {
          optional: tool({
            description: "Accept optional input.",
            inputSchema: z.any(),
            execute,
          }),
        },
      });

      await bridge!.invokeTool("optional", "  ");
      await bridge!.invokeTool("optional", "{\"type\":\"harness.runtime_tool.no_args\"}");

      const started = events.filter((event) => event.type === "harness.tool_call.started");
      expect(execute).toHaveBeenNthCalledWith(
        1,
        undefined,
        expect.objectContaining({ toolCallId: expect.any(String) }),
      );
      expect(execute).toHaveBeenNthCalledWith(
        2,
        { type: "harness.runtime_tool.no_args" },
        expect.objectContaining({ toolCallId: expect.any(String) }),
      );
      expect(started.map((event) => event.payload?.args)).toEqual([
        RUNTIME_TOOL_NO_ARGS,
        runtimeToolArgs({ type: "harness.runtime_tool.no_args" }),
      ]);
      expect(started.map((event) => event.payload?.callIndex)).toEqual([1, 1]);
    });
  });

  it("keeps durable args immutable when a tool mutates its input object", async () => {
    await withTempDir(async (dir) => {
      const { bridge, events } = await setupBridge(dir, {
        tools: {
          mutate: tool({
            description: "Mutate input.",
            inputSchema: z.object({ nested: z.object({ value: z.string() }) }),
            execute: async (input: any) => {
              input.nested.value = "mutated";
              input.added = true;
              return { ok: true };
            },
          }),
        },
      });

      await bridge!.invokeTool("mutate", "{\"nested\":{\"value\":\"original\"}}");

      const durableArgs = runtimeToolArgs({ nested: { value: "original" } });
      expect(events[0]).toMatchObject({
        type: "harness.tool_call.started",
        payload: {
          args: durableArgs,
        },
      });
      expect(events[1]).toMatchObject({
        type: "harness.tool_call.succeeded",
        payload: {
          args: durableArgs,
          result: { ok: true },
        },
      });
    });
  });

  it("does not advertise or execute invalid and non-executable configured entries", async () => {
    await withTempDir(async (dir) => {
      const executeBadPath = vi.fn(async () => ({ bad: true }));
      const executeNested = vi.fn(async () => ({ nested: true }));
      const executeValid = vi.fn(async () => ({ ok: true }));
      const { bridge, events } = await setupBridge(dir, {
        tools: {
          "": tool({
            description: "Invalid empty name.",
            inputSchema: z.object({}),
            execute: async () => ({ empty: true }),
          }),
          "bad.name": tool({
            description: "Invalid dotted name.",
            inputSchema: z.object({}),
            execute: executeBadPath,
          }),
          "nested/name": tool({
            description: "Invalid nested name.",
            inputSchema: z.object({}),
            execute: executeNested,
          }),
          valid: tool({
            description: "Valid tool.",
            inputSchema: z.object({}),
            execute: executeValid,
          }),
          noExecute: {
            description: "Configured entry with no executable implementation.",
            inputSchema: z.object({}),
          } as unknown as ToolSet[string],
        },
      });

      expect(bridge?.toolNames).toEqual(["valid"]);
      await expect(bridge!.invokeTool("bad.name", "{}")).rejects.toThrow("Invalid runtime tool path");
      await expect(bridge!.invokeTool("nested/name", "{}")).rejects.toThrow("Invalid runtime tool path");
      await expect(bridge!.invokeTool("noExecute", "{}")).rejects.toThrow(
        "Unknown runtime tool: noExecute",
      );

      expect(executeBadPath).not.toHaveBeenCalled();
      expect(executeNested).not.toHaveBeenCalled();
      expect(executeValid).not.toHaveBeenCalled();
      expect(events.map((event) => event.type)).toEqual([
        "harness.tool_call.started",
        "harness.tool_call.failed",
      ]);
      expect(events[0]).toMatchObject({
        type: "harness.tool_call.started",
        payload: {
          caller: "runtime",
          toolName: "noExecute",
          args: runtimeToolArgs({}),
          callIndex: 1,
        },
      });
      expect(events[1]).toMatchObject({
        type: "harness.tool_call.failed",
        payload: {
          caller: "runtime",
          toolName: "noExecute",
          args: runtimeToolArgs({}),
          callIndex: 1,
          error: {
            name: "Error",
            message: "Unknown runtime tool: noExecute",
          },
        },
      });
    });
  });

  it("replays completed runtime tool calls without executing the tool", async () => {
    await withTempDir(async (dir) => {
      const execute = vi.fn(async () => ({ fresh: true }));
      const find = vi.fn<NonNullable<HarnessRuntimeToolReplay["find"]>>(() => ({
        kind: "completed",
        result: { cached: true },
      }));
      const { bridge, events } = await setupBridge(dir, {
        tools: {
          lookup: tool({
            description: "Look up a value.",
            inputSchema: z.object({ query: z.string() }),
            execute,
          }),
        },
        runtimeToolReplay: { find },
      });

      const result = await bridge!.invokeTool("lookup", "{\"query\":\"alpha\"}");

      expect(result).toBe(JSON.stringify({ cached: true }));
      expect(execute).not.toHaveBeenCalled();
      expect(events).toEqual([]);
      expect(find).toHaveBeenCalledWith({
        caller: "runtime",
        toolName: "lookup",
        args: runtimeToolArgs({ query: "alpha" }),
        callIndex: 1,
      });
    });
  });

  it("replays failed runtime tool calls without executing or emitting fresh events", async () => {
    await withTempDir(async (dir) => {
      const execute = vi.fn(async () => ({ fresh: true }));
      const find = vi.fn<NonNullable<HarnessRuntimeToolReplay["find"]>>(() => ({
        kind: "failed",
        error: { name: "Error", message: "cached failure" },
      }));
      const { bridge, events } = await setupBridge(dir, {
        tools: {
          lookup: tool({
            description: "Look up a value.",
            inputSchema: z.object({ query: z.string() }),
            execute,
          }),
        },
        runtimeToolReplay: { find },
      });

      await expect(bridge!.invokeTool("lookup", "{\"query\":\"alpha\"}")).rejects.toThrow(
        "cached failure",
      );

      expect(execute).not.toHaveBeenCalled();
      expect(events).toEqual([]);
      expect(find).toHaveBeenCalledWith({
        caller: "runtime",
        toolName: "lookup",
        args: runtimeToolArgs({ query: "alpha" }),
        callIndex: 1,
      });
    });
  });

  it("replays inflight runtime tool calls using the cached call id for execution and events", async () => {
    await withTempDir(async (dir) => {
      const execute = vi.fn(async () => ({ fresh: true }));
      const find = vi.fn<NonNullable<HarnessRuntimeToolReplay["find"]>>(() => ({
        kind: "inflight",
        callId: "runtime_tool_cached",
      }));
      const { bridge, events } = await setupBridge(dir, {
        tools: {
          lookup: tool({
            description: "Look up a value.",
            inputSchema: z.object({ query: z.string() }),
            execute,
          }),
        },
        runtimeToolReplay: { find },
      });

      const result = await bridge!.invokeTool("lookup", "{\"query\":\"alpha\"}");

      expect(result).toBe(JSON.stringify({ fresh: true }));
      expect(execute).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledWith(
        { query: "alpha" },
        expect.objectContaining({ toolCallId: "runtime_tool_cached" }),
      );
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        type: "harness.tool_call.started",
        occurrenceId: "runtime_tool_cached",
        payload: { callId: "runtime_tool_cached" },
      });
      expect(events[1]).toMatchObject({
        type: "harness.tool_call.succeeded",
        occurrenceId: "runtime_tool_cached",
        payload: { callId: "runtime_tool_cached", result: { fresh: true } },
      });
    });
  });

  it("replays no-arg runtime calls after JSON persistence round trip", async () => {
    await withTempDir(async (dir) => {
      const firstExecute = vi.fn(async () => ({ cached: true }));
      const first = await setupBridge(dir, {
        tools: {
          optional: tool({
            description: "Accept optional input.",
            inputSchema: z.any(),
            execute: firstExecute,
          }),
        },
      });

      await expect(first.bridge!.invokeTool("optional", "  ")).resolves.toBe(
        JSON.stringify({ cached: true }),
      );

      const durableEvents = first.events.map((event, index): DurableHarnessEvent => ({
        type: event.type,
        runId: "run_1",
        sequence: index + 1,
        payload: JSON.parse(JSON.stringify(event.payload)) as Record<string, unknown>,
      }));
      const secondExecute = vi.fn(async () => ({ fresh: true }));
      const second = await setupBridge(dir, {
        tools: {
          optional: tool({
            description: "Accept optional input.",
            inputSchema: z.any(),
            execute: secondExecute,
          }),
        },
        runtimeToolReplay: {
          find: (candidate) => findToolReplay(durableEvents, candidate),
        },
      });

      const replayed = await second.bridge!.invokeTool("optional", "");

      expect(replayed).toBe(JSON.stringify({ cached: true }));
      expect(firstExecute).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ toolCallId: expect.any(String) }),
      );
      expect(secondExecute).not.toHaveBeenCalled();
      expect(second.events).toEqual([]);
      expect(durableEvents[0]?.payload.args).toEqual(RUNTIME_TOOL_NO_ARGS);
      expect(durableEvents[1]?.payload.args).toEqual(RUNTIME_TOOL_NO_ARGS);
    });
  });

  it("emits a failed runtime event for invalid JSON", async () => {
    await withTempDir(async (dir) => {
      const { bridge, events } = await setupBridge(dir, {
        tools: {
          lookup: tool({
            description: "Look up a value.",
            inputSchema: z.object({ query: z.string() }),
            execute: async () => ({ ok: true }),
          }),
        },
      });

      await expect(bridge!.invokeTool("lookup", "{bad json")).rejects.toThrow(
        "Invalid JSON for runtime tool lookup",
      );

      expect(events).toHaveLength(1);
      expect(events[0]?.occurrenceId).toBe(events[0]?.payload?.callId);
      expect(events[0]).toMatchObject({
        type: "harness.tool_call.failed",
        payload: {
          caller: "runtime",
          toolName: "lookup",
          args: undefined,
          callIndex: 1,
          error: {
            name: "Error",
            message: "Invalid JSON for runtime tool lookup",
          },
        },
        metadata: {
          caller: "runtime",
          toolName: "lookup",
          error: {
            name: "Error",
            message: "Invalid JSON for runtime tool lookup",
          },
        },
      });
    });
  });

  it("rejects invalid runtime tool paths before emitting tool events", async () => {
    await withTempDir(async (dir) => {
      const { bridge, events } = await setupBridge(dir, {
        tools: {
          lookup: tool({
            description: "Look up a value.",
            inputSchema: z.object({ query: z.string() }),
            execute: async () => ({ ok: true }),
          }),
        },
      });

      await expect(bridge!.invokeTool("", "{}")).rejects.toThrow("Invalid runtime tool path");
      await expect(bridge!.invokeTool("nested/name", "{}")).rejects.toThrow("Invalid runtime tool path");
      await expect(bridge!.invokeTool("lookup.json", "{}")).rejects.toThrow("Invalid runtime tool path");
      await expect(bridge!.invokeTool(" ", "{}")).rejects.toThrow("Invalid runtime tool path");
      expect(events).toEqual([]);
    });
  });

  it("does not replay unknown runtime tools", async () => {
    await withTempDir(async (dir) => {
      const find = vi.fn<NonNullable<HarnessRuntimeToolReplay["find"]>>(() => ({
        kind: "completed",
        result: { cached: true },
      }));
      const { bridge, events } = await setupBridge(dir, {
        tools: {
          lookup: tool({
            description: "Look up a value.",
            inputSchema: z.object({ query: z.string() }),
            execute: async () => ({ ok: true }),
          }),
        },
        runtimeToolReplay: { find },
      });

      await expect(bridge!.invokeTool("missing", "{\"query\":\"alpha\"}")).rejects.toThrow(
        "Unknown runtime tool: missing",
      );

      expect(find).not.toHaveBeenCalled();
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        type: "harness.tool_call.started",
        payload: {
          caller: "runtime",
          toolName: "missing",
          args: runtimeToolArgs({ query: "alpha" }),
          callIndex: 1,
        },
      });
      expect(events[0]?.occurrenceId).toBe(events[0]?.payload?.callId);
      expect(events[1]).toMatchObject({
        type: "harness.tool_call.failed",
        payload: {
          caller: "runtime",
          toolName: "missing",
          args: runtimeToolArgs({ query: "alpha" }),
          callIndex: 1,
          error: {
            name: "Error",
            message: "Unknown runtime tool: missing",
          },
        },
      });
      expect(events[1]?.occurrenceId).toBe(events[0]?.payload?.callId);
    });
  });

  it("does not expose bash through invokeTool when other bridge tools exist", async () => {
    await withTempDir(async (dir) => {
      const executeBash = vi.fn(async () => ({ stdout: "ran" }));
      const { bridge, events } = await setupBridge(dir, {
        tools: {
          bash: tool({
            description: "Run shell.",
            inputSchema: z.object({ command: z.string() }),
            execute: executeBash,
          }),
          lookup: tool({
            description: "Look up a value.",
            inputSchema: z.object({ query: z.string() }),
            execute: async () => ({ ok: true }),
          }),
        },
      });

      await expect(bridge!.invokeTool("bash", "{\"command\":\"echo hi\"}")).rejects.toThrow(
        "Unknown runtime tool: bash",
      );

      expect(executeBash).not.toHaveBeenCalled();
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        type: "harness.tool_call.started",
        payload: {
          caller: "runtime",
          toolName: "bash",
          args: runtimeToolArgs({ command: "echo hi" }),
          callIndex: 1,
        },
      });
      expect(events[0]?.occurrenceId).toBe(events[0]?.payload?.callId);
      expect(events[1]).toMatchObject({
        type: "harness.tool_call.failed",
        payload: {
          caller: "runtime",
          toolName: "bash",
          args: runtimeToolArgs({ command: "echo hi" }),
          callIndex: 1,
          error: {
            name: "Error",
            message: "Unknown runtime tool: bash",
          },
        },
      });
      expect(events[1]?.occurrenceId).toBe(events[0]?.payload?.callId);
    });
  });

  it("returns undefined when only bash or no tools are provided", async () => {
    await withTempDir(async (dir) => {
      const withoutTools = await setupBridge(dir, { tools: {} });
      expect(withoutTools.bridge).toBeUndefined();
    });

    await withTempDir(async (dir) => {
      const onlyBash = await setupBridge(dir, {
        tools: {
          bash: tool({
            description: "Run shell.",
            inputSchema: z.object({ command: z.string() }),
            execute: async () => ({ stdout: "" }),
          }),
        },
      });
      expect(onlyBash.bridge).toBeUndefined();
    });
  });

  it("emits a failed runtime event for unknown tools", async () => {
    await withTempDir(async (dir) => {
      const { bridge, events } = await setupBridge(dir, {
        tools: {
          lookup: tool({
            description: "Look up a value.",
            inputSchema: z.object({ query: z.string() }),
            execute: async () => ({ ok: true }),
          }),
        },
      });

      await expect(bridge!.invokeTool("missing", "{\"query\":\"alpha\"}")).rejects.toThrow(
        "Unknown runtime tool: missing",
      );

      expect(events).toHaveLength(2);
      expect(events[0]?.occurrenceId).toBe(events[0]?.payload?.callId);
      expect(events[0]).toMatchObject({
        type: "harness.tool_call.started",
        payload: {
          caller: "runtime",
          toolName: "missing",
          args: runtimeToolArgs({ query: "alpha" }),
          callIndex: 1,
        },
      });
      expect(events[1]).toMatchObject({
        type: "harness.tool_call.failed",
        payload: {
          caller: "runtime",
          toolName: "missing",
          args: runtimeToolArgs({ query: "alpha" }),
          callIndex: 1,
          error: {
            name: "Error",
            message: "Unknown runtime tool: missing",
          },
        },
      });
      expect(events[1]?.occurrenceId).toBe(events[0]?.payload?.callId);
    });
  });
});

async function setupBridge(
  dir: string,
  options: {
    tools: ToolSet;
    runtimeToolReplay?: HarnessRuntimeToolReplay;
  },
): Promise<{
  bridge: ReturnType<typeof createRuntimeToolBridge>;
  events: HarnessEventInput[];
  session: HarnessSession;
}> {
  const host = localHost({ dataDir: dir });
  const session = await host.sessions.getOrCreate({ id: "chat" });
  const events: HarnessEventInput[] = [];
  const toolContext: HarnessToolExecutionContext = {
    session,
    files: session.files,
    artifacts: session.artifacts,
  };
  const bridge = createRuntimeToolBridge({
    tools: options.tools,
    toolContext,
    ...(options.runtimeToolReplay === undefined ? {} : { runtimeToolReplay: options.runtimeToolReplay }),
    emit: async (event) => {
      events.push(event);
      return {
        ...event,
        sessionId: session.id,
        timestamp: new Date().toISOString(),
      } as HarnessEvent;
    },
    files: session.files,
    traceOptions: resolveTraceOptions(undefined, undefined),
  });
  return { bridge, events, session };
}
