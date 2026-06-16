import type { ToolSet } from "ai";
import { canonicalJson } from "../events/durability.js";
import { toolCallEventData } from "../execution/tool-events.js";
import { createEventId } from "../ids.js";
import type { ResolvedHarnessTraceOptions } from "../trace/types.js";
import type {
  FileWriter,
  HarnessEvent,
  HarnessEventInput,
  HarnessRuntimeToolReplay,
  HarnessToolExecutionContext,
  JsonObject,
} from "../types.js";
import { wrapToolsWithHarnessContext } from "./tools.js";

const RUNTIME_TOOL_NO_ARGS = { type: "harness.runtime_tool.no_args" } as const;

export type RuntimeToolBridge = {
  readonly toolNames: readonly string[];
  invokeTool(path: string, argsJson: string): Promise<string>;
};

export type RuntimeToolBridgeOptions<TExtraBody = unknown> = {
  tools: ToolSet;
  toolContext: HarnessToolExecutionContext<TExtraBody>;
  runtimeToolReplay?: HarnessRuntimeToolReplay;
  emit?: (event: HarnessEventInput) => Promise<HarnessEvent | void>;
  files: FileWriter;
  traceOptions: ResolvedHarnessTraceOptions;
  runtimeScope?: () => JsonObject | undefined;
  abortSignal?: AbortSignal;
};

type ParsedRuntimeToolArgs = {
  executeInput: unknown;
  durableArgs: RuntimeToolDurableArgs;
};

type RuntimeToolDurableArgs =
  | { type: "harness.runtime_tool.args"; value: unknown }
  | { type: "harness.runtime_tool.no_args" };

export function createRuntimeToolBridge<TExtraBody = unknown>(
  options: RuntimeToolBridgeOptions<TExtraBody>,
): RuntimeToolBridge | undefined {
  const bridgeToolEntries = Object.entries(options.tools)
    .filter(([name, harnessTool]) => isExposedRuntimeTool(name, harnessTool))
    .sort(([left], [right]) => left.localeCompare(right));
  const toolNames = bridgeToolEntries.map(([name]) => name);
  if (toolNames.length === 0) {
    return undefined;
  }

  const bridgeTools = Object.fromEntries(bridgeToolEntries) as ToolSet;
  const tools = wrapToolsWithHarnessContext(bridgeTools, options.toolContext);
  const callIndexes = new Map<string, number>();

  return {
    toolNames,
    async invokeTool(path, argsJson) {
      validateRuntimeToolPath(path);

      const scope = options.runtimeScope?.();
      let parsedArgs: ParsedRuntimeToolArgs;
      let callIndex = 1;
      try {
        parsedArgs = parseRuntimeToolArgs(argsJson);
        callIndex = nextCallIndex(callIndexes, path, parsedArgs.durableArgs, scope);
      } catch (cause) {
        const error = new Error(`Invalid JSON for runtime tool ${path}`);
        const toolCallId = createEventId();
        await emitToolCallEvent(options, {
          type: "harness.tool_call.failed",
          toolName: path,
          toolCallId,
          input: undefined,
          callIndex,
          scope,
          success: false,
          startedAt: Date.now(),
          error: Object.assign(error, { cause }),
        });
        throw error;
      }

      const harnessTool = tools[path] as Record<string, unknown> | undefined;
      const execute = harnessTool?.execute;
      if (typeof execute !== "function") {
        const toolCallId = createEventId();
        const startedAt = Date.now();
        await emitToolCallEvent(options, {
          type: "harness.tool_call.started",
          toolName: path,
          toolCallId,
          input: parsedArgs.durableArgs,
          callIndex,
          scope,
        });
        const error = new Error(`Unknown runtime tool: ${path}`);
        await emitToolCallEvent(options, {
          type: "harness.tool_call.failed",
          toolName: path,
          toolCallId,
          input: parsedArgs.durableArgs,
          callIndex,
          scope,
          success: false,
          startedAt,
          error,
        });
        throw error;
      }

      const replay = options.runtimeToolReplay?.find({
        caller: "runtime",
        toolName: path,
        args: parsedArgs.durableArgs,
        callIndex,
        ...(scope === undefined ? {} : { scope }),
      });
      if (replay?.kind === "completed") {
        return serializeRuntimeToolResult(replay.result);
      }
      if (replay?.kind === "failed") {
        throw errorFromReplayEnvelope(replay.error);
      }

      const executionToolCallId = replay?.kind === "inflight" ? replay.callId : createEventId();
      const startedAt = Date.now();
      await emitToolCallEvent(options, {
        type: "harness.tool_call.started",
        toolName: path,
        toolCallId: executionToolCallId,
        input: parsedArgs.durableArgs,
        callIndex,
        scope,
      });
      try {
        const result = await execute(parsedArgs.executeInput, {
          toolCallId: executionToolCallId,
          abortSignal: options.abortSignal,
        });
        await emitToolCallEvent(options, {
          type: "harness.tool_call.succeeded",
          toolName: path,
          toolCallId: executionToolCallId,
          input: parsedArgs.durableArgs,
          callIndex,
          scope,
          success: true,
          startedAt,
          result,
        });
        return serializeRuntimeToolResult(result);
      } catch (error) {
        await emitToolCallEvent(options, {
          type: "harness.tool_call.failed",
          toolName: path,
          toolCallId: executionToolCallId,
          input: parsedArgs.durableArgs,
          callIndex,
          scope,
          success: false,
          startedAt,
          error,
        });
        throw error;
      }
    },
  };
}

function validateRuntimeToolPath(path: string): void {
  if (!isValidRuntimeToolPath(path)) {
    throw new Error(`Invalid runtime tool path: ${path}`);
  }
}

function isValidRuntimeToolPath(path: string): boolean {
  return path.trim().length > 0 && !path.includes(".") && !path.includes("/");
}

function isExposedRuntimeTool(name: string, harnessTool: unknown): boolean {
  return name !== "bash" && isValidRuntimeToolPath(name) && hasExecuteFunction(harnessTool);
}

function hasExecuteFunction(value: unknown): value is { execute: (...args: unknown[]) => unknown } {
  return isObject(value) && typeof value.execute === "function";
}

function parseRuntimeToolArgs(argsJson: string): ParsedRuntimeToolArgs {
  if (argsJson.trim().length === 0) {
    return {
      executeInput: undefined,
      durableArgs: RUNTIME_TOOL_NO_ARGS,
    };
  }
  const input = JSON.parse(argsJson);
  return {
    executeInput: input,
    durableArgs: {
      type: "harness.runtime_tool.args",
      value: cloneJsonValue(input),
    },
  };
}

function cloneJsonValue(value: unknown): unknown {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function nextCallIndex(
  callIndexes: Map<string, number>,
  toolName: string,
  input: unknown,
  scope: JsonObject | undefined,
): number {
  const key = canonicalJson({
    toolName,
    input,
    ...(scope === undefined ? {} : { scope }),
  });
  const next = (callIndexes.get(key) ?? 0) + 1;
  callIndexes.set(key, next);
  return next;
}

function serializeRuntimeToolResult(result: unknown): string {
  return result === undefined ? "" : JSON.stringify(result);
}

async function emitToolCallEvent<TExtraBody>(
  options: RuntimeToolBridgeOptions<TExtraBody>,
  event: {
    type: "harness.tool_call.started" | "harness.tool_call.succeeded" | "harness.tool_call.failed";
    toolName: string;
    toolCallId: string;
    input: unknown;
    callIndex: number;
    scope?: JsonObject | undefined;
    success?: boolean;
    startedAt?: number;
    result?: unknown;
    error?: unknown;
  },
): Promise<void> {
  const eventData = await toolCallEventData(
    {
      caller: "runtime",
      toolCall: {
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        input: event.input,
      },
      callIndex: event.callIndex,
      ...(event.scope === undefined ? {} : { scope: event.scope }),
      ...(event.success === undefined ? {} : { success: event.success }),
      ...(event.startedAt === undefined ? {} : { durationMs: Date.now() - event.startedAt }),
      ...(Object.hasOwn(event, "result") ? { result: event.result } : {}),
      ...(Object.hasOwn(event, "error") ? { error: event.error } : {}),
    },
    options.files,
    options.traceOptions,
  );
  await options.emit?.({
    type: event.type,
    occurrenceId: event.toolCallId,
    payload: {
      ...eventData.payload,
      ...(event.type === "harness.tool_call.succeeded" &&
        Object.hasOwn(event, "result") &&
        event.result === undefined
        ? { resultUndefined: true }
        : {}),
    },
    metadata: eventData.metadata,
  });
}

function errorFromReplayEnvelope(value: unknown): Error {
  const envelope = isObject(value) ? value : {};
  const error = new Error(typeof envelope.message === "string" ? envelope.message : "Harness tool call failed.");
  error.name = typeof envelope.name === "string" ? envelope.name : "Error";
  return Object.assign(error, envelope);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
