# Little Harness

For a guided Next.js or standalone setup, including additive existing Next.js integration, use `npx @little-stack/workflow@alpha setup`. See [unified setup](../little-workflow/docs/setup.md).

Little Harness is the agent runtime package underneath Little Workflow. It provides local sessions, file/artifact handling, model/tool loop helpers, sandboxes for the agent's `bash` tool, durability events, chat connectors, and a workflow-specific harness adapter.

In the Little stack, Harness and Workflow are the SDK and LittleDB is the product: you build the agent here, and LittleDB (private for now; client in [`packages/littledb-client`](../littledb-client)) traces what it does, scores it, and improves it through one `onEvent` hook. The agent's work lives in a workspace: the folder tier is Harness's own just-bash sandbox over the user's files, and a container joins as the `nextTier` of `tieredSandbox()` only when a command needs a real machine, managed by LittleDB's hosted service (private for now) or self-hosted with Little Compute (not included in this public source snapshot). Harness runs fully without either.

## Install

Little Harness requires **Node.js 22+** and **AI SDK 7**. While it is in alpha, install it from the
`alpha` dist-tag.

To create a standalone agent workspace, run the guided wizard:

```sh
npx @little-stack/harness@alpha init
```

The wizard asks for a project name, searchable AI SDK language-provider and model selection, optional
custom model id, and dependency install confirmation. It currently offers 24 provider choices: the
official AI SDK language-model providers plus a custom OpenAI-compatible API scaffold. The generated
`package.json` pins `@little-stack/harness` to the CLI's own version, `ai` to `^7.0.0`, the provider package
to an AI SDK 7-compatible range, and a TypeScript 6 toolchain — never `latest`.

To use Little Harness inside an existing app:

```sh
pnpm add @little-stack/harness@alpha ai@^7 zod @ai-sdk/<provider>
```

Use any AI SDK 7 `LanguageModel` from your provider package (for example `@ai-sdk/openai` or
`@ai-sdk/anthropic`). `createHarness()` requires a model.

`ai` is a **peer dependency** (`^7.0.0`), so your app owns the single `ai` instance. Little Harness
re-exports the `LanguageModel`, `ModelMessage`, and `UIMessage` types for code that does not import
`ai` directly. Package exports use the `default` condition (so `require()` works through Node's
`require(esm)`) and expose `@little-stack/harness/package.json`.

Chat connectors need the Chat SDK packages in the hosting app — the `chat` runtime plus the adapter and
state packages you use:

```sh
pnpm add chat @chat-adapter/slack @chat-adapter/state-redis
```

Swap the adapter (`@chat-adapter/discord`, `@chat-adapter/telegram`, `@chat-adapter/web`, ...) and state
(`@chat-adapter/state-memory`, `@chat-adapter/state-redis`, ...) packages for the platforms you target.
Chat SDK is not required for `createHarness`, `streamHarness`, or `loadHarness`.

## License

Licensed under the [Apache License 2.0](./LICENSE).

## Which Entry Point To Use

Use `@little-stack/harness` when you want the generic agent runtime primitives:

```ts
import {
  createHarness,
  generateHarness,
  localHost,
  streamHarness,
} from "@little-stack/harness";
```

The root entry also exports the agent-folder loader (`loadHarness`, `loadWorkspace`), the sandbox
builders (`subprocessSandbox()`, `tieredSandbox()`, `justBashSandbox()`), and `harnessToolContext` for
typed tool authoring. It is a short, pinned list: everything else has its own subpath, listed below.

Use `@little-stack/harness/workflow-harness` when you want the Little Workflow-compatible harness contract directly:

```ts
import {
  createWorkflowHarness,
  runWorkflowHarnessWithSession,
  workflowHarness,
} from "@little-stack/harness/workflow-harness";
```

Use `@little-stack/harness/connectors` when an agent folder needs optional chat connection layers:

```ts
import {
  chatSdkConnector,
  discoverConnectors,
  loadChatSdkConnector,
  loadWebRichConnector,
  webRichConnector,
} from "@little-stack/harness/connectors";
```

The connector subpath exports Chat SDK platform connectors, an email connector (`emailConnector`, which
gives an agent its own address), web-rich route helpers, connector discovery, typed tool-authoring
helpers (`harnessToolContext`, also exported from the root), and typed tool UI helpers. It does not
make Chat SDK a required dependency for `createHarness`, `streamHarness`, or `loadHarness`.

Connector subpaths. Both `/connectors` and `/connectors/runtime` statically reach `node:fs/promises`
(through the shared `streamHarness` → skill-staging code), so a **value** import from either is
**server-only**; a **types-only** import (`import type`) from any subpath is always safe. Pick the
subpath by which helpers you need:

- `@little-stack/harness/connectors/runtime` — descriptors, loaders, session registry, tool-context helpers,
  and tool-UI types. It omits the filesystem discovery helpers, so a bundler does not statically link
  the connector-module dynamic-import machinery through it — use it in server route bundles.
- `@little-stack/harness/connectors` — the runtime surface **plus** discovery helpers. A value import
  statically links the discovery module (and its connector-module traversal) into the graph.
- `@little-stack/harness/connectors/discovery` — just `discoverConnectors`, `loadConnectorDescriptor`,
  `loadConnectorToolExtensions`, `loadConnectorToolExtensionsFromDir`.
- `@little-stack/harness/sandbox` — for writing your own sandbox: `createShellRuntime`, the tool
  bridges, `localSessionWorkspace`, tracked-mount helpers and tier-0 command classification
  (`classifyCommand`, `detectEmulationGap`, `tier0CapabilityMatrix`).
- `@little-stack/harness/host` — for writing or tuning a host: `createInMemoryOrchestrationServices`,
  `createDurableOrchestrationServices`, the durable stores, `LocalSessionStore`, local paths and the
  local trace readers.
- `@little-stack/harness/events` — durable event types and helpers for a custom session log
  (`HarnessSessionLog`, `DurableHarnessEventInput`, `createHarnessAppendIdempotencyKey`,
  `canonicalHarnessEventRequestDigest`, …) and the event names (`HARNESS_EVENT_TYPES`,
  `isHarnessEventType`).
- `@little-stack/harness/remote-session` — session-log implementations and the remote session-log
  client and server (`fileSessionLog`, `inMemorySessionLog`, `remoteSessionLog`,
  `startSessionLogServer`).
- `@little-stack/harness/remote-tools` — `remoteTool` contracts, `remoteTools` clients,
  `remoteToolHandler`, `serveRemoteTools` and `RemoteToolError`. Execute code and database
  credentials stay in your service. `listenRemoteTools` is in the Node-only `/server` entry.
- `@little-stack/harness/agents` — **experimental**: the Agent Group launcher port, its protocol types
  and errors, and the task-ledger projections. App code only passes `createHarness({ agents })`; import
  from here when you implement a launcher or a ledger.
- `@little-stack/harness/scaffold` — the `init`/`new` scaffolders (`initWorkspace`, `scaffoldAgent`,
  `scaffoldProject`, `renderAgentSource`), the provider catalog (`resolveProvider`,
  `resolveModelChoice`), and the pinned dependency table (`scaffoldDependencyVersions`,
  `providerDependency`).
- `@little-stack/harness/internals` — what Little Workflow and Little Compute build on. No stability
  promise; apps should not import from it.

Use `@little-stack/workflow` when you want workflow authoring, planning, event-log durability, replay, and the CLI. Little Workflow uses `workflowHarness` by default, so most workflow apps do not need to import Little Harness directly.

## Sandboxes

`localHost()` runs the agent's `bash` tool in the sandbox chosen by its `sandbox` option. The default, `"auto"`, keeps Tier-0 just-bash in the host process only when
`runtime.python` and `runtime.javascript` are both explicitly `false` and network is off; every other
turn runs in `subprocessSandbox()` (a child process with an empty environment and a SIGKILL watchdog).
Pass `"in-process"`, `"subprocess"`, or a sandbox such as `tieredSandbox({ nextTier })` to
choose explicitly. Tier-0 just-bash is a compatibility layer for trusted tool patterns, **not** an
isolation boundary — see `docs/api-reference.md` ("The Tier-0 security contract").

Where there is no disk, such as workerd serving many chats from one process,
`virtualHost({ fs })` keeps each session's workspace in the just-bash filesystem you pass, and
`justBashSandbox()` runs `bash` over it. Your app routes chats and saves each chat's filesystem;
`demos/workerd-chats` does both with a Durable Object per chat.

## Workflows As Tools

`createHarness({ workflows })` takes `HarnessWorkflow` objects and exposes each one to the model as its
own tool. Adapt a `defineWorkflow` result with `asHarnessWorkflow` from `@little-stack/workflow`
(`definitionIdentity` is required), or drop a module that default-exports one into an agent folder's
`workflows/` directory:

```ts
import { asHarnessWorkflow } from "@little-stack/workflow";

createHarness({
  host: localHost(),
  model,
  workflows: [asHarnessWorkflow(refundWorkflow, { definitionIdentity: "billing.refund@1" })],
  workflowBudgets: { maxConcurrentWorkflowRuns: 4 },
});
```

The model receives `{ status, runId, outputSummary?, outputPath? }` (failures add `causeCode` and
`message`) — `outputSummary` is a rendering of the output capped at 4096 characters, not the typed
output itself.

## Custom Workflow Harness

```ts
import { createWorkflowHarness } from "@little-stack/harness/workflow-harness";

export const cloudHarness = createWorkflowHarness({
  aiLoop: {
    async generate({ model, system, messages, tools, signal }) {
      // Call your agent loop or provider here.
      return {
        output: "done",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  },
});
```

Custom harnesses can handle any subset of workflow task kinds and return `{ kind: "delegate_to_default" }` to let Little Workflow run the built-in `workflowHarness` for that task.

## Dynamic Workflows

Configured workflows are the happy path: you author them, review them, and expose them to the agent as callable tools. But some requests fit no configured workflow. **Dynamic workflows** let the agent author a *one-shot* plan on the fly — a step-DAG over its own tools and MCP handles — run it once, and move on.

Opt in with `dynamicWorkflows()`, imported from `@little-stack/workflow` (this feature
needs `pnpm add @little-stack/workflow@alpha` — `@little-stack/harness` does not depend on or
re-export it):

```ts
import { createHarness, localHost } from "@little-stack/harness";
import { dynamicWorkflows } from "@little-stack/workflow";

export const harness = createHarness({
  host: localHost({ dataDir: ".little-harness" }),
  model,
  workflows: [/* your configured workflows */],
  dynamicWorkflows: dynamicWorkflows(),
});
```

> Pass the `dynamicWorkflows()` helper, **not** a bare `true`. The helper injects the plan-lowering factory from `@little-stack/workflow`; `@little-stack/workflow` depends on `@little-stack/harness`, so a boolean flag alone can't pull the factory in.

When enabled, the agent gets three extra tools:

- **`run_ad_hoc_plan`** — author and run a one-shot plan for a request no configured workflow fits. Provide a `purpose`, the `plan` (steps + `output.from`), the `input`, and an `outputSchema`. The plan runs **once, inline**, is **never** added to the workflow library, and its result is returned to the agent. The authored plan is remembered for later recall.
- **`search_authored_plans`** — recall a plan authored on a prior run (searched by purpose). Returns up to five plans whose last run completed, newest first and one per distinct plan, each with its purpose, the frozen plan, and its last run's summary so the agent can re-submit it — verbatim or adapted — via `run_ad_hoc_plan`.
- **`define_workflow`** — turn work that will come again into a named workflow. The agent sends an `id`, a `description`, input and output JSON Schemas, the `tools` it may use, and optionally a `policy`, the `models` slots its steps may use, and `runWith` to run it now. The agent's own model plans the steps once; from the next turn on, in every session on the same host `dataDir`, the workflow is a tool named after its id (`.` becomes `_`). Calling it again with the same id counts a new revision. Definitions are stored under `/persistent/dynamic-plans/workflows/`; runs share one store, `<dataDir>/agent-workflows`. An id whose tool name is reserved (`bash`) or belongs to another of its workflows is refused, and a stored workflow that no longer passes these checks, or whose tools are gone, is left out of that turn with a warning. `dynamicWorkflows({ define: false })` leaves the tool out.

**The invariant:** a one-shot plan can never exceed the agent's **own capability snapshot** — the tools, MCP handles, and bash grant the agent itself holds (skills are not a plan capability in v1). The plan is lowered to a step-DAG (`tool.call`, `ai.generate`, ...), frozen under a canonical hash, and is replay-proof. Capability drift between runs is re-checked on resubmission: a recalled plan that references a capability the agent no longer has is rejected with `capability_not_allowed`.

Narrow the surface or tune limits with options:

```ts
dynamicWorkflows({
  exclude: ["some_tool", "some_mcp_handle"], // tools/handles a plan may not use
  limits: { maxSteps: 20, maxRuntimeMs: 60_000 },
});
```

`limits` has two enforced knobs: `maxSteps` (the max steps a one-shot plan may contain; default **8**) and `maxRuntimeMs` (the wall-clock budget for a single run, after which it fails with `timeout`; default **120_000**).

**v1 limitation:** a plan's `ai.generate` step is one model call with no tools and no bash, even when the agent has bash. A plan reaches tools only through `tool.call` steps.

Know these boundaries before shipping:

- **`activeTools` is not an authorization ceiling for plans.** Per-call `activeTools`/`prepareStep` narrowing controls which tools the model may call *directly* that turn; within its configured snapshot, the agent decides a plan's tools by authoring the steps. For a developer-controlled ceiling use `exclude` or a harness with fewer configured tools.
- **Approval-required tools are not supported in plans.** A tool with `needsApproval` is rejected by the alpha workflow runtime with a clear error — it is not prompted.
- **Recall is shared per host `dataDir`.** Authored plans persist under `/persistent/dynamic-plans` and are visible to every session on the same `dataDir` (like `memory`). Multi-user deployments should give each user their own `dataDir`; the store path is fixed and `dynamicWorkflows()` does not expose a per-user override.

## Event Names

Durable workflow harness events use dotted names:

- `harness.session.started`
- `harness.model.responded`
- `harness.tool_call.started`
- `harness.execute_step.succeeded`

For orchestrator sub-runs, `run_workflow` and `start_workflow` reserve `payload.args.subRunId` in `harness.tool_call.started` before the child run starts, and return the same ID as `payload.result.runId` on success. (Those tools belong to Little Workflow's **deprecated** orchestrator surface. To compose workflows into an agent, use `asHarnessWorkflow` + `createHarness({ workflows })` instead — each workflow becomes its own tool.)

## Agent folders on self-hosted workerd

The build-time `@little-stack/harness/compiler` API turns the recommended
`agents/<name>/` workspace into static imports with bundled instructions and skill
assets. The generated registry accepts a per-chat host; Node `loadHarness` and
the compiled runtime share merge and validation rules. Use a host factory for
chat-local mutable tools. These APIs ship in `0.2.0-alpha.3`.

See [the standalone offline demo](../../demos/workerd-folders/README.md) for the
compiler contract, limitations, setup and real self-hosted workerd tests.
