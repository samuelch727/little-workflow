# little-harness API Reference

Little Harness is the agent runtime package underneath Little Workflow. Use it directly when you need a generic agent session runtime with tools, skills, local files, artifacts, trace events, persistent directories, and AI SDK-compatible streaming.

## Entry Points

```ts
import {
  createHarness,
  generateHarness,
  inputType,
  localHost,
  memory,
  skill,
  streamHarness,
} from "@little-stack/harness";
```

The root entry point exports only what an app needs to build and run an agent. `src/index.test.ts`
pins the list. Everything else has its own subpath:

- `@little-stack/harness/sandbox` — for writing your own sandbox: `createShellRuntime`,
  `createEnvironmentToolBridge`, `createRuntimeToolBridge`, `localSessionWorkspace`, `resolveSandbox`,
  the just-bash building blocks, tracked-mount helpers and tier-0 command classification
  (`classifyCommand`, `detectEmulationGap`, `tier0CapabilityMatrix`). The ready-made sandboxes
  (`justBashSandbox`, `tieredSandbox`, `subprocessSandbox`) stay on the root.
- `@little-stack/harness/host` — for writing or tuning a host: `createInMemoryOrchestrationServices`,
  `createDurableOrchestrationServices`, the durable stores, `resolveLocalHostPaths`, `LocalSessionStore`,
  `LocalSessionQueue`, `LocalHarnessSession`, `sessionKeyToPathKey`, `HarnessOrchestrationServices`, the
  session file writers (`createLocalFileWriter`, `createFsFileWriter`), and the local trace readers
  (`readLocalTrace`, `listLocalSessions`, `doctorSession`, …). `localHost()` and `virtualHost()` stay on
  the root.
- `@little-stack/harness/internals` — what Little Workflow and Little Compute build on (hashing and id
  helpers, skill and MCP resolution, workflow-tool plumbing, folder discovery). It has **no stability
  promise**; apps should not import from it.

Use `@little-stack/harness/workflow-harness` only when implementing or customizing the Little Workflow-compatible harness contract.

Use `@little-stack/harness/events` for the durable event contract a custom session log implements:
`HarnessSessionLog`, `DurableHarnessEventInput`, `PersistedDurableHarnessEvent`,
`createHarnessAppendIdempotencyKey`, `canonicalHarnessEventRequestDigest`,
`normalizePersistedDurableHarnessEvent`, `emitHarnessOccurrence`, the event names
(`HARNESS_EVENT_TYPES`, `isHarnessEventType`, `HARNESS_SIDE_CHANNEL_EVENT_TYPES`,
`isHarnessSideChannelEventType`), and the `HARNESS_SESSION_EVENT_*` schema versions. It does not load the model runtime. The root entry point
does not re-export these.

Use `@little-stack/harness/remote-session` for ready-made session logs and the remote session-log
service: `fileSessionLog`, `inMemorySessionLog`, `remoteSessionLog`, `startSessionLogServer`,
`createHarnessFileMutationEvents`, and the `lh.remote-session.v1` protocol helpers
(`REMOTE_SESSION_LOG_PROTOCOL_VERSION`, `RemoteSessionProtocolError`). The root entry point does not
re-export these either.

Use `@little-stack/harness/remote-tools` for tools whose code runs in your service:
`remoteTool({ name, description, inputSchema, outputSchema? })` creates a frozen contract;
`remoteTools(contracts, { endpoint, scope, headers?, context?, timeoutMs?, maxRequestBytes?, maxResponseBytes? })`
returns a ToolSet. `remoteToolHandler(contract, execute)` binds server code;
`serveRemoteTools({ tools, authenticate, onError?, maxRequestBytes? })` returns a Fetch handler.
`listenRemoteTools({ port, host?, ... })` from `/server` returns `{ server, url, port, close }`.
Every schema must validate; plain `jsonSchema()` is refused. Auth fails closed and returns a
verified `{ id, ... }` principal. `execute(input, { principal, context, call, signal })` authorizes
against principal, never context. Only bounded `RemoteToolError(message, code?)` crosses the
model boundary. Defaults are 60s timeout, 1 MiB requests and 4 MiB responses. URLs require HTTPS
except loopback. Every runtime and URL/fetch-binding endpoint uses `redirect: "manual"`.
All 3xx and `opaqueredirect` responses are refused generically without reading Location/body,
following or retrying; credentials and bodies are never forwarded to the destination.
Wire output/context/envelope serialization honors Date/toJSON and omits undefined object
properties, while refusing BigInt, non-finite numbers and classes without JSON-producing
toJSON. Output conversion precedes optional wire-schema validation. Canonical input/identity
digests remain strict and do not perform those conversions. Unexpected output errors remain
generic with the original reason delivered to server onError. Preparation failures distinguish
unsent requests from uncertain failures after fetch; no public client diagnostic hook is added.

`harnessToolContext(options).invocationId` is optionally set on the model call's own execute
options after its start gate; workflow steps use their own `idempotencyKey`. The server derives
`call.dedupeKey` from version/kind/principal/scope/session/tool/identity, and `call.inputDigest`
from validated input. The app stores these atomically with effects and rejects digest mismatch.
Same-run replays need the retained original started event: a recognized replay missing its
occurrence has no invocation ID. No log means no crash recovery of identity. New-turn retries,
bash and standalone writes need business keys. Timeouts mean uncertain outcomes.
See the [remote-tools guide](../../../apps/little-harness-doc/content/docs/v0.1.0-alpha/build-agents/remote-tools.mdx)
for authenticated headers, host retention details and examples.

Use `@little-stack/harness/agents` (**experimental**, may change between alpha releases) when you
implement an Agent Group launcher or a task ledger that projects Agent Groups: the
`HarnessAgentGroupLauncher` port, its request/result types, the `HarnessAgentGroup*Error` classes, the
`HARNESS_AGENT_GROUPS_PROTOCOL_VERSION` / `HARNESS_AGENT_GROUP_PAGES_PROTOCOL_VERSION` constants, and the
ledger projection types. App code that only configures `createHarness({ agents })` needs nothing from it
(`HarnessAgentGroupsOptions` is on the root).

Use `@little-stack/harness/connectors` when an agent folder needs optional chat connection layers:

```ts
import {
  chatSdkConnector,
  discoverConnectors,
  extendTool,
  loadChatSdkConnector,
  loadWebRichConnector,
  webRichConnector,
  attachSessionConnector,
  type ToolOutputPart,
  type ToolUI,
} from "@little-stack/harness/connectors";
```

The connector subpath is optional. It exports `chatSdkConnector`, `loadChatSdkConnector`,
`webRichConnector`, `loadWebRichConnector`, `discoverConnectors`, portable session helpers
(`attachSessionConnector`, `detachSessionConnector`, `setSessionConnectorDelivery`,
`listSessionConnectors`, `selectSessionDeliveryTargets`, `chatSdkEndpointId`, `webRichEndpointId`),
connector tool helpers (`extendTool`, `harnessToolContext`, `tryHarnessToolContext`), type helpers
for tool UI parts, and — from `@little-stack/harness/connectors` only — the inbound-attachment helpers
(`resolveInboundAttachments`, `DEFAULT_ATTACHMENT_MAX_BYTES`) and reaction-outcome helpers
(`createReactionOutcomeHandler`, `classifyReaction`, `pseudonymousReporterId`,
`DEFAULT_POSITIVE_REACTIONS`, `DEFAULT_NEGATIVE_REACTIONS`) the Chat SDK loader uses internally. It
does not make Chat SDK a required dependency for `createHarness`, `streamHarness`, or `loadHarness`.

Subpaths. Both `/connectors` and `/connectors/runtime` statically reach `node:fs/promises` (through the
shared `streamHarness` → skill-staging code), so a **value** import from either is **server-only**; a
types-only import (`import type`) from any subpath is always safe. Pick the subpath by which helpers you
need:

- `@little-stack/harness/connectors/runtime` — descriptors, loaders, session registry, tool-context helpers,
  and tool-UI types. It omits the filesystem discovery helpers, so a bundler does not statically link
  the connector-module dynamic-import machinery through it — use it in server route bundles. String
  connector ids still work because the loaders import discovery dynamically at call time.
- `@little-stack/harness/connectors` — the runtime surface plus the discovery helpers. A value import
  statically links the discovery module (and its connector-module traversal) into the graph.
- `@little-stack/harness/connectors/discovery` — just `discoverConnectors`, `loadConnectorDescriptor`,
  `loadConnectorToolExtensions`, `loadConnectorToolExtensionsFromDir`.
- `@little-stack/harness/scaffold` — the CLI scaffolders (`initWorkspace`, `scaffoldAgent`, `scaffoldProject`,
  `renderAgentSource`), provider catalog (`resolveProvider`, `resolveModelChoice`), and pinned
  dependency table (`scaffoldDependencyVersions`, `providerDependency`).

```ts
import { loadChatSdkConnector, loadWebRichConnector } from "@little-stack/harness/connectors/runtime";
import { loadHarness, streamHarness } from "@little-stack/harness";
```

`streamHarness`, `generateHarness` and the agent-folder loader (`loadHarness`, `loadWorkspace`) come
from the root entry point.

Little Harness needs Node.js 22+ and takes `ai` as a **peer dependency** (`^7.0.0`):
`pnpm add @little-stack/harness@alpha ai@^7 zod @ai-sdk/<provider>`. The root entry re-exports the
`LanguageModel`, `ModelMessage`, and `UIMessage` types. Package exports use the `default` condition and
expose `@little-stack/harness/package.json`. Chat connectors also need the Chat SDK packages installed in the
app: `pnpm add chat @chat-adapter/slack @chat-adapter/state-redis` (swap the adapter/state packages for
your platforms).

A string connector reference is the shortest way for a route to opt into connector folder discovery:

```ts
import { loadChatSdkConnector } from "@little-stack/harness/connectors/runtime";

const supportSlack = await loadChatSdkConnector({
  agentDir: "agents/support",
  connector: "slack",
});
```

That lets Little Harness load `agents/support/connectors/slack/connector.ts`, discover
`agents/support/connectors/slack/tools/*` extensions, and attach the active endpoint to the portable
session registry. A statically imported descriptor object plus `connectorId` is **functionally
equivalent** — same folder discovery, session attachment, and mirror delivery — and it is the **typed**
option: a descriptor reference infers `TExtraBody` (and `TUser` for web-rich), while a string reference
is typed `unknown`. Pick per route; neither form is universally preferred.

## Minimal Harness

```ts
import { openai } from "@ai-sdk/openai";
import { createHarness, localHost, streamHarness } from "@little-stack/harness";

const harness = createHarness({
  host: localHost({ dataDir: ".little-harness" }),
  model: openai("gpt-5"),
  system: "Help the user complete document-heavy work.",
  tools: {
    // AI SDK tools go here.
  },
});

export async function POST(req: Request) {
  const { messages, chatId } = await req.json();

  const result = streamHarness({
    harness,
    messages,
    session: chatId,
  });

  return result.toUIMessageStreamResponse();
}
```

`createHarness` requires a `host` and `model`. For local development, use `localHost({ dataDir })`; it stores sessions under `.little-harness/` by default. Where there is no disk, such as workerd with a Durable Object per chat, use `virtualHost({ fs })`: it keeps each session's workspace (`/session`, `/artifacts`, `/persistent`, `/.agents`) and its status in the just-bash filesystem you pass, and your app saves that filesystem between turns. `dataFs` chooses where `localDir()` and memory keep their backing folders: an `IFileSystem` or async `(sessionId) => IFileSystem` factory, defaulting to the session's `fs`, under `/.little-harness/data/` outside bash's view. Sharing `dataFs` shares folders without making writes transactional across sessions; cross-Durable-Object sharing is the app's job. Virtual sources must be relative POSIX paths without `..`; `projectDir()` still needs `localHost()`. Enable `dynamicWorkflows()` from `@little-stack/workflow` on `virtualHost()` to run one-shot plans and defined workflows without disk: the default World is `virtualWorld` over the host's `dataFs`, with run files and kept plans under `dataRoot` (default `/.little-harness/data/`). Persistence follows the app's filesystem save policy; Worlds sharing storage must receive the same filesystem object so their in-process locks coordinate. On workerd, just-bash loads its browser build, so `python3`, `node` (`js-exec`), `sqlite3`, `tar`, `yq` and `xan` are not available. See the "Run on workerd" docs page and `demos/workerd-chats`.

## `createHarness(...)`

```ts
const harness = createHarness({
  host,
  model,
  system,
  tools,
  mcp,
  skills,
  inputTypes,
  persistentDirs,
  memory,
  chat,
  runtime,
  workflows,
  workflowBudgets,
  dynamicWorkflows,
  skillMaxRisk,
  skillOidcToken,
  agents,
  checkpoints,
  toolResultSpooling,
  trace,
  sessionLog,
  onEvent,
  onTraceError,
  onPersistenceError,
});
```

Important fields:

| Field | Purpose |
| --- | --- |
| `host` | Session and runtime host. Use `localHost()` for filesystem-backed local sessions. |
| `model` | AI SDK language model used by `generateHarness` and `streamHarness`. |
| `system` | Optional system prompt as a string or model messages. |
| `tools` | AI SDK `ToolSet`; user tool names must match `[A-Za-z_][A-Za-z0-9_-]{0,63}` and cannot be `bash`, `checkpoint`, or one of the five Agent Group tool names, even when `checkpoints` or `agents` is not configured. |
| `mcp` | Declarative MCP server config. Little Harness exposes configured servers through ordinary gateway tools, usually `mcp_list_tools` and `mcp_call_tool`. |
| `skills` | Skill directories, inline skill files, or `skill(...)` values staged under `.agents/skills/<name>/`. |
| `inputTypes` | Named input adapters created with `inputType(...)`. |
| `persistentDirs` | Developer-backed directories mounted under `/persistent/...`. |
| `memory` | Opt-in long-term memory: a Persistent Dir of plain files, listed in every turn's prompt, with a built-in `memory` skill. |
| `runtime` | Enables or restricts Bash runtime capabilities such as Python, JavaScript, network, and Runtime Tool Bridge exposure. Under `localHost()`'s default `"auto"` sandbox these toggles also pick the sandbox (see [Choosing a sandbox](#choosing-a-sandbox)). |
| `workflows` | `HarnessWorkflow` objects exposed to the agent as callable tools (one named tool per workflow). Adapt a `defineWorkflow` result with `asHarnessWorkflow(workflow, { definitionIdentity })` from `@little-stack/workflow`; see [Workflows As Tools](#workflows-as-tools). |
| `workflowBudgets` | Partial `HarnessWorkflowBudgets`. `maxConcurrentWorkflowRuns` (default 10) and `maxQueuedWorkflowRuns` (default 100) bound inline workflow-tool fan-out per session; `maxModelSteps` (default 20) is the default `stopWhen` step count. |
| `dynamicWorkflows` | Opt-in model-authored one-shot plans. Pass `dynamicWorkflows()` from `@little-stack/workflow` (never a bare `true`); adds the `run_ad_hoc_plan`, `search_authored_plans` and `define_workflow` tools and a durable plan store under `/persistent/dynamic-plans`; each workflow the agent defines with `define_workflow` is a tool of its own in later turns and sessions on the same host `dataDir` (`dynamicWorkflows({ define: false })` leaves `define_workflow` out). A plan can never exceed the agent's own tools/MCP/bash snapshot (skills are not a plan capability in v1; drift is re-checked on resubmission as `capability_not_allowed`). Boundaries: per-call `activeTools` narrowing does not restrict what a plan may use (use `exclude` or a narrower harness); authored-plan recall is shared by every session on the same host `dataDir` (per-user isolation = per-user `dataDir`); a plan's `ai.generate` step is one model call with no tools or bash, so plans reach tools only through `tool.call` steps. |
| `skillMaxRisk` / `skillOidcToken` | Optional remote-skill risk gate and the OIDC token it uses (see [Skills](#skills)). |
| `agents` | Optional neutral Agent Group launcher, trusted profile/join/reduction declarations, and hard bounds. Injects `start_agent_group`, `spawn_agent`, `watch_agent_group`, `join_agent_group`, and `cancel_agent_group`; absent means no Agent Group tools. |
| `checkpoints` | Optional trusted `{ writer }` port for environment milestones. Injects `checkpoint`; the writer owns state, tier, identity, verification, and retention. |
| `trace` | Trace capture/redaction options or `false` to disable persisted traces. |
| `sessionLog` | The session log (`HarnessSessionLog`, from `@little-stack/harness/events`): the append-only durable event log a run appends to and replays from. |
| `onTraceError` | Called with `(error, event)` when a trace event cannot be written. |

`stopWhen`, `prepareStep`, `toolChoice`, `activeTools`, and the other AI SDK loop controls are per-call
options of `generateHarness` / `streamHarness`, not `createHarness` options. `stopWhen` takes AI SDK 7
stop conditions and defaults to `isStepCount(workflowBudgets.maxModelSteps)` (20):

```ts
import { isStepCount } from "ai";

streamHarness({ harness, messages, stopWhen: isStepCount(8) });
```

## Checkpoints

Configure `checkpoints: { writer }` to expose one `checkpoint` tool. The model may supply a label,
`goal_reached | pre_risky_op` kind, rationale, and evidence Artifact ids. The trusted writer receives the
Harness-supplied session, turn, model-step, sequence position, and deterministic `callIdentity`; agents cannot
choose state, tier, timestamps, cost, retention, or a `verified_green` verdict.

The writer's `checkpoint(request)` returns `HarnessCheckpointResult` with the same session, call identity,
and kind, plus the chosen milestone id, tier, and `created | replayed | coalesced` disposition. Exact retries
keep their call identity and resolve to the original milestone. A semantically redundant new call may
coalesce to an existing milestone while retaining its own call identity; milestone id is not a call key.
Little Compute's Direction-v2 local profile compares the current compatible checkpoint head, not arbitrary
historical matching trees, and preserves the original milestone's Harness position. A changed tree or meaningful
annotation creates a new node, including a return to an older tree after an intervening change. The retained
advanced profile keeps its existing non-coalescing replay behavior.

## Agent Groups

Agent Groups are an orchestration contract for ordered fan-out into isolated agent environments. Little
Harness owns model-facing policy, task projection, idempotent identities, bounded reductions, and stale
observation fencing. A launcher adapter owns the actual runtime: it can target processes, containers,
microVMs, a remote scheduler, or another implementation without importing that system into Little Harness.
The five generated names stay reserved for configured and discovered user tools even when Agent Groups are
not configured, but the resolved manifest and turn toolset list/inject them only when `agents` is present.

```ts
import { createHarness, localHost } from "@little-stack/harness";
import {
  HarnessAgentGroupLaunchRejectedError,
  type HarnessAgentGroupLauncher,
} from "@little-stack/harness/agents";

const launcher: HarnessAgentGroupLauncher = {
  async startAgentGroup(request) {
    // Atomically accept every ordered member or none. Persist and deduplicate
    // request.callIdentity; retries after response loss have identical identities.
    return scheduler.start(request);
  },
  async watchAgentGroup(request) {
    return scheduler.watch(request);
  },
  async joinAgentGroup(request) {
    return scheduler.join(request);
  },
  async cancelAgentGroup(request) {
    return scheduler.cancel(request);
  },
};

const harness = createHarness({
  host: localHost(),
  model,
  agents: {
    launcher,
    profiles: [{
      handle: "repo-worker",
      description: "Bounded repository worker with no production credentials.",
      resourcesHandle: "cpu-medium",
      secretsHandle: "repo-readwrite",
      toolsHandle: "code-and-browser",
      networkHandle: "package-registries",
      priorityHandle: "interactive",
    }],
    joinPolicies: [
      { handle: "all", policy: { kind: "all_success" } },
      {
        handle: "verified",
        policy: { kind: "first_verified" },
        verifierHandle: "signed-check-verifier",
        requiredCheckSetHandle: "repo-checks-v1",
      },
    ],
    defaultJoinPolicyHandle: "all",
    reductionPolicies: [{
      handle: "concise",
      maxMemberSummaryBytes: 16_384,
      maxGroupSummaryBytes: 32_768,
      maxResultRefs: 32,
    }],
    defaultReductionPolicyHandle: "concise",
    limits: {
      maxMembers: 32,
      maxPromptBytes: 65_536,
      maxGroupPromptBytes: 2_097_152,
      maxDeadlineMs: 3_600_000,
      maxJoinWaitMs: 30_000,
    },
  },
});
```

The model selects only declared `profileHandle`, `joinPolicyHandle`, and
`reductionPolicyHandle` values. Resource, secret, tool, network, verifier, check-set, and priority
bindings come from trusted application configuration; raw capability requests are rejected. Generated JSON
schemas enumerate valid handles and trusted descriptions without exposing internal capability bindings.
`spawn_agent` is exactly a one-member lowering to the same atomic group port. Reservations fan out
concurrently, with both per-member and aggregate prompt-byte bounds.

Launcher requirements:

- `startAgentGroup` must be atomic and idempotent by `callIdentity`, and external group refs must be unique.
  Harness atomically commits the accepted group ref, immutable member count, and every member ref to one
  durable authority before task-file mirrors. Only
  `HarnessAgentGroupLaunchRejectedError` proves that no member was accepted. Any other error is treated as
  indeterminate response loss, leaves reservations queued, and is safe to retry with the same identities.
- `acceptedAt` cannot predate the Harness reservations or exceed bounded clock skew into the future.
- Every watch/join/cancel snapshot carries a monotonic `groupRevision`; every member carries a monotonic
  `revision`. Reusing a revision requires byte-consistent snapshot data. Lower revisions, conflicting equal
  revisions, group regressions, and terminal member changes fail closed. Orchestration backends apply the
  ordered projection under one group fence, so a late watch cannot overwrite a newer join. The Local Host
  durable backend commits a single per-group authority record before mirroring individual task files; reads
  overlay the authority, so a crash during mirroring resumes from the complete committed snapshot.
- Join `disposition`, group summary, and result refs have a separate digest bound to `groupRevision`. A watch
  may precede join at the same revision, but conflicting same-revision reductions fail closed.
- Adapter output is a bounded summary protocol, not a child transcript channel. Unknown fields, raw output,
  foreign/reordered task refs, oversized summaries, duplicate or foreign result refs, and invalid timestamps
  are rejected before model context or the task ledger is updated.
- `first_verified` is meaningful only through a trusted join-policy declaration bound to both a verifier and
  required check set. A successful member supplies a receipt with an opaque ref and matching verifier/check-set
  handles. Bare adapter booleans and receipts under other policies are rejected; the model sees only derived
  `verified: true`. `terminal` and `deadline` join dispositions are checked against actual member state.
- Adapter `taskRef` values are internal correlation identifiers and are omitted from start/watch/join/cancel
  model output. Start output retains model-usable Harness `taskId` values.
- Once a task is bound to an external Agent Group, generic task-ledger mutation/cancellation is rejected.
  Use `cancel_agent_group` or a newer revision-fenced launcher observation so durable authority cannot disagree
  with an apparently successful task mutation.
- The four methods above are the `HARNESS_AGENT_GROUPS_PROTOCOL_VERSION` snapshot contract (up to 1,024
  members). For larger groups a launcher adds the optional `paged: { watch, join, cancel }` capability: one
  object, so the type enforces all three page methods or none. Paged requests carry
  `HARNESS_AGENT_GROUP_PAGES_PROTOCOL_VERSION`, and the task ledger must also implement the page projection
  methods.
- The Agent Group errors extend `LittleHarnessError` with a stable `code`:
  `"agent_group_launch_rejected"`, `"page_call_limit"` (`HarnessAgentGroupPageCallLimitError`), and
  `"invalid" | "expired" | "mismatch"` (`HarnessAgentGroupCursorError`).

`join_agent_group` waits only up to the configured/requested bound. It does not create an implicit durable
continuation; callers that need cross-turn wakeup should use their scheduler/session integration around the
launcher port.

Custom task ledgers remain compatible when Agent Groups are unused. Atomic start-binding and observation-
projection methods are optional capabilities that are required and checked only when `agents` is configured.

## Harness Events

`onEvent` callbacks receive a `HarnessEvent`. A harness event is the trace/callback envelope for something that happened during a session turn: session start/completion, model calls, tool calls, runtime commands, file writes, artifact creation, persistent dir commits, and related failures.

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

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Trace schema version. Local traces currently use `lh.trace.v2`. |
| `eventId` | Unique id for this emitted trace/callback event. |
| `sequence` | Monotonic sequence number within the local trace file. |
| `occurrenceId` | Correlation id for one logical occurrence, such as a specific model call or tool call. Durable replay events use the same occurrence id. |
| `type` | Dotted event name, for example `harness.model.called` or `harness.tool_call.succeeded`. |
| `sessionId` | Harness session id. Pass a stable `session` to group multiple turns. |
| `turnId` | Turn id for the current `generateHarness` or `streamHarness` call. |
| `stepId` | Optional model step id for multi-step model/tool loops. |
| `parentEventId` | Optional parent event id for nested event relationships. |
| `timestamp` | ISO timestamp for when the event was emitted. |
| `metadata` | Event-specific details, redacted according to trace options. |

`HarnessEvent` does not carry the durable replay payload directly. Durable
replay uses `DurableHarnessEventInput`, which requires
`{ type, runId, appendIdempotencyKey, occurrenceId? }` plus exactly one of
`payload` or `payloadArtifactId`. Trace/callback events expose details through
`metadata`; durable events store replay-matching data or an immutable Artifact
reference.

## `generateHarness(...)`

Use `generateHarness` for one-shot work, jobs, tests, server actions, and Little Workflow nodes.

```ts
import { z } from "zod";
import { inputType, generateHarness } from "@little-stack/harness";

const harness = createHarness({
  host: localHost(),
  model,
  inputTypes: {
    "support.ticket_triage": inputType({
      description: "Triage one support ticket.",
      inputSchema: z.object({ id: z.string(), body: z.string() }),
      toMessages: ({ input }) => [
        { role: "user", content: `Triage ticket ${input.id}:\n\n${input.body}` },
      ],
    }),
  },
});

const result = await generateHarness({
  harness,
  type: "support.ticket_triage",
  input: { id: "TCK-1", body: "Customer cannot export invoices." },
  session: "ticket:TCK-1",
});

if (result.status === "completed") {
  console.log(result.text);
  console.log(result.output);
}
console.log(result.trace.path);
```

If `type` is not defined in `inputTypes`, the run still proceeds and returns an `undefined_input_type` warning.

Pass `trigger: { kind, source?, from?, label? }` (`HarnessTrigger`) to record how the turn started,
for example `{ kind: "message", source: "whatsapp", from: "+15550100" }`. It goes on
`harness.session.started` as string metadata (`triggerKind`, `triggerSource`, `triggerFrom`,
`triggerLabel`), never in the session log or the prompt, and LittleDB shows it on the turn. The
schedules runner, the Chat SDK, email and web connectors, the agent server and the REPL set one; a
trigger you pass wins. Redact `triggerFrom` with `trace.redaction.metadataKeys` if it is personal data.

## `streamHarness(...)`

Use `streamHarness` for chat routes and UI message streaming.

```ts
const result = streamHarness({
  harness,
  messages,
  session: chatId,
});

return result.toUIMessageStreamResponse();
```

The returned UI message stream can be consumed once. Await `result.finished` for session, artifacts, trace, persistence, and warnings after streaming completes.

`streamHarness` takes the same `trigger` option as `generateHarness`.

`result.textStream` is an `AsyncIterable<string>` of assistant text deltas (reasoning and protocol chunks skipped), like AI SDK `streamText`'s `.textStream`, for non-AI-SDK consumers such as chat frameworks, CLIs, and queues. It is the surface the Chat SDK connector loader posts to a platform thread (`thread.post(result.textStream)`). It shares the same underlying stream, so consume `textStream` or `toUIMessageStream*()` — not both.

Pass `uiMessageStream.onError` to customize the text emitted for AI SDK `error`
chunks. Public web routes can keep the default masked message; local developer
tools can return `error instanceof Error ? error.message : String(error)` for
more actionable CLI output. Stream error chunks fail the turn: `result.text`,
`result.output`, and `result.finished` reject, partial text may already have
reached the client, and after-turn Persistent Dir commits run only for
successful turns.

## Chat Connectors

Per-agent `connectors/` folders contain connection layers, not model capabilities. They are ignored by
`loadHarness()` and loaded only through `@little-stack/harness/connectors` or
`@little-stack/harness/connectors/runtime`.

Use `chatSdkConnector(...)` with `loadChatSdkConnector(...)` for Chat SDK platforms such as Slack,
Telegram, Discord, Teams, WhatsApp, and Chat SDK web text mode. Platform history is text-only by
default, and rich tool UI parts are not reconstructed from Chat SDK thread history.
Direct messages and mentions are enabled by default; set `mention: false` for direct-message-only
connectors.

Files attached to the **incoming** message become UIMessage `file` parts, so they reach
`chat.stageMessage` (to be written into the session filesystem) and the model's context. Bytes come
from the attachment's `data` or its `fetchData()` — which is where a platform's private-URL
authentication lives — never from fetching `url` directly. Attachments on *older* history messages
are not re-inlined. Each file is capped at 10 MiB (`attachments: { maxBytes }`); an attachment that
is oversized, unfetchable, or byte-less is replaced by a short note in the message text and reported
to `attachments: { onSkipped }` — it never fails the turn. Set `attachments: false` to opt out.

Thumbs-up / thumbs-down reactions on the agent's replies are recorded as run outcomes **by default**
whenever the Chat instance exposes `onReaction` (see [Outcome Capture](#outcome-capture)). Set
`reactions: false` to opt out, or pass `{ positive, negative, onRemoved, session, reporterId, sinks,
onOutcome }` to tune it. The reporter is stored as a pseudonym (`anon_<16 hex>` of a SHA-256 of
`platform:userId`), never a handle.

```ts
// agents/support/connectors/slack/connector.ts
import { createSlackAdapter } from "@chat-adapter/slack";
import { createRedisState } from "@chat-adapter/state-redis";
import { chatSdkConnector } from "@little-stack/harness/connectors/runtime";

export default chatSdkConnector({
  userName: "support",
  adapter: { name: "slack", create: () => createSlackAdapter() },
  state: () => createRedisState(),
  triggers: {
    directMessage: true,
    mention: { subscribe: true },
    subscribedMessage: true,
  },
});
```

```ts
// app/api/slack/route.ts
import { waitUntil } from "@vercel/functions";
import { loadChatSdkConnector } from "@little-stack/harness/connectors/runtime";

const supportSlack = await loadChatSdkConnector({
  agentDir: "agents/support",
  connector: "slack",
});

export async function POST(req: Request) {
  return supportSlack.webhook(req, { waitUntil });
}
```

`loadChatSdkConnector(...)` returns the created Chat SDK adapter as `adapter` for platform-specific
hooks such as Discord Gateway listeners. The generic `webhook(req)` path still handles HTTP
interactions and forwarded Gateway events.

Use `emailConnector(...)` to give an agent its own email address. It is a Chat SDK connector with email
defaults: mail to `address` starts a run, each email thread is one session, and the reply goes back in
the same thread. `senders` is required, and by default an email must come from an allowed sender, pass
DMARC according to the `Authentication-Results` header of the receiving server named by
`senders.authServId` (required while `requireDmarc` is on), and not be an auto-reply before the agent
sees it. Quoted earlier messages are removed and the
full email is saved to `/session/email/<id>.txt`.

```ts
// agents/support/connectors/email/connector.ts
import { createRedisState } from "@chat-adapter/state-redis";
import { emailConnector } from "@little-stack/harness/connectors/runtime";
import { createResendAdapter } from "@resend/chat-sdk-adapter";

export default emailConnector({
  address: "support@agents.example.com",
  adapter: {
    name: "resend",
    create: () => createResendAdapter({ fromAddress: "support@agents.example.com" }),
  },
  state: () => createRedisState(),
  senders: { allow: ["@example.com"], authServId: "your-receivers-authserv-id" },
});
```

Point Resend's `email.received` webhook at a route that calls `loadChatSdkConnector(...).webhook(req)`.
Options: `accept`, `transform`, `maxRepliesPerThread` (default 20), `requireAddressedTo` (default
`true`), `readEmail`, and `onSkip`. See the Email Connector guide for the full walkthrough and for
finding the authserv-id. Unverified in this alpha: no real email has been received through Resend
Inbound yet, and whether Resend adds `Authentication-Results` (and its authserv-id) is unconfirmed.

Use nested connector folders when a connector owns extra files:

```txt
agents/support/connectors/slack/
  connector.ts
  tools/
    add-reaction.ts
```

Connector tool extensions use the folder name as the connector id. The tool filename is the
model-facing tool id:

A tool `execute(input, options)` receives the AI SDK `ToolExecutionOptions` with the Little Harness context
(`session`, `files`, `artifacts`, `connector`, `extraBody`, ...) spread on. Read it with
`harnessToolContext<TExtraBody>(options)` — typed, no casts — or `tryHarnessToolContext` for a tool that
may also run standalone (returns `undefined` outside a harness run):

```ts
// agents/support/connectors/slack/tools/add-reaction.ts
import addReaction from "../../../tools/add-reaction";
import { extendTool, harnessToolContext } from "@little-stack/harness/connectors/runtime";

type SupportExtraBody = { slack: SlackClient };

export default extendTool(addReaction, {
  execute: async ({ emoji }, options) => {
    const ctx = harnessToolContext<SupportExtraBody>(options);
    await ctx.extraBody?.slack.reactions.add({
      emoji,
      channel: ctx.connector?.endpoint?.threadId,
    });
    return { ok: true };
  },
});
```

`ctx.connector?.endpoint` is a typed `SessionConnectorEndpoint`. `extendTool` keeps the base the author
imported over a same-named `tools/` base. A connector distributed as an npm package can carry tools on
the descriptor via `tools?: ToolSet` (loaded even without `connectorId`; folder tools win per name).

Base executable tools remain available everywhere. Abstract tools without `execute` are exposed only
when the active connector has an executable extension — this rule now holds on plain
`streamHarness`/`generateHarness`/CLI runs too, each hidden tool emitting a `policy_warning` with
`reason: "abstract-tool-hidden"`.

For web text mode, use Chat SDK's Web adapter and return `webhook(req)` directly to the browser:

```ts
import { createRedisState } from "@chat-adapter/state-redis";
import { createWebAdapter } from "@chat-adapter/web";
import { chatSdkConnector } from "@little-stack/harness/connectors/runtime";

export default chatSdkConnector({
  userName: "support",
  adapter: {
    name: "web",
    create: () => createWebAdapter({ userName: "support", getUser }),
  },
  state: () => createRedisState(),
  triggers: { directMessage: true },
  history: "latest",
});
```

Chat SDK connector history can use thread history, Chat SDK transcripts, a custom history callback,
or the latest message. Raw `useChat` request history belongs to `webRichConnector(...)`.

Use `webRichConnector(...)` with `loadWebRichConnector(...)` for a browser route that should return
Little Harness `UIMessage.parts` directly. This preserves live tool-call states and typed tool output
parts for custom React or JSON-rendered UI.

```ts
export default webRichConnector({
  authenticate: async (request) => {
    const user = await getUser(request);
    return user ? { id: user.id, name: user.name } : null;
  },
  session: ({ body, user }) => `web:${user.id}:${body.id}`,
  history: { source: "request" },
  extraBody: ({ user }) => ({ userId: user.id }),
});
```

```ts
import { loadWebRichConnector } from "@little-stack/harness/connectors/runtime";

const supportWeb = await loadWebRichConnector({
  agentDir: "agents/support",
  connector: "web-rich",
});

export async function POST(req: Request) {
  return supportWeb.POST(req);
}
```

`POST` returns a bodyless `400` (invalid/missing `id`/`messages`), `401` (`authenticate` returned
`null`), or `500` (any other failure), calling the descriptor `onError` first. On serverless hosts pass
`loadWebRichConnector({ ..., waitUntil })` so the fire-and-forget `afterRun` and mirror delivery are not
frozen after the response stream ends. Both loaders return the resolved descriptor as `.descriptor`.

For custom web tool rendering, import types from individual tool modules:

```ts
import type { UIMessage } from "ai";
import type { ToolOutputPart, ToolUI } from "@little-stack/harness/connectors";

export type LookupOrderTool = typeof import("../tools/lookup-order").default;

export type SupportUITools = {
  "lookup-order": ToolUI<LookupOrderTool>;
};

export type SupportUIMessage = UIMessage<unknown, never, SupportUITools>;
export type LookupOrderOutputPart = ToolOutputPart<"lookup-order", LookupOrderTool>;
```

The tool name string must match the auto-discovered tool filename. Add `outputSchema` to tools with
custom renderers so output types stay precise.

Connectors can share one portable session by returning the same session id. When a connector id is
available, Little Harness records each run's endpoint in `/session/.harness/connectors.json` with a
delivery state: `active` (live reply), `passive` (resumable, no delivery), `mirror` (post-run text
copy), or `disabled`. The first-class mirror flow needs no manual registry calls: both surfaces resolve
the same session id, the taking-over run passes `delivery: { previousActive: "mirror" }` to keep the
prior surface mirrored, and the mirror target declares a descriptor `deliver` describing how to post to
itself. Per target, an explicit `delivery.deliverers[connectorId]` wins over the target's descriptor
`deliver`. Missing deliverers are skipped, failed harness runs do not mirror, and delivery failures are
reported to `delivery.onError` without failing the active response. A `mirror`/`disabled` surface that
answers one turn is restored to its prior state afterward, so one reply no longer drops it out of
mirroring.

For manual control, use `attachSessionConnector(session, input, { previousActive? })`,
`detachSessionConnector(session, ref)`, and `setSessionConnectorDelivery(session, ref, delivery)`. Build
`ref.endpointId` with `chatSdkEndpointId(adapterName, threadId)` / `webRichEndpointId(userId,
conversationId)` so refs match what the loaders write.

Registry updates are serialized inside one runtime process. Hosts that run the
same session across multiple serverless instances need a host-level lock,
compare-and-swap, or other shared concurrency control around session files. A corrupt registry file is
preserved as `connectors.recovered-*.json`, reset to empty, and logged once via `console.warn`.

## Outcome Capture

An outcome is an application's (or a user's) verdict on a run: `"success"`, `"failure"`, or
`"partial"`. It is recorded as an `outcome.reported` event appended to the session trace — an
observation written onto a finished run, never an input to it, so it is not part of the durable
session log.

```ts
import { createHarnessOutcomeReporter, generateHarness, reportHarnessOutcome } from "@little-stack/harness";

// One-off: grade the session a run used.
const result = await generateHarness({ harness, messages, session: "chat_123" });
await reportHarnessOutcome({ session: result.session, status: "success", score: 0.9 });

// Bound once to a harness (and optional sinks), then report by session id.
const outcomes = createHarnessOutcomeReporter({ harness, sinks: [mySink] });
await outcomes.report({ sessionId: "chat_123", status: "failure", detail: "wrong refund amount" });
```

Reporting **never throws**: it resolves to `{ recorded, event?, delivered, failed, errors }`. Fields
include `retracted`, `score`, `detail`, `source` (default `"programmatic"`), `reporter` (keep it
pseudonymous), `reportKey` (reports sharing a key supersede each other — the latest wins), `stepPath`,
`turnId`, and `promptHash` (resolved from the session's last `harness.model.called` when omitted).
`sinks` are best-effort `HarnessOutcomeSink`s (`{ name?, deliver(event) }`) — a failing sink is counted,
never propagated.

Read rates back with `aggregateLocalOutcomes({ dataDir, sessionId? })` (Local Host traces) or
`aggregateOutcomes(events)` / `foldOutcomeReports(events)` over events you already hold. The result
reports `overall`, `byPromptHash`, and `byStepPath` success rates with their sample size `n`
(`successRate` is `null`, not 0, when `n` is 0), plus superseded/retracted counts. The CLI equivalent is
`little-harness outcomes [session-id]`.

Chat SDK connectors record reactions as outcomes by default (`source: "chat-sdk"`); see
[Chat Connectors](#chat-connectors).

## Input Types

`inputType(...)` defines reusable typed work modes. A type can validate input, provide default structured output, add instructions, and convert host input into model messages.

```ts
inputType({
  description: "Summarize one uploaded contract.",
  inputSchema,
  output,
  instructions: "Prefer exact clause references.",
  toMessages: async ({ input, files, session, extraBody }) => [
    { role: "user", content: `Summarize ${input.contractName}.` },
  ],
});
```

## Skills

Skills can be passed as directory paths or inline file sets.

```ts
createHarness({
  host: localHost(),
  model,
  skills: [
    skill("./skills/customer-research"),
    skill("https://github.com/anthropics/skills", {
      skills: ["frontend-design"],
    }),
    {
      name: "inline-policy",
      description: "Use when applying the current policy.",
      files: {
        "SKILL.md": "---\nname: inline-policy\ndescription: Use when applying the current policy.\n---\n\nFollow policy.",
      },
    },
  ],
});
```

Directory skills must contain `SKILL.md` with `name` and `description` frontmatter. Resolved skills are staged read-only under `.agents/skills/<name>/` before input types run.

Remote skills must use explicit Git URLs, including GitHub URLs, GitLab tree URLs, generic HTTPS Git URLs, SSH URLs, and scp-style Git URLs. Shorthands such as `org/repo`, `github:org/repo`, and `gitlab:org/repo` are rejected. The `skills` option selects skill names like `npx skills add URL --skill frontend-design`; when omitted, every non-internal skill in the source is installed. The cache is keyed by resolved commit SHA, so include a commit SHA or ref when you need a specific version.

Private Git sources can pass `auth: { type: "bearer", token: process.env.GIT_TOKEN }`. As a host-level fallback, set `LITTLE_SKILLS_GIT_TOKEN` and restrict where it is sent with `LITTLE_SKILLS_GIT_TOKEN_HOSTS`. Risk gates are optional; when configured, pass `skillOidcToken: process.env.VERCEL_OIDC_TOKEN`. `skillMaxRisk` can be configured globally, at harness or role level, or per `skill(...)`, and `skillRisk` can set policy for selected remote skill names inside a `skill(...)` call.

## MCP Gateway Tools

Pass `mcp` to `createHarness()` when the agent should use MCP servers. MCP is not a parallel execution API; Little Harness turns configured servers into ordinary AI SDK gateway tools.

```ts
const harness = createHarness({
  host: localHost({ dataDir: ".little-harness" }),
  model,
  mcp: {
    servers: [
      {
        id: "figma",
        description: "Read Figma design context and screenshots.",
        transport: {
          type: "stdio",
          command: "node",
          args: ["./mcp/figma.mjs"],
        },
        guide: {
          description: "Use when a task depends on live Figma design context.",
          body: "Call `mcp_list_tools`, then `mcp_call_tool` with server `figma`.",
        },
      },
    ],
  },
});
```

By default the gateway tools are named `mcp_list_tools` and `mcp_call_tool`. They use the same model tool-call path, Runtime Tool Bridge path, trace events, abort signal, durability replay, and `toolResultSpooling` behavior as any other configured tool.

When `guide` is enabled, Little Harness stages a guide skill under `.agents/skills/<server-id>-mcp/SKILL.md`. That skill is guidance only; it does not grant MCP access. Tool availability is controlled by the `mcp` config and normal tool visibility.

## Tools, Files, and Artifacts

The runtime exposes user tools plus an injected `bash` tool. Tool `execute` handlers receive Little Harness context through the AI SDK tool execution options:

```ts
import { harnessToolContext } from "@little-stack/harness";

execute: async (input, options) => {
  const { files, artifacts } = harnessToolContext(options);
  await files.writeText("/session/result.txt", "hello");
  const ref = await files.writeJSON("/artifacts/query/result.json", input, {
    artifact: true,
  });
  const readBack = await artifacts.read(ref.path);
  return { artifactPath: ref.path, bytes: readBack.content.byteLength };
}
```

`harnessToolContext(options)` reads the context typed, without a cast, and throws when the tool runs
outside a Little Harness turn; `tryHarnessToolContext(options)` returns `undefined` instead.

### Runtime Tool Bridge

When the built-in just-bash runtime has JavaScript enabled, Little Harness also exposes configured tools inside `js-exec` as `tools.<name>(args)`. This Runtime Tool Bridge is enabled by default for non-`bash` tools when `bash` is visible to the model:

```bash
js-exec -c 'const rows = await tools.queryCustomers({ plan: "enterprise" }); console.log(rows.path ?? JSON.stringify(rows))'
```

Use this path when the model needs to batch many similar tool calls, build complex inputs programmatically, or combine tool output with scripts before returning a compact answer. The model can still call tools directly through the provider. The bridge adds a lower-token path through the same configured tool registry.

Bridge calls share the same tool execution context, oversized result spooling, trace capture, abort signal, and durability replay as ordinary tool calls. Trace and durable payloads use `caller: "runtime"` and scope replay by the parent `bash` tool call id, so repeated identical `tools.x(args)` calls inside different bash commands do not collide.

MCP gateway tools are bridge-callable too:

```bash
js-exec -c 'const result = await tools.mcp_call_tool({ server: "figma", tool: "get_design_context", args: { fileKey: process.env.FILE_KEY } }); console.log(JSON.stringify(result))'
```

Disable the bridge with:

```ts
createHarness({
  host,
  model,
  tools,
  runtime: { toolBridge: false },
});
```

The bridge is also unavailable when `runtime.javascript === false`, when `runtime.bash === false`, or when a per-call `activeTools` / `prepareStep` setting hides `bash` from the provider.

Oversized tool results are automatically spooled to `/artifacts/tool-results`
unless disabled with `toolResultSpooling: false`. The compact response includes
the artifact path, byte count, media type, preview, line/character counts, and a
bounded JSON structure sketch when the stored content can be parsed as JSON.

Stable virtual paths:

- `/session/` private workspace for the current session.
- `/artifacts/` generated files and large tool outputs.
- `.agents/skills/` staged read-only skill directories. From the default shell cwd, use the relative `.agents/skills/...` path advertised in prompts.
- `/persistent/` opt-in persistent directories.

## Persistent Dirs and Memory

Use `persistentDirs` when your app owns persistence explicitly.

```ts
import { localDir, projectDir } from "@little-stack/harness";

createHarness({
  host: localHost({ dataDir: ".little-harness", projectRoot: process.cwd() }),
  model,
  persistentDirs: [
    localDir({
      harnessDir: "/persistent/project-notes",
      sourceDir: projectDir("notes"),
      commit: "manual",
    }),
  ],
});
```

Any Persistent Dir (and `localDir`) takes `canWrite({ extraBody })`, checked when the turn loads it:
when it returns false the dir is mounted read-only for that turn and its `store` is skipped.

Use `memory(...)` for long-term memory the agent keeps itself. It mounts `/persistent/memory`,
shows the agent a short note and one line per file every turn (the file's frontmatter
`description`, or the start of its text), and adds a built-in `memory` skill on how to save,
change and forget memories. There is no memory tool: the agent edits files with its file tools.

```ts
createHarness({
  host: localHost(),
  model,
  memory: memory({
    sourceDir: "memory/customer-agent",
    description: "What this agent has learned about each customer account.",
  }),
});
```

Commit modes are `after-turn`, `manual`, and `read-only`. Pass an array for layers (each with its
own `harnessDir`), `canWrite({ extraBody })` to make a memory read-only for a turn, `backend: { load,
store }` in place of `sourceDir` to keep it in another service, `instructions` for guidance shown
every turn (up to 4096 characters), and `skill: false` to leave the built-in skill out. A skill
named `memory` in `skills` replaces the built-in one. With `runtime: { bash: false }` the harness
adds `load_skill` (when the turn has skills) and `list_files`, `read_file`, `write_file` and
`delete_file` limited to the memory folders. See the docs site guide `build-agents/memory`.

## Workflows As Tools

`workflows` takes `HarnessWorkflow` objects — the harness side of the workflow protocol. Each one
becomes a model tool named from its id (dotted segments sanitized and joined with `_`, so
`billing.refund` → `billing_refund`) whose input schema is the workflow's input schema.

```ts
import { anthropic } from "@ai-sdk/anthropic";
import { createHarness, localHost } from "@little-stack/harness";
import { asHarnessWorkflow } from "@little-stack/workflow";
import { refundWorkflow } from "./refund"; // a defineWorkflow(...) result

const support = createHarness({
  host: localHost(),
  model: anthropic("claude-opus-4-7"),
  system: "Call billing_refund for refund requests, then tell the customer the outcome.",
  workflows: [asHarnessWorkflow(refundWorkflow, { definitionIdentity: "billing.refund@1" })],
  workflowBudgets: { maxConcurrentWorkflowRuns: 2 },
});
```

- **A raw `defineWorkflow` result is not a `HarnessWorkflow`.** Adapt it with `asHarnessWorkflow`
  (from `@little-stack/workflow`). `definitionIdentity` is required: a stable string you bump when the
  workflow's behavior changes, or `{ notApplicable: true }`. Folder workflows loaded with
  `loadWorkflow(...)` already are `HarnessWorkflow`s with a folder-derived identity.
- **Agent folders discover them.** `loadHarness()` imports each `workflows/*.ts` module in an agent
  folder (tests/specs skipped) and appends its default export — which must be a `HarnessWorkflow`, for
  example `asHarnessWorkflow(...)` — to the agent's configured `workflows`.
- **The model sees a compact result, not the typed output.** A completed call returns
  `{ status: "completed", runId, outputSummary?, outputPath? }`; `outputSummary` is the output rendered
  as text and capped at 4096 characters. A failed or cancelled call returns `{ status, runId,
  causeCode, message, outputSummary? }`. Read the full typed output from the workflow's run records.
- **Fan-out is bounded per session.** Parallel workflow tool calls share
  `workflowBudgets.maxConcurrentWorkflowRuns` (default 10); excess calls wait in a FIFO queue up to
  `maxQueuedWorkflowRuns` (default 100). Past that, the call fails with
  `causeCode: "max_queued_workflow_runs"` instead of failing the turn.
- **Run stores live with the session.** A turn's workflow event stores are written under the session
  data dir — `<dataDir>/sessions/<session>/workflows` with `localHost()`, which sets the optional
  `HarnessSession.dataDir` port field. A custom host that leaves `dataDir` unset gets
  `<cwd>/<sessionId>/workflows`.

## Sandboxes and the Session Log

The sandbox, tools, session log, and orchestration are decoupled ports (see
`docs/trace-and-durability.md` for durability and
https://little-harness.dev/docs/v0.1.0-alpha/runtime/execution-environments for the full contract).

```ts
import {
  createHarness,
  generateHarness,
  localHost,
  subprocessSandbox,
} from "@little-stack/harness";
import {
  fileSessionLog,
  remoteSessionLog,
  startSessionLogServer,
} from "@little-stack/harness/remote-session";

// Always run agent bash in a child process with a stripped environment
// (the default "auto" mode already does this for any turn that can run code or reach the network).
const host = localHost({
  dataDir: ".little-harness",
  sandbox: subprocessSandbox({ initTimeoutMs: 10_000 }),
  // orchestration: myDatabaseBackedServices, // optional ledger override
});

// Keep the run's durable log outside the process for kill-and-resume.
const server = await startSessionLogServer({
  store: fileSessionLog({ path: "sessions.ndjson" }),
  authToken: process.env.SESSION_LOG_TOKEN,
});
const result = await generateHarness({
  harness: createHarness({ host, model }),
  messages,
  runId: "run_123",
  sessionLog: remoteSessionLog({ baseUrl: server.url, authToken: process.env.SESSION_LOG_TOKEN }),
});
```

`sessionLog` is the option name on `createHarness`, `generateHarness`, and `streamHarness`; its type
is `HarnessSessionLog` from `@little-stack/harness/events`. `HarnessOrchestrationServices` (from
`@little-stack/harness/host`) is the ledger contract a host's `orchestration` option takes.
The remote protocol is strictly versioned as `lh.remote-session.v1`.
`remoteSessionLog()` retries network, timeout, rate-limit, and server failures
with the exact same serialized body (three attempts by default). The caller's
`appendIdempotencyKey` is never generated or replaced by the client, server, or
store, so a response lost after commit resolves to the original event.

Custom `HarnessSessionLog` emitters must select a stable key before transport:

```ts
import { createHarnessAppendIdempotencyKey } from "@little-stack/harness/events";

await sessionLog.append({
  type: "app.review.requested",
  runId,
  appendIdempotencyKey: createHarnessAppendIdempotencyKey({
    runId,
    eventType: "app.review.requested",
    logicalEventId: `comment:${commentId}:revision:${revision}`,
  }),
  occurrenceId: `comment:${commentId}`,
  payload: { commentId, revision },
});
```

The in-memory, fsynced file, remote, and Little Compute PostgreSQL stores all
enforce the same `(runId, key, canonical request digest)` contract. A file log
rebuilds that index on restart. It is single-process, treats newline as the
commit marker, truncates only a final unterminated fragment, rejects malformed
complete records and sequence gaps, and by default fsyncs both file and parent
directory before acknowledgement. An unsupported fsync fails closed;
`sync: false` is explicitly not crash durable. Use bounded
`afterSequence`/`limit` replay for services; Little Compute additionally returns
anchor-bound opaque page cursors. Inline PostgreSQL payloads are capped at 64
KiB by default; store larger JSON as an Artifact and append
`payloadArtifactId`.

Custom sandboxes implement `HarnessSandboxFactory`
and should build on `createShellRuntime` + `createEnvironmentToolBridge` so
they emit the same `harness.runtime.command.*` / `harness.tool_call.*` /
`harness.file.*` traces as the built-in adapters.

For an adapter that commits file mutations outside the built-in writer, use
`createHarnessFileMutationEvents()` from `@little-stack/harness/remote-session` only
after the remote file result is durable. It is the shared serializer for
created, updated, deleted, written-by-tool, and artifact-created event metadata.
Pass a stable `occurrenceId` allocated for that exact mutation before event
transport; all projections share it, while a later identical write gets a new
identity. This prevents content-identical mutations from sharing a durable
append key.
It rejects noncanonical paths and version contradictions, accessors/symbols/
non-JSON values, JSON deeper than 64 levels or larger than 10,000 nodes/256 KiB,
strings larger than 64 KiB, keys larger than 1 KiB, paths larger than 4 KiB, and
source/media/artifact labels larger than 1 KiB before emitting an event.

### Choosing a sandbox

`localHost({ sandbox })` accepts a sandbox factory or one of three modes (`HarnessSandboxMode`):

| Value | Sandbox |
| --- | --- |
| unset (default) | same as `"auto"` |
| `"auto"` | per turn, by the rule below |
| `"in-process"` | in-process just-bash for every turn (the pre-0.2 default) |
| `"subprocess"` | `subprocessSandbox()` with its defaults |
| a factory | whatever you inject, e.g. `subprocessSandbox({ ... })`, `tieredSandbox({ ... })` or `justBashSandbox()` |

`"auto"` stays in-process only when the turn can neither execute
model-authored code nor reach the network — that is, when `runtime.python` and
`runtime.javascript` are both explicitly `false` and `runtime.network` is unset
or `false`. Everything else gets the subprocess sandbox.

Note that just-bash enables python and javascript by default, so **`"auto"`
resolves to the subprocess sandbox for almost every real configuration**.
Staying in-process is an opt-in for read-only tool turns. Turning off
javascript also drops the Runtime Tool Bridge, which only exists for `js-exec`:

```ts
// Subprocess sandbox: python/javascript are on by default.
const coder = createHarness({ host: localHost(), model });

// In-process: no code execution, no network.
const reader = createHarness({
  host: localHost({ sandbox: "auto" }), // "auto" is also the default
  model,
  runtime: { python: false, javascript: false },
});
```

The rule is applied per turn against the turn's effective `runtime` options, so a per-call
`runtime` override on `generateHarness`/`streamHarness` can move one turn across the boundary.

The `"subprocess"` string takes no options. Pass `subprocessSandbox({ ... })`
as the factory when the worker needs `nodePath`, `workerPath`, `env` (replaces
the default empty environment), `watchdogGraceMs` (default 5000), or
`initTimeoutMs` (default 30000). Bundlers do not include the worker module;
bundled consumers pass `workerPath` or keep `little-harness` external.

### The Tier-0 security contract

Tier-0 is just-bash: bash emulated in JavaScript over a virtual filesystem. It
is a **compatibility layer for trusted tool patterns, not an isolation
boundary.** Commands never touch the real filesystem, real processes, or real
sockets, so ordinary tool scripting is contained by construction — but the
containment is a library's parser and virtual FS, not the OS. Treat it as
protection against mistakes, not against an adversary.

The rules that follow from that:

- **Model-generated arbitrary code must not run in-process.** `js-exec` and
  python execute guest code inside the host process, sharing its heap, event
  loop, and credentials. `"auto"` (the default) and `"subprocess"` enforce this
  by routing such turns to the sandbox. `"in-process"` does **not** — it runs
  them in the host process, so reserve it for trusted, read-only tool turns.
- **The subprocess adapter is the floor for anything beyond pure read tools.**
  It spawns the worker with an **empty environment**, so the parent's API keys
  and tokens never reach the sandbox; it enforces a parent-side **SIGKILL
  watchdog** for workers whose event loop is wedged; and it speaks a
  line-delimited **stdio JSON protocol**, so the child only ever receives a
  workspace spec and command strings — never sessions, tool implementations, or
  credentials. Tool calls made from guest code are proxied back to the parent,
  which owns every tool implementation.
- **Hardening differs by adapter, on purpose.** just-bash's `defenseInDepth`
  layer (`defenseInDepthForAdapter`) is on in the subprocess worker and off
  in-process. It patches *process-wide* globals — `globalThis.performance`,
  `process.env`, `process.exit`, `Function`, `eval` — for the duration of a
  command, and irreversibly freezes `JSON` and `Math`. In an embedded host that
  is not merely noisy but fatal: a host async hook reading
  `performance.now()` during a command throws, and Node's own fatal-error path
  then calls the equally-blocked `process.exit`, taking the process down. In a
  dedicated worker process it costs nothing, so that is where it runs.
- **Neither tier confines native code.** Nothing in Tier-0 is a substitute for
  an OS-level sandbox (container, VM, microVM) when running genuinely untrusted
  workloads.

### Tier-0 command classification

`classifyCommand(script, options)` decides, **before anything executes**,
whether a shell script can run on Tier-0. It is the escalation signal
`tieredSandbox` acts on; on its own it never runs anything.

```ts
import { classifyCommand, detectEmulationGap } from "@little-stack/harness/sandbox";

classifyCommand("rm -rf build && cargo build");
// {
//   decision: "escalate",
//   reasons: [
//     { kind: "needs-real-exec", command: "cargo", reason: "build-toolchain" },
//     { kind: "tier0-supported", commands: ["rm"] },
//   ],
// }
```

`decision` is `"run"`, `"escalate"`, or `"deny"`, and every classification
carries at least one machine-readable reason. **An unsupported command is not an
error.** Run on Tier-0, just-bash reports `cargo build` as `exit 127` with
`bash: cargo: command not found`, indistinguishable from a command that is
genuinely missing; `escalate` says instead
that the script is well-formed and a real environment would run it. Deciding
before execution is the point: discovering `cargo` by running the script
discovers it *after* `rm -rf build` already happened, and re-running the same
script on another tier repeats the destructive prefix.

Reason kinds: `tier0-supported`, `empty-script`, `unknown-command`,
`needs-real-exec`, `capability-disabled`, `policy-blocked`, `dynamic-command`,
`opaque-script`, `parse-failed`, `classifier-unavailable`. A command that just-bash
*could* emulate but whose toggle is off (`curl` with `runtime.network` unset)
yields `capability-disabled` and escalates — a tier with egress runs it. Only
`policy-blocked` (from `policy.denyCommands`) denies.

The decision reads `tier0CapabilityMatrix()`, whose command table is derived from
just-bash's own registry at load time and whose builtin and needs-real-exec halves
are pinned data with drift tests. Notably, **there is no git emulation at all** —
every git subcommand escalates.

Classification cannot be complete: it cannot see the contents of `./build.sh`, a
command passed as an argument to a runner (`xargs cargo build`), or which flags
each emulated command implements. `detectEmulationGap(result)` is the back-stop
for those — given a finished execution it returns a typed
`{ kind: "emulation-gap", signal, command }` when the failure is just-bash's own
command-resolution or option-parser miss. It matches **stderr**, not the exit code
(a pipeline's status is its last command's). Because stderr is writable by the
script itself, a consumer must bound this signal to **one escalation per command**.

It does not close the flag gap entirely: only commands that reject through
just-bash's shared option parser produce a matchable line. A command that ignores
a flag it does not implement (`grep --include=x` exits 1 with empty stderr) is
invisible to both layers, and Tier-0 returns a wrong-but-plausible result.

### Tiered execution

`tieredSandbox(options)` is a sandbox factory that
presents **one** sandbox to the harness while owning a Tier-0 adapter and a
lazily-provisioned higher tier behind it, switching between them mid-turn. It is
opt-in: pass it as `localHost({ sandbox })`; nothing about `"auto"` (the
default), `"in-process"`, or `"subprocess"` changes. Pass
`tier0: subprocessSandbox()` to keep the hardened Tier-0 adapter — `tier0`
defaults to in-process just-bash.

```ts
import { localHost, subprocessSandbox, tieredSandbox } from "@little-stack/harness";

localHost({
  sandbox: tieredSandbox({
    tier0: subprocessSandbox(),        // defaults to justBashSandbox() (in-process)
    nextTier: myRealSandbox,           // any HarnessSandboxFactory
    policy: { denyCommands: ["docker"] },
  }),
});
```

**The switch is invisible to the model.** System hints come from the Tier-0
runtime verbatim — they feed the system prompt, and `promptHash` replay of a
recorded run would break if a tier switch moved a byte — and every command is
traced by the single `createShellRuntime` wrapped around both tiers, so all tiers
emit identical `harness.runtime.command.*` events. Escalation is reported
out-of-band on `harness.runtime.tier.escalated` /
`harness.runtime.tier.unavailable` (and `harness.runtime.command.denied`), which
carry the classification reasons and never reach the prompt. When the turn's
sandbox is disposed, one `harness.runtime.usage` event records the tier the turn
reached, the commands per tier and the active tier's `usage()`
(`HarnessSandboxUsage`), which is what LittleDB prices compute on.

Two signals move a turn up a tier:

- **Classification, before anything runs.** A `classifyCommand` decision of
  `"escalate"` switches tiers *before* the first side effect exists.
- **An emulation gap, after a Tier-0 run.** `detectEmulationGap` on a finished
  Tier-0 result escalates and retries **the same command once**. That bound is
  the containment: stderr is script-writable, so a forged
  `bash: cargo: command not found` costs exactly one extra attempt and can never
  loop. The retry re-runs a command that already ran on Tier-0, which is why
  classification exists — it is the path that avoids repeating side effects.

Escalation is **sticky**: once a turn is on the higher tier, every later command
goes there. What crosses the switch is **env + cwd, nothing else** — read from
the outgoing tier with `pwd` + `export -p` and replayed into the incoming one as
`cd` + `export`, through the same shell port every tier already implements (so a
tier this package has never seen can still hand its state over). Variables the
tier itself owns (`PATH`, `HOME`, `PWD`, `OLDPWD`, `SHELL`, `SHLVL`, `IFS`, `_`)
are deliberately dropped: just-bash's `PATH=/usr/bin:/bin` describes a machine
that does not exist. Non-exported shell variables, functions, and aliases do not
survive a command boundary on Tier-0, so they have nothing to carry.

When escalation is required and the higher tier cannot be provisioned — it threw,
its `cd` replay failed, or no `nextTier` was configured at all — the command is
**refused, not run**: `exitCode: 126` (`TIER_REFUSED_EXIT_CODE`) with a
`little-harness:` stderr line naming the reason. Tier-0 keeps serving commands it can run, and the failed tier is not
retried for the rest of the turn. A gap discovered *after* a Tier-0 run is the
one exception: that command already ran, so its real Tier-0 result is returned
unchanged. Policy-denied commands (`policy.denyCommands`) are refused the same
way, on every tier.

### Environment teardown

The turn disposes its sandbox in a `finally` block, before the MCP
gateway closes. Disposal is where an environment does its last real work — reaping
a sandbox child, closing a remote session, syncing a sandbox workspace back to the
host — so a failure there is data loss and must be visible. It is reported as one
**`harness.runtime.dispose.failed`** event carrying the standard trace error
envelope under `metadata.error`, and `little-harness doctor` counts it as a
failure. Disposal failures still never throw and never mask the turn's own
outcome; emitting the event is itself best effort.

An environment that mutates a tracked mount *outside* a `bash` command — a
sandbox writing the session directory back at dispose — should bracket that write
the way the `bash` tool does, so the trace records the same file events:

```ts
import { snapshotTrackedMounts, emitTrackedMountFileChanges } from "@little-stack/harness/sandbox";

const before = await snapshotTrackedMounts(workspace);
await syncSandboxWorkspaceBack();
await emitTrackedMountFileChanges({ workspace, before, emit, files });
```

`emitTrackedMountFileChanges` re-snapshots by default and diffs by content hash,
so rewriting identical bytes emits nothing. It emits `harness.file.created`,
`harness.file.updated`, and `harness.file.deleted` for `trackChanges` mounts only.

`tieredSandbox` already does this for you: it brackets its own
disposal with the same diff, so a higher tier that writes to a mount at teardown
is reported without the tier itself doing anything (a turn that never escalated
skips the bracket — there is no higher tier to have written). A sub-tier cannot
do it —
`tieredSandbox` hands every sub-tier the workspace with
`trackChanges` stripped, so only the tiered runtime still knows which mounts the
host asked to track.

## Common Mistakes

- Always provide `host: localHost(...)` when using `createHarness` locally.
- Do not register a user tool named `bash`; the runtime injects it.
- Do not consume `streamHarness().toUIMessageStream()` or `.toUIMessageStreamResponse()` more than once.
- Pass a stable `session` when a chat or job needs file continuity.
- Prefer `inputType(...)` for structured jobs; raw `type` strings without definitions run but warn.
- Keep skill directories small enough to stage into the session workspace.
- Do not pass a raw `defineWorkflow(...)` result to `workflows`; wrap it with `asHarnessWorkflow(workflow, { definitionIdentity })`.
- Do not expect a workflow tool to hand the model its typed output; it returns `outputSummary` (at most 4096 characters).
- Do not treat `sandbox: "in-process"` (Tier-0 just-bash in the host process) as an isolation boundary.
- Custom tools that read `callerRunIdentity`, `sequenceIndex`, `modelStepId`, or a workflow `signal` read them from the AI SDK 7 `context` execute option (formerly `experimental_context`).


## Persistent turn budgets and provider fences

`turnLimits.accounting` defaults to `"run"`, preserving per-run limits. Opt into
`"logical-turn"` with `maxSteps`, `maxCostUsd` and the app's trusted `price` function
for one allowance across approval parks/resumes/restarts. The generic Harness owns
`orchestration.turnBudgets`; its opaque `budgetRef` is saved with each continuation.
The initial trusted `runId` plus session identify the origin. Keep accounting mode
and limits stable through every resume. Concrete V2/V3/V4 model handles and dynamic
`prepareStep.model` overrides are metered at actual provider invocation boundaries.

Each real SDK-visible provider invocation first durably reserves a unique occurrence.
A reservation does not prove that the provider was called or billed. Known valid
response usage is priced using the response-reported model identity when supplied
(and otherwise the configured model); the chosen identity is saved in `pricedModel`. It is settled once before the response/stream finish is delivered.
Replayed completed responses and tool effects incur no invented model charge; genuine
reinvocations do count again. A count-only budget (no `maxCostUsd`) may continue
after an unknown response: every retained reservation still consumes one step,
and it is never rewritten as zero usage or zero cost. This permits SDK retries
after a transient provider error without resetting the step allowance.
With a cost ceiling, any pending reservation or unknown usage/pricing stops with
typed `BudgetStateUnavailable`, not `CostLimitExceeded`. An HTTP status or
`APICallError.isRetryable` is not a zero-usage certificate; transport failures,
aborts and partial streams likewise retain unknown spend. Missing or corrupt
accounting stops both modes. No automatic refund or allowance reset follows an uncertain call.
A host may opt in to `turnLimits.refusedBeforeEffect(error, { provider, modelId })`: asked
only when the provider call itself rejects (never for an abort, an error inside a begun
stream, or a stream without usage), a `true` settles the reservation as `refused`
(`refusal: "host-attested"`, no usage, no cost, still one step). A throwing hook counts as
`false`, and a ledger without `refuse` keeps the attempt held. Approved parked
tool replay is allowed at a reached limit; the next provider call is refused.

The dollar limit is an after-response threshold, not a hard prepaid spend cap: a
crossing call can finish, and provider-internal retries/billing remain opaque.
Deadlines remain per run. Standard file storage fsyncs budget writes and origin
journals before acknowledging them; memory is instance-only. Custom five-method
stores work per run; logical mode requires optional `writeJsonDurable` with durable
acknowledgement semantics. Private single-process file roots are required; use a
transactional store for distributed writers. Whole-storage rollback is not detected.

`generateHarness`, `streamHarness` and `resumeParked` accept an additive trusted async
`beforeInvocation` fence. Its rejection blocks actual provider entry; record failures
and cancellation are checked again after awaiting it. Aliases with the fence are
refused; pass concrete model handles. `onEvent` remains observational.
