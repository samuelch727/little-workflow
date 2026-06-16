# Trace and Durability

Little Harness records local trace events and can also write durable model/tool events for replay.

## Trace Files

With `localHost()`, session data is stored under `.little-harness/` by default:

```txt
.little-harness/
  sessions/<session-path-key>/
    session/
    artifacts/
    persistent/
    skills/
    turns/
    trace.ndjson
    status.json
```

Trace events use schema version `lh.trace.v2`. Disable persisted traces with `trace: false`; `onEvent` still receives callback events.

## HarnessEvent Envelope

`HarnessEvent` is the trace/callback event object emitted by `onEvent` and written to local `trace.ndjson` files.

```ts
type HarnessEvent<TEventType extends string = HarnessEventType> = {
  schemaVersion?: "lh.trace.v2";
  eventId?: string;
  sequence?: number;
  occurrenceId?: string;
  type: TEventType;
  sessionId: string;
  turnId?: string;
  stepId?: string;
  parentEventId?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
};
```

Most consumers should key off `type`, `sessionId`, `turnId`, and `occurrenceId`, then read type-specific details from `metadata`.

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Trace schema version. Local traces currently use `lh.trace.v2`. |
| `eventId` | Unique id for this emitted trace/callback event. |
| `sequence` | Monotonic sequence number within the local trace file. |
| `occurrenceId` | Correlation id for one model call, tool call, runtime command, or other logical occurrence. |
| `type` | Dotted event name such as `harness.session.started`, `harness.model.called`, or `harness.tool_call.failed`. |
| `sessionId` | Harness session id. |
| `turnId` | Current turn id for a `generateHarness` or `streamHarness` call. |
| `stepId` | Optional model step id for multi-step model/tool loops. |
| `parentEventId` | Optional parent event id for nested event relationships. |
| `timestamp` | ISO timestamp for when the event was emitted. |
| `metadata` | Event-specific details after trace redaction. Defaults to `{}` in validated local traces. |
 
Example trace event:

```json
{
  "schemaVersion": "lh.trace.v2",
  "eventId": "evt_abc123",
  "sequence": 3,
  "type": "harness.model.called",
  "sessionId": "chat_123",
  "turnId": "turn_abc123",
  "occurrenceId": "evt_model_call",
  "stepId": "step_1",
  "timestamp": "2026-06-10T12:00:00.000Z",
  "metadata": {
    "model": { "provider": "openai", "modelId": "gpt-5" }
  }
}
```

`metadata` shape depends on `type`. For example, model events include model/message/tool references, tool events include tool name/input/result references, file events include path and content/diff references, and persistent dir events include mount and commit details. Tool events also include `caller`; Runtime Tool Bridge calls made from `js-exec` use `caller: "runtime"`.

## Event Names

Generic harness events include:

- `harness.session.started`
- `harness.session.completed`
- `harness.session.failed`
- `harness.model.called`
- `harness.model.responded`
- `harness.model.failed`
- `harness.tool_call.started`
- `harness.tool_call.succeeded`
- `harness.tool_call.failed`
- `harness.runtime.command.started`
- `harness.runtime.command.succeeded`
- `harness.runtime.command.failed`
- `harness.runtime.error`
- `harness.file.created`
- `harness.file.updated`
- `harness.file.deleted`
- `harness.file.staged_from_message`
- `harness.file.staged_from_host`
- `harness.file.written_by_tool`
- `harness.artifact.created`
- `harness.filesystem.mounted`
- `harness.persistent_dir.loaded`
- `harness.persistent_dir.commit.started`
- `harness.persistent_dir.commit.succeeded`
- `harness.persistent_dir.commit.failed`

Workflow harness runs add workflow-specific execute-step events.

## Trace Options

```ts
createHarness({
  host: localHost(),
  model,
  trace: {
    content: {
      previewBytes: 512,
      maxInlineBytes: 16 * 1024,
      captureReasoning: true,
      captureModelMessages: true,
      captureToolInputs: true,
      captureToolOutputs: true,
    },
    fileDiffs: {
      enabled: true,
      maxInlineBytes: 8 * 1024,
      maxBytesToDiff: 256 * 1024,
    },
    redaction: {
      paths: [],
      metadataKeys: ["apiKey", "authorization", "cookie", "token"],
    },
  },
});
```

Default redaction metadata keys include `apiKey`, `authorization`, `cookie`, `set-cookie`, `token`, `password`, and `secret`.

## Durability Replay

Pass a `durability` sink to `createHarness`, `generateHarness`, or `streamHarness` when model/tool calls should be replayable.

```ts
const durability = {
  append: async (event) => persistedEvent,
  priorEvents: async (query) => persistedEvents,
};

const result = await generateHarness({
  harness,
  type: "job",
  input,
  runId: "stable-run-id",
  durability,
});
```

Replay matching depends on request hashes for model prompts and tool calls. Do not mutate prior events. Use a stable `runId` when retrying the same run.

Tool replay distinguishes the call origin:

- `caller: "model"` for provider-emitted tool calls.
- `caller: "runtime"` for tools invoked inside the just-bash JavaScript Runtime Tool Bridge.
- `caller: "code"` for workflow code-run tool proxy calls.

Runtime bridge calls include a durable argument envelope such as `{ type: "harness.runtime_tool.args", value: ... }` or `{ type: "harness.runtime_tool.no_args" }`. They also include a replay `scope` tied to the parent `bash` tool call id. This keeps repeated identical bridged calls inside different bash commands replayable without returning the wrong prior result.

Durable events are not the same shape as `HarnessEvent`. Durable replay stores payloads:

```ts
type DurableHarnessEventInput<TEventType extends string = HarnessEventType> = {
  type: TEventType;
  runId: string;
  occurrenceId?: string;
  payload: Record<string, unknown>;
};
```

Use `occurrenceId` to correlate a trace/callback `HarnessEvent` with a durable replay event for the same model or tool occurrence.
