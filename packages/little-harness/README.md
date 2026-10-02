# Little Harness

Little Harness is the agent runtime package underneath Little Workflow. It provides local sessions, file/artifact handling, model/tool loop helpers, execution environments, durability events, chat connectors, and a workflow-specific harness adapter.

## Install

Little Harness requires **Node.js 22+** and **AI SDK 7**. While it is in alpha, install it from the
`alpha` dist-tag.

To create a standalone agent workspace, run the guided wizard:

```sh
npx little-harness@alpha init
```

The wizard asks for a project name, searchable AI SDK language-provider and model selection, optional
custom model id, and dependency install confirmation. It currently offers 24 provider choices: the
official AI SDK language-model providers plus a custom OpenAI-compatible API scaffold. The generated
`package.json` pins `little-harness` to the CLI's own version, `ai` to `^7.0.0`, the provider package
to an AI SDK 7-compatible range, and a TypeScript 6 toolchain — never `latest`.

To use Little Harness inside an existing app:

```sh
pnpm add little-harness@alpha ai@^7 zod @ai-sdk/<provider>
```

Use any AI SDK 7 `LanguageModel` from your provider package (for example `@ai-sdk/openai` or
`@ai-sdk/anthropic`). `createHarness()` requires a model.

`ai` is a **peer dependency** (`^7.0.0`), so your app owns the single `ai` instance. Little Harness
re-exports the `LanguageModel`, `ModelMessage`, and `UIMessage` types for code that does not import
`ai` directly. Package exports use the `default` condition (so `require()` works through Node's
`require(esm)`) and expose `little-harness/package.json`.

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

Use `little-harness` when you want the generic agent runtime primitives:

```ts
import {
  createHarness,
  generateHarness,
  localHost,
  streamHarness,
} from "little-harness";
```

Use `little-harness/workflow-harness` when you want the Little Workflow-compatible harness contract directly:

```ts
import {
  createWorkflowHarness,
  runWorkflowHarnessWithSession,
  workflowHarness,
} from "little-harness/workflow-harness";
```

Use `little-harness/connectors` when an agent folder needs optional chat connection layers:

```ts
import {
  chatSdkConnector,
  discoverConnectors,
  loadChatSdkConnector,
  loadWebRichConnector,
  webRichConnector,
} from "little-harness/connectors";
```

The connector subpath exports Chat SDK platform connectors, web-rich route helpers, connector
discovery, typed tool-authoring helpers (`harnessToolContext`), and typed tool UI helpers. It does not
make Chat SDK a required dependency for `createHarness`, `streamHarness`, or `loadHarness`.

Connector subpaths. Both `/connectors` and `/connectors/runtime` statically reach `node:fs/promises`
(through the shared `streamHarness` → skill-staging code), so a **value** import from either is
**server-only**; a **types-only** import (`import type`) from any subpath is always safe. Pick the
subpath by which helpers you need:

- `little-harness/connectors/runtime` — descriptors, loaders, session registry, tool-context helpers,
  and tool-UI types. It omits the filesystem discovery helpers, so a bundler does not statically link
  the connector-module dynamic-import machinery through it — use it in server route bundles.
- `little-harness/connectors` — the runtime surface **plus** discovery helpers. A value import
  statically links the discovery module (and its connector-module traversal) into the graph.
- `little-harness/connectors/discovery` — just `discoverConnectors`, `loadConnectorDescriptor`,
  `loadConnectorToolExtensions`, `loadConnectorToolExtensionsFromDir`.
- `little-harness/execution` — streaming helpers such as `streamHarness` with no connector code.
- `little-harness/workspace` — the agent-folder loader (`loadHarness`, `loadWorkspace`) and its
  tool/skill/workflow discovery helpers.
- `little-harness/scaffold` — the `init`/`new` scaffolders (`initWorkspace`, `scaffoldAgent`,
  `scaffoldProject`, `renderAgentSource`), the provider catalog (`resolveProvider`,
  `resolveModelChoice`), and the pinned dependency table (`scaffoldDependencyVersions`,
  `providerDependency`).

Use `little-workflow` when you want workflow authoring, planning, event-log durability, replay, and the CLI. Little Workflow uses `workflowHarness` by default, so most workflow apps do not need to import Little Harness directly.

## Execution Environments

`localHost()` runs the agent's `bash` tool in an execution environment chosen by
`executionEnvironment`. The default, `"auto"`, keeps Tier-0 just-bash in the host process only when
`runtime.python` and `runtime.javascript` are both explicitly `false` and network is off; every other
turn runs in `subprocessSandbox()` (a child process with an empty environment and a SIGKILL watchdog).
Pass `"in-process"`, `"subprocess"`, or a factory such as `tieredExecutionEnvironment({ nextTier })` to
choose explicitly. Tier-0 just-bash is a compatibility layer for trusted tool patterns, **not** an
isolation boundary — see `docs/api-reference.md` ("The Tier-0 security contract").

## Workflows As Tools

`createHarness({ workflows })` takes `HarnessWorkflow` objects and exposes each one to the model as its
own tool. Adapt a `defineWorkflow` result with `asHarnessWorkflow` from `little-workflow`
(`definitionIdentity` is required), or drop a module that default-exports one into an agent folder's
`workflows/` directory:

```ts
import { asHarnessWorkflow } from "little-workflow";

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
import { createWorkflowHarness } from "little-harness/workflow-harness";

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

Configured workflows are the happy path: you author them, review them, and expose them to the agent as callable tools. But some requests fit no configured workflow. **Dynamic workflows** let the agent author a *one-shot* plan on the fly — a step-DAG over its own tools, MCP handles, and (if it has it) agentic bash — run it once, and move on.

Opt in with `dynamicWorkflows()`, imported from `little-workflow` (this feature
needs `pnpm add little-workflow@alpha` — `little-harness` does not depend on or
re-export it):

```ts
import { createHarness, localHost } from "little-harness";
import { dynamicWorkflows } from "little-workflow";

export const harness = createHarness({
  host: localHost({ dataDir: ".little-harness" }),
  model,
  workflows: [/* your configured workflows */],
  dynamicWorkflows: dynamicWorkflows(),
});
```

> Pass the `dynamicWorkflows()` helper, **not** a bare `true`. The helper injects the plan-lowering factory from `little-workflow`; `little-workflow` depends on `little-harness`, so a boolean flag alone can't pull the factory in.

When enabled, the agent gets two extra tools:

- **`run_ad_hoc_plan`** — author and run a one-shot plan for a request no configured workflow fits. Provide a `purpose`, the `plan` (steps + `output.from`), the `input`, and an `outputSchema`. The plan runs **once, inline**, is **never** added to the workflow library, and its result is returned to the agent. The authored plan is remembered for later recall.
- **`search_authored_plans`** — recall a plan authored on a prior run (searched by purpose). Returns each plan's purpose, the frozen plan, and its last run's status/summary so the agent can re-submit it — verbatim or adapted — via `run_ad_hoc_plan`.

**The invariant:** a one-shot plan can never exceed the agent's **own capability snapshot** — the tools, MCP handles, and agentic bash the agent itself holds (skills are not a plan capability in v1). The plan is lowered to a step-DAG (`tool.call`, `ai.generate`, ...), frozen under a canonical hash, and is replay-proof. Capability drift between runs is re-checked on resubmission: a recalled plan that references a capability the agent no longer has is rejected with `capability_not_allowed`.

Narrow the surface or tune limits with options:

```ts
dynamicWorkflows({
  exclude: ["some_tool", "some_mcp_handle"], // tools/handles a plan may not use
  limits: { maxSteps: 20, maxRuntimeMs: 60_000 },
});
```

`limits` has two enforced knobs: `maxSteps` (the max steps a one-shot plan may contain; default **8**) and `maxRuntimeMs` (the wall-clock budget for a single run, after which it fails with `timeout`; default **120_000**).

**v1 limitation:** agentic bash inside a one-shot plan runs with **network disabled** (local commands only), pending a shared runtime→bash-capability normalizer. A plan that reaches for the network via bash fails at run time rather than silently getting full-internet access.

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
