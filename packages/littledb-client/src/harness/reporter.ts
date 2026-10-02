import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { HarnessEvent, JsonObject } from "little-harness";
import { usageWithCostUsd } from "../cost.js";

export interface LittleDbHarnessReporterOptions {
  engineUrl: string;
  harnessId: string;
  releaseChannel?: string | null;
  model?: string | null;
  /** The pinned littleDB config version this session resolved (recorded into traces). */
  configVersionId?: string | null;
  localConfig?: JsonObject;
  toolManifest?: unknown;
  integrationPatches?: Array<{ title: string; patchUnified: string }>;
  fetchImpl?: typeof fetch;
  runIdForSession?: (sessionId: string) => string;
}

export interface LittleDbHarnessReporter {
  onEvent(event: HarnessEvent): Promise<void>;
  flush(): Promise<void>;
}

type LittleDbEnvelope = {
  eventId: string;
  runId: string;
  sequence: number;
  type: string;
  recordedAt: string;
  payload: JsonObject;
};

type ReplayTranscriptPart = JsonObject & {
  id: string;
  role: "user" | "assistant" | "tool";
  content?: string;
  boundaryId: string;
};

type FileSnapshot = {
  path: string;
  boundaryId: string;
  mediaType?: string;
  contentBase64: string;
};

type SessionState = {
  sessionId: string;
  runId: string;
  rootRunId: string;
  startedAt: string;
  transcript: ReplayTranscriptPart[];
  files: FileSnapshot[];
  lastEvent?: HarnessEvent;
};

export function createLittleDbHarnessReporter(
  options: LittleDbHarnessReporterOptions,
): LittleDbHarnessReporter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const runIdForSession = options.runIdForSession ?? ((sessionId: string) => `harness_${sessionId}`);
  const sessions = new Map<string, SessionState>();

  async function onEvent(event: HarnessEvent): Promise<void> {
    const state = sessionState(event.sessionId, event.timestamp);
    if (event.type === "harness.session.started") {
      state.startedAt = event.timestamp;
    }
    updateTranscript(state, event);
    updateFiles(state, event);
    state.lastEvent = event;

    const envelope = toLittleDbEnvelope(event, state.runId, options);
    await postBestEffort(fetchImpl, options.engineUrl, "/ingest", [envelope]);
    await uploadEval(fetchImpl, options, state);
  }

  async function flush(): Promise<void> {
    for (const state of sessions.values()) {
      await uploadEval(fetchImpl, options, state);
    }
  }

  function sessionState(sessionId: string, timestamp: string): SessionState {
    let state = sessions.get(sessionId);
    if (!state) {
      const runId = runIdForSession(sessionId);
      state = {
        sessionId,
        runId,
        rootRunId: runId,
        startedAt: timestamp,
        transcript: [],
        files: [],
      };
      sessions.set(sessionId, state);
    }
    return state;
  }

  return { onEvent, flush };
}

function toLittleDbEnvelope(
  event: HarnessEvent,
  runId: string,
  options: LittleDbHarnessReporterOptions,
): LittleDbEnvelope {
  return {
    eventId: event.eventId ?? fallbackEventId(event),
    runId,
    sequence: event.sequence ?? 0,
    type: littleDbEventType(event.type),
    recordedAt: event.timestamp,
    payload: littleDbPayload(event, options),
  };
}

function littleDbEventType(type: HarnessEvent["type"]): string {
  return type;
}

function littleDbPayload(event: HarnessEvent, options: LittleDbHarnessReporterOptions): JsonObject {
  const metadata = event.metadata ?? {};

  switch (event.type) {
    case "harness.session.started":
      return {
        workflowVersionId: "little-harness",
        label: `Little Harness ${event.sessionId}`,
        tags: ["little-harness", options.harnessId],
        metadata: {
          harnessId: options.harnessId,
          sessionId: event.sessionId,
          releaseChannel: options.releaseChannel ?? null,
          configVersionId: options.configVersionId ?? null,
        },
      };
    case "harness.session.completed":
      return { metadata };
    case "harness.session.failed":
      return { error: metadata.error ?? metadata, metadata };
    case "harness.model.called":
      return modelCalledPayload(event, options);
    case "harness.model.responded":
      return modelRespondedPayload(event, options);
    case "harness.model.failed":
      return modelFailedPayload(event);
    case "harness.tool_call.started":
    case "harness.tool_call.succeeded":
    case "harness.tool_call.failed":
      return toolPayload(event);
    default:
      return {
        harnessEventType: event.type,
        sessionId: event.sessionId,
        turnId: event.turnId,
        stepId: event.stepId,
        parentEventId: event.parentEventId,
        metadata,
      };
  }
}

function modelCalledPayload(event: HarnessEvent, options: LittleDbHarnessReporterOptions): JsonObject {
  const metadata = event.metadata ?? {};
  const request = objectValue(metadata.request);
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const normalizedRequest: JsonObject = {
    model: modelId(metadata, options),
    system: textValue(request?.system),
    messages: messages.map((message) => messagePayload(message)),
    tools: Array.isArray(request?.tools) ? request.tools : [],
  };
  return {
    callId: event.stepId ?? event.eventId ?? fallbackEventId(event),
    turn: turnValue(event),
    promptHash: sha256Digest(normalizedRequest),
    request: normalizedRequest,
  };
}

function modelRespondedPayload(
  event: HarnessEvent,
  options: LittleDbHarnessReporterOptions,
  failed = false,
): JsonObject {
  const metadata = event.metadata ?? {};
  const text = textValue(metadata.text ?? metadata.output ?? metadata.response);
  const response: JsonObject = {
    model: modelId(metadata, options),
    text,
    output: text,
  };
  if (metadata.usage !== undefined) {
    // The engine's cost column for this event type comes from exactly here —
    // `payload.response.usage.costUsd` (crates/engine/src/ingest.rs). Harness events are
    // token-only by design, so the dollars are computed at this boundary from the
    // registry rates; see ../cost.ts for why that does not breach the durable-log
    // invariant. `usageWithCostUsd` copies rather than mutating, so the harness event's
    // own `metadata.usage` stays cost-free for every other sink.
    response.usage = usageWithCostUsd(metadata.model, metadata.usage);
  }
  if (metadata.durationMs !== undefined) {
    response.durationMs = metadata.durationMs;
  }
  if (Array.isArray(metadata.toolCalls)) {
    response.toolCalls = metadata.toolCalls;
  }
  if (failed) {
    response.error = metadata.error ?? metadata;
  }
  return {
    callId: event.stepId ?? event.eventId ?? fallbackEventId(event),
    turn: turnValue(event),
    response,
  };
}

function toolPayload(event: HarnessEvent): JsonObject {
  const metadata = event.metadata ?? {};
  const args = metadata.args ?? metadata.input;
  const result = metadata.result ?? metadata.output;
  const payload: JsonObject = {
    callId: stringValue(metadata.toolCallId) ?? event.stepId ?? event.eventId ?? fallbackEventId(event),
    toolCallId: stringValue(metadata.toolCallId),
    toolName: stringValue(metadata.toolName) ?? "unknown",
  };
  if (event.type === "harness.tool_call.started") {
    const caller = stringValue(metadata.caller) ?? "model";
    payload.caller = caller;
    if (caller === "model") {
      payload.turn = turnValue(event);
    }
    payload.args = args === undefined ? {} : parseJsonPreview(args);
    payload.input = payload.args;
  } else if (result !== undefined) {
    payload.result = parseJsonPreview(result);
    payload.output = payload.result;
  }
  if (event.type !== "harness.tool_call.started" && args !== undefined) {
    payload.args = parseJsonPreview(args);
    payload.input = payload.args;
  }
  if (event.type !== "harness.tool_call.started") {
    payload.durationMs = nonNegativeNumberValue(metadata.durationMs) ?? 0;
  } else if (metadata.durationMs !== undefined) {
    payload.durationMs = nonNegativeNumberValue(metadata.durationMs) ?? 0;
  }
  if (event.type === "harness.tool_call.failed") {
    payload.error = metadata.error ?? metadata;
  }
  return payload;
}

function modelFailedPayload(event: HarnessEvent): JsonObject {
  const metadata = event.metadata ?? {};
  return {
    callId: event.stepId ?? event.eventId ?? fallbackEventId(event),
    turn: turnValue(event),
    error: errorEnvelopeValue(metadata.error ?? metadata),
    durationMs: numberValue(metadata.durationMs) ?? 0,
  };
}

function updateTranscript(state: SessionState, event: HarnessEvent): void {
  const metadata = event.metadata ?? {};
  const boundaryId = `event_${event.sequence ?? state.transcript.length + 1}:after`;

  if (event.type === "harness.model.called") {
    const request = objectValue(metadata.request);
    const message = lastUserMessage(request);
    state.transcript.push({
      id: event.eventId ?? fallbackEventId(event),
      role: "user",
      title: "Model request",
      content: message ? textValue(message.content) : textValue(request?.system),
      boundaryId,
    });
    return;
  }

  if (event.type === "harness.model.responded" || event.type === "harness.model.failed") {
    const content =
      event.type === "harness.model.failed"
        ? textValue(metadata.error ?? metadata)
        : textValue(metadata.text ?? metadata.output ?? metadata.response);
    const part: ReplayTranscriptPart = {
      id: event.eventId ?? fallbackEventId(event),
      role: "assistant",
      title: event.type === "harness.model.failed" ? "Model error" : "Model response",
      content,
      boundaryId,
    };
    if (metadata.usage !== undefined) {
      part.usage = metadata.usage;
    }
    state.transcript.push(part);
    return;
  }

  if (event.type === "harness.tool_call.succeeded" || event.type === "harness.tool_call.failed") {
    const part: ReplayTranscriptPart = {
      id: event.eventId ?? fallbackEventId(event),
      role: "tool",
      title: `Tool response: ${stringValue(metadata.toolName) ?? "unknown"}`,
      name: stringValue(metadata.toolName) ?? "unknown",
      input: metadata.input === undefined ? undefined : parseJsonPreview(metadata.input),
      output:
        event.type === "harness.tool_call.failed"
          ? undefined
          : metadata.output === undefined
            ? undefined
            : parseJsonPreview(metadata.output),
      boundaryId,
    };
    if (event.type === "harness.tool_call.failed") {
      part.error = metadata.error ?? metadata;
    }
    state.transcript.push(part);
  }
}

function updateFiles(state: SessionState, event: HarnessEvent): void {
  if (event.type !== "harness.file.created" && event.type !== "harness.file.updated" && event.type !== "harness.file.deleted") {
    return;
  }

  const metadata = event.metadata ?? {};
  const path = stringValue(metadata.path);
  if (!path) {
    return;
  }

  if (event.type === "harness.file.deleted") {
    state.files = state.files.filter((file) => file.path !== path);
    return;
  }

  const snapshot = fileSnapshotContent(event);
  if (!snapshot) {
    return;
  }

  const nextFile: FileSnapshot = {
    path,
    boundaryId: stringValue(metadata.boundaryId) ?? `event_${event.sequence ?? state.files.length + 1}:after`,
    contentBase64: snapshot.contentBase64,
  };
  if (snapshot.mediaType) {
    nextFile.mediaType = snapshot.mediaType;
  }

  const existingIndex = state.files.findIndex((file) => file.path === path);
  if (existingIndex === -1) {
    state.files.push(nextFile);
  } else {
    state.files[existingIndex] = nextFile;
  }
}

function fileSnapshotContent(event: HarnessEvent): { contentBase64: string; mediaType?: string } | null {
  const metadata = event.metadata ?? {};
  const mediaType = stringValue(metadata.mediaType);
  const after = objectValue(metadata.after);

  const explicitBase64 = stringValue(metadata.contentBase64) ?? stringValue(after?.contentBase64);
  if (explicitBase64) {
    return withOptionalMediaType(explicitBase64, mediaType);
  }

  const inlineContent =
    metadata.content ??
    metadata.text ??
    metadata.data ??
    after?.content ??
    after?.text;
  if (inlineContent !== undefined) {
    return {
      contentBase64: base64Text(textValue(inlineContent)),
      mediaType: mediaType ?? (typeof inlineContent === "string" || isPreviewRef(inlineContent) ? "text/plain" : "application/json"),
    };
  }

  return null;
}

function withOptionalMediaType(contentBase64: string, mediaType: string | undefined): { contentBase64: string; mediaType?: string } {
  return mediaType ? { contentBase64, mediaType } : { contentBase64 };
}

function base64Text(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

async function uploadEval(
  fetchImpl: typeof fetch,
  options: LittleDbHarnessReporterOptions,
  state: SessionState,
): Promise<void> {
  const localConfig: JsonObject = {
    ...(options.localConfig ?? {}),
    model: options.model ?? stringValue(options.localConfig?.model) ?? "unknown",
    provider: "little-harness",
    configVersionId: options.configVersionId ?? null,
    replayTranscript: state.transcript,
  };
  await postBestEffort(fetchImpl, options.engineUrl, "/harness/eval-runs", {
    harnessId: options.harnessId,
    sessionId: state.sessionId,
    runId: state.runId,
    rootRunId: state.rootRunId,
    releaseChannel: options.releaseChannel ?? null,
    startedAt: state.startedAt,
    localConfig,
    files: state.files,
    toolManifest: options.toolManifest ?? null,
    integrationPatches: options.integrationPatches ?? [],
  });
}

async function postBestEffort(
  fetchImpl: typeof fetch,
  engineUrl: string,
  path: string,
  body: unknown,
): Promise<void> {
  try {
    const response = await fetchImpl(engineEndpoint(engineUrl, path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`littleDB POST ${path} failed with HTTP ${response.status}`);
    }
  } catch {
    // littleDB reporting must never affect harness execution.
  }
}

function engineEndpoint(engineUrl: string, path: string): string {
  return new URL(path, engineUrl.endsWith("/") ? engineUrl : `${engineUrl}/`).toString();
}

function fallbackEventId(event: HarnessEvent): string {
  return `${event.sessionId}_${event.type}_${event.sequence ?? 0}`;
}

function modelId(metadata: JsonObject, options: LittleDbHarnessReporterOptions): string {
  const model = objectValue(metadata.model);
  return stringValue(model?.modelId) ?? options.model ?? "unknown";
}

function turnValue(event: HarnessEvent): number {
  const metadata = event.metadata ?? {};
  return positiveInteger(metadata.turn) ?? positiveInteger(metadata.stepNumber) ?? positiveInteger(event.sequence) ?? 1;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeNumberValue(value: unknown): number | undefined {
  const number = numberValue(value);
  return number === undefined || number < 0 ? undefined : number;
}

function errorEnvelopeValue(error: unknown): JsonObject {
  const value = objectValue(error);
  if (value) {
    return {
      name: stringValue(value.name) ?? "Error",
      message: stringValue(value.message) ?? textValue(error),
      ...value,
    };
  }
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message,
    };
  }
  return {
    name: "Error",
    message: textValue(error),
  };
}

function sha256Digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value)) ?? "";
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  const object = objectValue(value);
  if (!object) {
    return value;
  }
  const sorted: JsonObject = {};
  for (const key of Object.keys(object).sort()) {
    sorted[key] = sortJson(object[key]);
  }
  return sorted;
}

function messagePayload(message: unknown): JsonObject {
  const value = objectValue(message);
  if (!value) {
    return { role: "unknown", content: textValue(message) };
  }
  return {
    role: stringValue(value.role) ?? "unknown",
    content: textValue(value.content),
  };
}

function lastUserMessage(request: JsonObject | undefined): JsonObject | undefined {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = objectValue(messages[index]);
    if (message && message.role === "user") {
      return message;
    }
  }
  return objectValue(messages[messages.length - 1]);
}

function parseJsonPreview(value: unknown): unknown {
  const text = textValue(value);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function textValue(value: unknown): string {
  if (isPreviewRef(value)) {
    return value.preview;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function objectValue(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function isPreviewRef(value: unknown): value is { preview: string } {
  return objectValue(value)?.preview !== undefined && typeof objectValue(value)?.preview === "string";
}
