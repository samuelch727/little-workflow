import { createHash } from "node:crypto";
import type { HarnessEventType } from "./names.js";

export type HarnessToolCallHashInput = {
  readonly caller: "model" | "code" | "runtime";
  readonly toolName: string;
  readonly args: unknown;
  readonly turn?: number;
  readonly callIndex?: number;
  readonly scope?: Record<string, unknown>;
};

export type DurableHarnessEvent = {
  readonly type: HarnessEventType | string;
  readonly runId: string;
  readonly occurrenceId?: string;
  readonly sequence: number;
  readonly payload: Record<string, unknown>;
};

export type ModelReplay<TResponse = unknown> =
  | { readonly kind: "none" }
  | { readonly kind: "inflight"; readonly turn: number; readonly callId: string }
  | { readonly kind: "completed"; readonly turn: number; readonly callId: string; readonly response: TResponse };

export type ToolReplay =
  | { readonly kind: "none" }
  | { readonly kind: "inflight"; readonly callId: string }
  | { readonly kind: "completed"; readonly result: unknown }
  | { readonly kind: "failed"; readonly error: unknown };

export function canonicalJson(value: unknown): string {
  return serializeCanonical(value, "$", new WeakSet<object>());
}

export function sha256Hex(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function sha256Digest(value: unknown): string {
  return `sha256:${sha256Hex(value)}`;
}

export function hashHarnessPrompt(input: unknown): string {
  return sha256Digest(input);
}

export function hashHarnessToolCall(input: HarnessToolCallHashInput): string {
  return sha256Digest({
    caller: input.caller,
    toolName: input.toolName,
    args: input.args,
    ...(input.caller === "model" ? { turn: input.turn ?? 1 } : {}),
    ...(input.callIndex === undefined ? {} : { callIndex: input.callIndex }),
    ...(input.scope === undefined ? {} : { scope: input.scope }),
  });
}

export function findModelReplay<TResponse = unknown>(
  events: readonly DurableHarnessEvent[],
  request: {
    readonly model: string;
    readonly messages: readonly unknown[];
    readonly tools: readonly unknown[];
    readonly system?: string;
    readonly scope?: Record<string, unknown>;
    readonly step?: unknown;
  },
  // Durable tool REFS (as produced by `toolRefsForDurableRequest` / `durableModelRequest`, i.e.
  // `{ toolName, descriptionHash?, inputSchemaHash?, outputSchemaHash? }`) for the abstract
  // (execute-less) tools filtered out of `request.tools` before this run reached the model.
  // Recordings made BEFORE that filter hashed those tools into the prompt, so they are fed to
  // `legacyModelReplayRequests` to reconstruct — full request shape and all — the exact
  // `durableModelRequest` a pre-filter recorder produced from the un-filtered toolset.
  hiddenAbstractToolRefs: readonly Record<string, unknown>[] = [],
): ModelReplay<TResponse> {
  const currentHash = hashHarnessPrompt(request);
  const legacyHashes = new Set<string>();
  for (const legacyRequest of legacyModelReplayRequests(request, hiddenAbstractToolRefs)) {
    legacyHashes.add(hashHarnessPrompt(legacyRequest));
  }
  const called = events
    .filter((event) =>
      event.type === "harness.model.called" &&
      modelCallMatchesRequest(event.payload, request, currentHash, legacyHashes)
    )
    .sort((left, right) => left.sequence - right.sequence);

  if (called.length === 0) {
    return { kind: "none" };
  }

  for (let index = called.length - 1; index >= 0; index -= 1) {
    const current = called[index];
    if (current === undefined) {
      continue;
    }
    const turn = numberProperty(current.payload, "turn") ?? 1;
    const callId = stringProperty(current.payload, "callId") ?? `legacy-turn:${turn}`;
    const nextCalledSequence = called[index + 1]?.sequence ?? Number.POSITIVE_INFINITY;
    const responded = events.find((event) =>
      event.sequence > current.sequence &&
      event.sequence < nextCalledSequence &&
      event.type === "harness.model.responded" &&
      modelResponseMatchesCall(event.payload, callId, turn)
    );
    if (responded !== undefined) {
      return {
        kind: "completed",
        turn,
        callId,
        response: replayResponseFromModelResponse(responded.payload) as TResponse,
      };
    }
    const failed = events.find((event) =>
      event.sequence > current.sequence &&
      event.sequence < nextCalledSequence &&
      event.type === "harness.model.failed" &&
      modelResponseMatchesCall(event.payload, callId, turn)
    );
    if (failed !== undefined) {
      return { kind: "none" };
    }
    if (index === called.length - 1) {
      return { kind: "inflight", turn, callId };
    }
  }

  return { kind: "none" };
}

export function findSingleCompletedModelReplay<TResponse = unknown>(
  events: readonly DurableHarnessEvent[],
): ModelReplay<TResponse> {
  const called = events
    .filter((event) => event.type === "harness.model.called")
    .sort((left, right) => left.sequence - right.sequence);
  if (called.length !== 1) {
    return { kind: "none" };
  }

  const current = called[0];
  if (current === undefined) {
    return { kind: "none" };
  }
  const turn = numberProperty(current.payload, "turn") ?? 1;
  const callId = stringProperty(current.payload, "callId") ?? `legacy-turn:${turn}`;
  const failed = events.find((event) =>
    event.sequence > current.sequence &&
    event.type === "harness.model.failed" &&
    modelResponseMatchesCall(event.payload, callId, turn)
  );
  if (failed !== undefined) {
    return { kind: "none" };
  }
  const responded = events.find((event) =>
    event.sequence > current.sequence &&
    event.type === "harness.model.responded" &&
    modelResponseMatchesCall(event.payload, callId, turn)
  );
  if (responded === undefined) {
    return { kind: "none" };
  }

  return {
    kind: "completed",
    turn,
    callId,
    response: replayResponseFromModelResponse(responded.payload) as TResponse,
  };
}

export function findToolReplay(
  events: readonly DurableHarnessEvent[],
  candidate: HarnessToolCallHashInput,
): ToolReplay {
  const replayHash = hashHarnessToolCall(candidate);
  const legacyReplayHash =
    candidate.callIndex === undefined || candidate.callIndex === 1
      ? hashHarnessToolCall({
          caller: candidate.caller,
          toolName: candidate.toolName,
          args: candidate.args,
          ...(candidate.caller === "model" ? { turn: candidate.turn } : {}),
          ...(candidate.scope === undefined ? {} : { scope: candidate.scope }),
        })
      : undefined;
  const started = events
    .filter((event) => event.type === "harness.tool_call.started")
    .filter((event) => {
      const hash = hashHarnessToolCallFromEvent(event);
      return hash === replayHash || (legacyReplayHash !== undefined && hash === legacyReplayHash);
    })
    .sort((left, right) => left.sequence - right.sequence);

  if (started.length === 0) {
    return { kind: "none" };
  }

  for (let index = started.length - 1; index >= 0; index -= 1) {
    const current = started[index];
    if (current === undefined) {
      continue;
    }
    const callId = stringProperty(current.payload, "callId");
    if (callId === undefined) {
      continue;
    }
    const nextStartedSequence = started[index + 1]?.sequence ?? Number.POSITIVE_INFINITY;
    const succeeded = events.find((event) =>
      event.sequence > current.sequence &&
      event.sequence < nextStartedSequence &&
      event.type === "harness.tool_call.succeeded" &&
      stringProperty(event.payload, "callId") === callId
    );
    if (succeeded !== undefined && succeeded.payload.resultUndefined === true) {
      return { kind: "completed", result: undefined };
    }
    if (succeeded !== undefined && Object.hasOwn(succeeded.payload, "result")) {
      return { kind: "completed", result: succeeded.payload.result };
    }
    const failed = events.find((event) =>
      event.sequence > current.sequence &&
      event.sequence < nextStartedSequence &&
      event.type === "harness.tool_call.failed" &&
      stringProperty(event.payload, "callId") === callId
    );
    if (failed !== undefined && Object.hasOwn(failed.payload, "error")) {
      return { kind: "failed", error: failed.payload.error };
    }
    if (index === started.length - 1) {
      return { kind: "inflight", callId };
    }
  }

  return { kind: "none" };
}

function modelCallMatchesRequest(
  payload: Record<string, unknown>,
  request: {
    readonly scope?: Record<string, unknown>;
    readonly step?: unknown;
  },
  currentHash: string,
  legacyHashes: ReadonlySet<string>,
): boolean {
  const promptHash = stringProperty(payload, "promptHash");
  if (promptHash === currentHash) {
    return true;
  }
  if (promptHash === undefined || !legacyHashes.has(promptHash)) {
    return false;
  }
  if (!hasReplayScope(request)) {
    return true;
  }

  const storedRequest = recordProperty(payload, "request");
  return durableEqual(recordProperty(storedRequest, "scope"), request.scope) &&
    durableEqual(propertyValue(storedRequest, "step"), request.step);
}

function hashHarnessToolCallFromEvent(event: DurableHarnessEvent): string | undefined {
  const caller = stringProperty(event.payload, "caller");
  const toolName = stringProperty(event.payload, "toolName");
  if (
    (caller !== "model" && caller !== "code" && caller !== "runtime") ||
    toolName === undefined ||
    !Object.hasOwn(event.payload, "args")
  ) {
    return undefined;
  }
  const scope = recordProperty(event.payload, "scope");
  return hashHarnessToolCall({
    caller,
    toolName,
    args: event.payload.args,
    ...(caller === "model" ? { turn: numberProperty(event.payload, "turn") ?? 1 } : {}),
    ...(Object.hasOwn(event.payload, "callIndex")
      ? { callIndex: numberProperty(event.payload, "callIndex") ?? 1 }
      : {}),
    ...(scope === undefined ? {} : { scope }),
  });
}

function replayResponseFromModelResponse(payload: Record<string, unknown>): unknown {
  const response = recordProperty(payload, "response");
  if (response !== undefined) {
    return response;
  }

  const text = stringProperty(payload, "text");
  const output = propertyValue(payload, "output");
  const usage = recordProperty(payload, "usage");
  const toolCalls = arrayProperty(payload, "toolCalls");
  return {
    ...(output === undefined ? {} : { output }),
    ...(text === undefined ? {} : { text }),
    ...(toolCalls === undefined ? {} : { toolCalls }),
    ...(usage === undefined ? {} : { usage }),
  };
}

function modelResponseMatchesCall(
  payload: Record<string, unknown>,
  callId: string,
  turn: number,
): boolean {
  const responseCallId = stringProperty(payload, "callId");
  if (responseCallId !== undefined) {
    return responseCallId === callId;
  }
  return numberProperty(payload, "turn") === turn;
}

function legacyModelReplayRequests(
  request: {
    readonly model: string;
    readonly messages: readonly unknown[];
    readonly tools: readonly unknown[];
    readonly [key: string]: unknown;
  },
  hiddenAbstractToolRefs: readonly Record<string, unknown>[] = [],
): readonly Record<string, unknown>[] {
  // Each candidate reuses EVERY other field of `request` (model, system, messages, settings, scope,
  // step) and swaps only `tools`, because a pre-filter recorder stored
  // `hashHarnessPrompt(durableModelRequest(...))` — the FULL request shape with system + per-tool
  // descriptionHash/inputSchemaHash, name-sorted — so only a full-shape candidate can ever match.
  //
  // Base tool-ref list: the current model-facing refs. When abstract tools were filtered out of this
  // run, a second variant MERGES their durable refs back in and re-sorts by name, reconstructing
  // byte-for-byte the `tools` array `durableModelRequest(preFilterToolset)` produced. This is the
  // mirror image of the `bash` removal below (bash was ADDED to requests at some point, so old
  // recordings match with it removed).
  const toolLists: (readonly unknown[])[] = [request.tools];
  if (hiddenAbstractToolRefs.length > 0) {
    toolLists.push(sortToolRefsByName([...request.tools, ...hiddenAbstractToolRefs]));
  }
  const requests: Record<string, unknown>[] = [];
  for (const tools of toolLists) {
    requests.push({ ...request, tools });
    if (tools.some((tool) => stringProperty(tool, "toolName") === "bash")) {
      requests.push({ ...request, tools: tools.filter((tool) => stringProperty(tool, "toolName") !== "bash") });
    }
  }
  return requests;
}

function sortToolRefsByName(refs: readonly unknown[]): unknown[] {
  return [...refs].sort((left, right) =>
    (stringProperty(left, "toolName") ?? "").localeCompare(stringProperty(right, "toolName") ?? ""),
  );
}

function hasReplayScope(request: { readonly scope?: unknown; readonly step?: unknown }): boolean {
  return request.scope !== undefined || request.step !== undefined;
}

function durableEqual(left: unknown, right: unknown): boolean {
  if (left === undefined && right === undefined) {
    return true;
  }
  if (left === undefined || right === undefined) {
    return false;
  }
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function propertyValue(value: unknown, key: string): unknown {
  if (!isRecord(value)) {
    return undefined;
  }
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

function recordProperty(value: unknown, key: string): Record<string, unknown> | undefined {
  const candidate = propertyValue(value, key);
  return isRecord(candidate) ? candidate : undefined;
}

function stringProperty(value: unknown, key: string): string | undefined {
  const candidate = propertyValue(value, key);
  return typeof candidate === "string" ? candidate : undefined;
}

function numberProperty(value: unknown, key: string): number | undefined {
  const candidate = propertyValue(value, key);
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function arrayProperty(value: unknown, key: string): readonly unknown[] | undefined {
  const candidate = propertyValue(value, key);
  return Array.isArray(candidate) ? candidate : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function serializeCanonical(value: unknown, path: string, seen: WeakSet<object>): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw nonHashable("Non-finite numbers are not hashable.", path);
      }
      return JSON.stringify(value);
    case "undefined":
      throw nonHashable("undefined is not hashable.", path);
    case "bigint":
      throw nonHashable("bigint values are not hashable.", path);
    case "function":
      throw nonHashable("Functions are not hashable.", path);
    case "symbol":
      throw nonHashable("Symbols are not hashable.", path);
    case "object":
      return serializeObject(value, path, seen);
    default:
      throw nonHashable("Unknown value type is not hashable.", path);
  }
}

function serializeObject(value: object, path: string, seen: WeakSet<object>): string {
  if (seen.has(value)) {
    throw nonHashable("Cyclic references are not hashable.", path);
  }

  if (Array.isArray(value)) {
    return serializeArray(value, path, seen);
  }

  if (!isPlainObject(value)) {
    throw nonHashable("Non-plain objects are not hashable.", path);
  }

  const symbolKeys = Object.getOwnPropertySymbols(value);
  if (symbolKeys.length > 0) {
    throw nonHashable("Symbol keys are not hashable.", path);
  }

  seen.add(value);
  const entries: string[] = [];
  for (const key of Object.getOwnPropertyNames(value).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      continue;
    }
    if (!("value" in descriptor)) {
      throw nonHashable("Accessors are not hashable.", pathForKey(path, key));
    }
    if (!descriptor.enumerable) {
      throw nonHashable("Non-enumerable properties are not hashable.", pathForKey(path, key));
    }
    entries.push(`${JSON.stringify(key)}:${serializeCanonical(descriptor.value, pathForKey(path, key), seen)}`);
  }
  seen.delete(value);

  return `{${entries.join(",")}}`;
}

function serializeArray(value: readonly unknown[], path: string, seen: WeakSet<object>): string {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw nonHashable("Non-plain arrays are not hashable.", path);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw nonHashable("Symbol keys are not hashable.", path);
  }

  seen.add(value);
  validateArrayShape(value, path);
  const items: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const itemPath = `${path}[${index}]`;
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) {
      throw nonHashable("Sparse arrays are not hashable.", `${path}[${index}]`);
    }
    if (!("value" in descriptor)) {
      throw nonHashable("Accessors are not hashable.", itemPath);
    }
    if (!descriptor.enumerable) {
      throw nonHashable("Non-enumerable array indexes are not hashable.", itemPath);
    }
    items.push(serializeCanonical(descriptor.value, itemPath, seen));
  }
  seen.delete(value);

  return `[${items.join(",")}]`;
}

function validateArrayShape(value: readonly unknown[], path: string): void {
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key === "length" || isCanonicalArrayIndex(key, value.length)) {
      continue;
    }
    throw nonHashable("Arrays must not contain extra own properties.", pathForKey(path, key));
  }
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (!/^(0|[1-9][0-9]*)$/u.test(key)) {
    return false;
  }
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function pathForKey(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function nonHashable(message: string, path: string): TypeError {
  return new TypeError(`${message} Path: ${path}`);
}
