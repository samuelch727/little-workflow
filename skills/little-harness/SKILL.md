---
name: little-harness
description: "Use when working with the little-harness package: createHarness, streamHarness, generateHarness, localHost, inputType, skills, memory, persistent dirs, files, artifacts, trace events, the session log and durability replay, execution environments (auto/in-process/subprocess modes, subprocessSandbox, tieredExecutionEnvironment, classifyCommand), chat connectors (Chat SDK, web-rich, attachments, reactions), outcome capture, workflows as tools (asHarnessWorkflow, workflowBudgets), agent folders and the little-harness CLI, or the workflow-harness adapter."
---

# Little Harness

## Overview

Use this skill to build, debug, or explain Little Harness runtimes. Little Harness is the generic agent session runtime; Little Workflow consumes its workflow-harness adapter.

## Required Checks

1. Search the docs website content and package docs first: see [package-docs.md](references/package-docs.md).
2. Verify active APIs against source when editing code: see [source-map.md](references/source-map.md).
3. Use `pnpm` for package scripts in this repo.
4. Run the narrowest relevant check after edits, usually `pnpm --filter little-harness test`, `pnpm --filter little-harness typecheck`, or a targeted Vitest file.

## Unified setup

Prefer `npx little-workflow@alpha setup` for new standalone/Next projects and additive existing Next (`--here --plan`). Harness is mandatory; `--workflow` wires a durable keyless example. Install requires `--install`; Workflow native build requires `--allow-native-build`. `--verify` forces keyless smoke. Preserve conflicts and user edits; no blanket force, major upgrades, browser userId auth, paid provisioning or deployment. Compute is unqualified and LittleDB unpublished. See `packages/little-workflow/docs/setup.md`.

## Quick Reference

| Need | Use |
| --- | --- |
| Install in an app (Node 22+, AI SDK 7) | `pnpm add little-harness@alpha ai@^7 zod @ai-sdk/<provider>` (`ai` is a peer dependency) |
| Create an agent workspace | `npx little-harness@alpha init` (pins `little-harness`, `ai@^7`, provider, TS 6 — never `latest`) |
| Script workspace creation | `little-harness init support-agents --provider openai --model gpt-5.2 --yes --no-install` |
| Script a custom OpenAI-compatible provider | `little-harness init local-agents --provider openai-compatible --model local-model --yes --no-install` |
| Initialize the current directory | `little-harness init --here --provider anthropic --model claude-sonnet-4-6` |
| Add an agent to a workspace | `little-harness new <name>` |
| Create a local runtime | `createHarness({ host: localHost({ dataDir }), model, ... })` |
| Chat/UI streaming | `streamHarness({ harness, messages, session })` |
| One-shot jobs | `generateHarness({ harness, type, input, session })` |
| Typed job modes | `inputType({ description, inputSchema?, output?, toMessages? })` |
| Stage skills | `skills: [skill("./skills/name"), skill("https://github.com/org/repo", { skills: ["name"] })]` or inline skill objects |
| MCP servers | `createHarness({ mcp: { servers: [...] } })`; defaults expose `mcp_list_tools` and `mcp_call_tool` |
| Chat connectors | `little-harness/connectors`; use `little-harness/connectors/runtime` for server route loaders/descriptors |
| Streaming helpers only | `little-harness/execution` |
| Where `bash` runs | `localHost({ executionEnvironment })`: `"auto"` (default), `"in-process"`, `"subprocess"`, or a factory (`subprocessSandbox({ ... })`, `tieredExecutionEnvironment({ nextTier })`) |
| Classify a script before running it | `classifyCommand(script, { runtime, policy })` → `run` / `escalate` / `deny`; `detectEmulationGap(result)`; `tier0CapabilityMatrix()` |
| Workflows as tools | `workflows: [asHarnessWorkflow(defineWorkflowResult, { definitionIdentity })]` (`asHarnessWorkflow` from `little-workflow`) + `workflowBudgets` |
| Record whether a run worked | `reportHarnessOutcome({ session, status })`, `createHarnessOutcomeReporter({ harness })`; read with `little-harness outcomes` / `aggregateLocalOutcomes` |
| Scaffold programmatically | `little-harness/scaffold` (`scaffoldProject`, `scaffoldAgent`, `scaffoldDependencyVersions`, ...) |
| Durable memory | `memory({ sourceDir, commit?, tool? })` |
| Persistent files | `persistentDirs: [localDir({ harnessDir, sourceDir, commit })]` |
| Workflow adapter | `little-harness/workflow-harness` |
| Dynamic workflows (agent authors one-shot plans) | `dynamicWorkflows: dynamicWorkflows()` (helper from `little-workflow`); adds `run_ad_hoc_plan` + `search_authored_plans` |
| Trace/debug | inspect `.little-harness/sessions/**/trace.ndjson` |

## Generic Harness Pattern

```ts
import { openai } from "@ai-sdk/openai";
import {
  createHarness,
  inputType,
  localHost,
  streamHarness,
} from "little-harness";
import { z } from "zod";

const harness = createHarness({
  host: localHost({ dataDir: ".little-harness" }),
  model: openai("gpt-5"),
  system: "Help users complete customer support work.",
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

export async function POST(req: Request) {
  const { messages, chatId } = await req.json();
  const result = streamHarness({ harness, messages, session: chatId });
  return result.toUIMessageStreamResponse();
}
```

## Workflow Harness Pattern

Use `little-harness/workflow-harness` only for Little Workflow-compatible harness work:

```ts
import { createWorkflowHarness } from "little-harness/workflow-harness";

export const customHarness = createWorkflowHarness({
  aiLoop: {
    async generate({ model, system, messages, tools, signal }) {
      return {
        output: "done",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  },
});
```

Return `{ kind: "delegate_to_default" }` when custom behavior should fall back to the default workflow harness.

## Dynamic Workflows Pattern

Configured `workflows` are pre-authored tools. `dynamicWorkflows` lets the agent author a **one-shot plan** for a request no configured workflow fits, run it once, and recall it later.

```ts
import { createHarness, localHost } from "little-harness";
import { dynamicWorkflows } from "little-workflow"; // helper injects the plan-lowering factory

const agent = createHarness({
  host: localHost({ dataDir: ".little-harness" }),
  model,
  tools: { docsSearch, docsRead },
  dynamicWorkflows: dynamicWorkflows(), // off by default; NOT a bare `true`
});
// Optional ceiling: dynamicWorkflows({ exclude: ["dangerousTool"], limits: { maxSteps, maxRuntimeMs } })
```

Adds two model tools: `run_ad_hoc_plan` (author + run a step-DAG plan of `tool.call`/`ai.generate` steps; returns the result) and `search_authored_plans` (recall a prior plan and re-submit it). See the docs site guide `build-agents/dynamic-workflows.mdx`.

## Implementation Notes

- `createHarness` requires `host` and `model`.
- `little-harness init` is the guided wizard for new workspaces. It asks for project name, searchable
  AI SDK language-provider/model selection, optional custom provider model id, and dependency install
  confirmation. The catalog currently offers 24 provider choices: the official AI SDK language-model
  providers plus a custom OpenAI-compatible API scaffold. Some providers require more than an API key;
  use the env vars printed by the CLI and generated in `agent.ts`.
- `little-harness new <name>` adds another agent to an existing workspace; do not present it as the
  primary new-workspace command.
- Install: Node.js >= 22; `ai` is a **peer dependency** (`^7.0.0`) — `pnpm add little-harness@alpha ai@^7 zod @ai-sdk/<provider>`. AI SDK 6 is unsupported. The root entry re-exports `LanguageModel`, `ModelMessage`, `UIMessage`. Package exports use the `default` condition (require(esm) works) and expose `./package.json`.
- AI SDK 7 names in examples that call `ai` directly: `instructions` (not `system`) for `generateText`/`streamText`, `isStepCount` (not `stepCountIs`), `onStepEnd`/`onEnd`, and tool execute options carry `context` (not `experimental_context`) — custom tools reading `callerRunIdentity`/`sequenceIndex`/`modelStepId`/a workflow `signal` read `context`. The harness's own options are unchanged: `createHarness({ system })`, `toUIMessageStreamResponse()`. `stopWhen` is a per-call `generateHarness`/`streamHarness` option (not `createHarness`), defaulting to `isStepCount(workflowBudgets.maxModelSteps ?? 20)`.
- `localHost()` defaults to `.little-harness` and stores sessions, artifacts, persistent checkouts, staged skills (`.agents/`), turns, workflow run stores (`workflows/`), and traces. It sets the optional `HarnessSession.dataDir` port field to the session folder; a custom host without `dataDir` gets `<cwd>/<sessionId>/workflows`.
- Execution modes: `localHost({ executionEnvironment })` defaults to `"auto"` (was `"in-process"` before 0.2.0): in-process just-bash only when `runtime.python` and `runtime.javascript` are both explicitly `false` and network is off; `subprocessSandbox()` otherwise (so almost always). `"in-process"`, `"subprocess"` (defaults only), or a factory override it. `subprocessSandbox({ env, watchdogGraceMs, initTimeoutMs, nodePath, workerPath })`: empty env by default (replaced, not merged), SIGKILL watchdog (5000 ms grace), 30 s init deadline; bundlers need `workerPath` or `little-harness` kept external.
- Tier-0 contract: just-bash is a **compatibility layer for trusted tool patterns, not an isolation boundary**. Never describe it as protecting against untrusted scripts. Model-authored code must not run in-process (`"auto"`/`"subprocess"` enforce this; `"in-process"` does not). The subprocess sandbox is the floor beyond pure read tools; `defenseInDepthForAdapter("subprocess")` is true and `("in-process")` false because the layer patches process-wide globals. Neither tier confines native code — use an OS sandbox behind a custom factory.
- Tiered execution (opt-in): `tieredExecutionEnvironment({ tier0?, nextTier?, policy?, matrix? })` (`tier0` defaults to in-process just-bash). Escalates when `classifyCommand` returns `"escalate"` (before running) or `detectEmulationGap` matches stderr after a Tier-0 run (retried once). Sticky; carries env + cwd only; invisible to the model (hints from Tier-0). Needed-but-unavailable tier or `policy.denyCommands` → refused with exit code 126 (`TIER_REFUSED_EXIT_CODE`). Events: `harness.runtime.tier.escalated`, `harness.runtime.tier.unavailable`, `harness.runtime.command.denied`. Unsupported commands run on Tier-0 exit 127 (`command not found`). Dispose bracket uses `snapshotTrackedMounts`/`emitTrackedMountFileChanges`.
- Disposal errors of any execution environment are reported as `harness.runtime.dispose.failed` (never thrown; `doctor` counts it as a failure).
- Harness ports break in 0.2.0: `createJustBashRuntime` takes `{ workspace }` (a `HarnessWorkspaceSpec`), not `{ session }`; `toolContext` is required when `tools` are passed to an execution-environment factory; `HarnessSession` gained `setStatus`, `markMessageStaged`, and read-only-persistent-dir accessors; `HarnessHost.kind` is a `string`.
- Workflows as tools: `createHarness({ workflows })` takes `HarnessWorkflow` objects. A `defineWorkflow` result must be wrapped: `asHarnessWorkflow(workflow, { definitionIdentity })` from `little-workflow` (`definitionIdentity` required: stable string or `{ notApplicable: true }`); `loadWorkflow(folder)` results already are HarnessWorkflows. Tool name = id segments joined by `_` (`billing.refund` → `billing_refund`). The model receives `{ status, runId, outputSummary?, outputPath? }` (failures add `causeCode`, `message`), with `outputSummary` capped at 4096 chars — never the typed output. `workflowBudgets.maxConcurrentWorkflowRuns` (10) / `maxQueuedWorkflowRuns` (100) bound inline fan-out per session (FIFO; overflow → `causeCode: "max_queued_workflow_runs"`). Agent folders discover `workflows/*.ts` default exports (must be HarnessWorkflows) via `loadHarness`/`discoverWorkflows`.
- Outcome capture: `outcome.reported` is a side-channel trace event (not in the session log). `reportHarnessOutcome({ session | sessionId+harness | tracePath, status, score?, detail?, source?, reporter?, reportKey?, retracted?, stepPath?, promptHash?, sinks? })` and `createHarnessOutcomeReporter({ harness, sinks?, source? }).report(...)` never throw (result `{ recorded, event?, delivered, failed, errors }`). Read with `aggregateLocalOutcomes({ dataDir, sessionId? })`, `aggregateOutcomes`/`foldOutcomeReports`, or `little-harness outcomes [session-id]` (rates per promptHash/stepPath with sample size `n`; `successRate` null when n = 0).
- Chat SDK connectors: `reactions` are ON by default (thumbs up/down on agent replies → outcomes, `source: "chat-sdk"`, pseudonymous reporter `anon_<16 hex>`); `reactions: false` opts out. `attachments` are on by default: inbound files become UIMessage `file` parts (10 MiB per file, `DEFAULT_ATTACHMENT_MAX_BYTES`; `attachments: { maxBytes, onSkipped }`; `false` opts out); skipped files become a text note, never a failed turn. Helpers `resolveInboundAttachments`, `createReactionOutcomeHandler`, `classifyReaction` are exported from `little-harness/connectors` (not `/runtime`).
- `little-harness/scaffold` exports `initWorkspace`, `scaffoldAgent`, `scaffoldProject`, `renderAgentSource`, `resolveProvider`, `resolveModelChoice`, `scaffoldDependencyVersions`, `providerDependency`. Scaffolds pin `little-harness` (^own version), `ai` ^7.0.0, the provider's AI SDK 7 range, and TypeScript 6 — never `latest`.
- The sandbox, tools, session log, and orchestration are decoupled ports (docs site: Runtime → Execution Environments). Execution environments are created by a `HarnessExecutionEnvironmentFactory` from a `HarnessWorkspaceSpec` (mount table + capability toggles), never from a session object; `localHost({ executionEnvironment })` swaps the factory, `localHost({ orchestration })` swaps the durable ledgers (`createInMemoryOrchestrationServices()` ships as an alternative; both backends share one ledger core over a five-method `DurableJsonStore`), and `localSessionWorkspace(session)` builds the canonical `/session`,`/artifacts`,`/persistent`,`/.agents` layout.
- `subprocessSandbox()` runs just-bash in a lazily spawned child process: exec + `js-exec` tool calls proxy over stdio to the parent's Runtime Tool Bridge, and the worker is spawned with an empty environment by default so harness credentials never reach sandboxed code. Events are identical to the in-process adapter because `createShellRuntime()` owns them once.
- The durable event log is the session's source of truth: `startSessionLogServer()` serves it over HTTP (optional bearer token) and `remoteSessionLog({ baseUrl })` is a `HarnessSessionLog` client (historical alias `HarnessDurabilitySink`; configured via `sessionLog`, alias `durability`) — a fresh process with the same `runId` resumes from the remote log alone. Multi-step turns re-call the model per step on replay; tool side effects are never re-executed.
- Developers can keep authored local skills in `./skills/<name>/`; the runtime materializes resolved skills read-only under `.agents/skills/<name>/` from the harness working directory.
- Remote skills must use explicit Git URLs, not shorthands like `org/repo` or `github:org/repo`. Omit `skills` to install all non-internal skills from the source; include a commit SHA/ref when version pinning matters because the cache is keyed by resolved commit SHA.
- Private remote skills can use per-source bearer auth or the host-level `LITTLE_SKILLS_GIT_TOKEN` plus `LITTLE_SKILLS_GIT_TOKEN_HOSTS` fallback.
- Risk gates are optional. Put `skillOidcToken` on `createHarness` or resolver defaults, and use `skillMaxRisk` globally or per source plus `skillRisk` for selected remote skill names.
- Remote Git skill failures are soft at runtime: unavailable repositories, missing selected skills, and failed remote audits skip that remote source and surface warnings. Local path/frontmatter errors remain strict.
- User tool names cannot be `bash`; the runtime injects `bash`.
- Tool handlers receive Little Harness context through AI SDK execute options: `session`, `files`, `artifacts`, `extraBody`, `abortSignal`, and replay/spooling helpers.
- MCP is exposed as ordinary AI SDK gateway tools, not a parallel execution API. Default gateway names are `mcp_list_tools` and `mcp_call_tool`; optional aliases are still normal tools.
- MCP gateway tools use the same trace, durability replay, Runtime Tool Bridge, abort signal, and `toolResultSpooling` behavior as other tools. Oversized MCP output goes through normal tool result artifacts.
- MCP guide skills are staged under `.agents/skills/<server-id>-mcp/SKILL.md` when configured. They are guidance only and do not grant capability; `mcp` config and tool visibility control access.
- Per-agent `connectors/` folders are connection layers, not harness capabilities. `loadHarness()` ignores them.
- Both `little-harness/connectors` and `little-harness/connectors/runtime` statically reach `node:fs/promises` (via the shared `streamHarness` → skill-staging code), so a value import from either is server-only; a types-only import (`import type`) from any subpath is safe. The real distinction is discovery, not `node:fs`: `/connectors/runtime` omits the filesystem discovery helpers so a bundler does not statically link the connector-module dynamic-import machinery through it — that is why it is the right server-bundle surface.
- Use `little-harness/connectors` for the full surface: connectors, web-rich routes, session helpers, tool extensions, `harnessToolContext`, tool UI types, plus the discovery helpers (`discoverConnectors`, `loadConnectorDescriptor`, `loadConnectorToolExtensions`). A value import statically links the discovery module. Explicit discovery-only import: `little-harness/connectors/discovery`.
- Use `little-harness/connectors/runtime` in server bundles for connector descriptors, route loaders, session registry, tool-context helpers, and tool-UI types. String connector ids still work because the loaders dynamically load discovery at call time.
- Prefer nested connector folders such as `agents/support/connectors/slack/connector.ts` when a connector has tool extensions, renderers, or delivery helpers. Flat `connectors/slack.ts` descriptors still work for simple connectors.
- A string connector reference like `loadChatSdkConnector({ agentDir, connector: "slack" })` is the shortest way to opt into extension discovery and portable session attachment. A statically imported descriptor object plus `connectorId` is functionally equivalent (same discovery/attachment/mirror) and is the typed option — a descriptor infers `TExtraBody`/`TUser`, a string ref is `unknown`. Neither is universally preferred; pick per route. A descriptor object without `connectorId` disables folder tools, session attachment, and mirror delivery.
- Use `extendTool(baseTool, { execute })` in `connectors/<id>/tools/<tool-name>.ts` for real connector capabilities. The folder name is the connector id and the file name is the model-facing tool id. Abstract base tools without `execute` are exposed only when the active connector provides an executable extension. The explicitly imported base wins over a same-name `tools/` base. Connector tool filenames are reserved-name validated (`bash`, `__proto__`, `constructor`, `prototype`, identifier regex).
- Read the harness execution context in a connector tool with `harnessToolContext<TExtraBody>(options)` (throws outside a run) or `tryHarnessToolContext<TExtraBody>(options)` (returns undefined). Do not cast `options`. `ctx.connector?.endpoint` is a typed `SessionConnectorEndpoint`. `ctx.extraBody` is `TExtraBody | undefined`.
- Carry connector-only tools programmatically with descriptor `tools?: ToolSet` (npm-distributed/inline connectors; loads even without `connectorId`; folder tools win per name).
- Abstract (execute-less) tools are hidden from the model on plain `streamHarness`/`generateHarness`/CLI runs too, each emitting a `{ code: "policy_warning", metadata: { reason: "abstract-tool-hidden", tool } }` warning. `bash`/runtime tools are unaffected.
- Do not put web/json-render/React presentation-only renderers in connector `tools/`; keep renderers under `ui/` or connector renderer folders. `connectors/web-rich/renderers/` is a naming convention with no runtime behavior.
- Portable connector sessions record active/passive/mirror/disabled endpoints in `/session/.harness/connectors.json`. First-class mirroring: both surfaces return the same session id, the taking-over run passes `delivery: { previousActive: "mirror" }`, and the mirror target declares a descriptor `deliver`. Explicit `delivery.deliverers[connectorId]` wins over descriptor `deliver`. Mirror delivery is successful-post-run text delivery, not live multi-surface streaming. For manual control use `attachSessionConnector`/`detachSessionConnector`/`setSessionConnectorDelivery` with `chatSdkEndpointId`/`webRichEndpointId` to build endpoint ids. Registry reads/writes are serialized only within one runtime process; multi-instance/serverless hosts need host-level locking or compare-and-swap around shared session files.
- Deploying to serverless: connector modules load via dynamic import, so set `serverExternalPackages` (little-harness, chat, adapters) and `outputFileTracingIncludes` per connector route in `next.config.ts`. Passing a statically imported descriptor object + `connectorId` + descriptor `tools` skips the dynamic connector import: this combination tolerates a missing `connectors/<id>/` folder (folder-tool discovery returns `{}` instead of throwing `Connector not found.`), so no connector files need to exist on disk — but `loadHarness` still reads the agent folder (`agent.ts`/tools/skills/instructions) from `agentDir`, so those files still need `outputFileTracingIncludes` unless you supply a custom `loadHarness`. On web-rich, pass `waitUntil` so `afterRun`/mirror delivery survive.
- Test Chat SDK connectors offline: `loadChatSdkConnector({ ..., createChat: createTestChat() })`, then `connector.simulateInbound({ thread, message })` with `createTestThread`/`createTestMessage` from `little-harness/connectors/runtime`. `simulateInbound` runs the full pipeline and bypasses the enabled-trigger check.
- CLI: `little-harness test <agent> --connector <id>` loads a connector's toolset into the REPL; `little-harness connectors <agent>` lists discovered connectors and skipped candidates; `little-harness outcomes [session-id]` aggregates `outcome.reported` events. Inspection commands (`sessions`, `trace`, `files`, `artifacts`, `diff`, `doctor`, `outcomes`) are read-only; `test` runs the model.
- For custom web tool rendering, import types from individual tool modules and use `ToolOutputPart<"tool-name", typeof import("../tools/name").default>`.
- When bash and JavaScript are enabled, configured tools are also exposed inside `js-exec` through the Runtime Tool Bridge as `tools.<name>(args)`. Use this for batched or programmatically assembled tool calls; events use `caller: "runtime"`.
- Disable runtime bridge exposure with `runtime: { toolBridge: false }`, or by disabling `javascript`/`bash`. It is not advertised when per-call `activeTools` or `prepareStep` hides `bash`.
- `streamHarness` returns a UI message stream that can be consumed once; await `finished` for trace, artifacts, persistence, and warnings. AI SDK error chunks fail the turn: `text`, `output`, and `finished` reject, partial text may have streamed, and after-turn Persistent Dir commits are skipped.
- Directory skills must have `SKILL.md` frontmatter with `name` and `description`.
- Dynamic workflows (`dynamicWorkflows`) are opt-in and injected via `dynamicWorkflows()` from `little-workflow` — a bare `true` cannot work because `little-harness` cannot import the lowering factory (circular dep). `createHarness` throws a clear error on a malformed value.
- Core invariant: a one-shot plan can never reference a capability outside the agent's own configured snapshot (tools, MCP, bash). Out-of-snapshot references fail at submit with `capability_not_allowed`; recall re-validates against the *current* snapshot. **The agent decides a plan's tools by authoring the steps** — that is the access decision, not per-call `activeTools` (a routing concern that does not restrict plans). For a developer-controlled ceiling use `dynamicWorkflows({ exclude })` or a narrower harness.
- v1 plans support only `tool.call` and `ai.generate` steps; `code.run`/`parallel`/`decision` are rejected at submit. `output.from` must name the plan's terminal step. Plans are frozen (canonical hash) and replay-proof, run **inline** (caps: `maxSteps` 8, `maxRuntimeMs` 120000, validated positive integers), and are never added to the workflow library.
- Agentic bash in a plan (an `ai.generate` step with bash) runs local commands with **network disabled** in v1 (no runtime→bash-capability normalizer yet). Skills are not a plan capability in v1.
- Authored plans persist to `/persistent/dynamic-plans` (a registered persistentDir) and recall across harness instances sharing the host `dataDir` — same scoping as `memory`; isolate multi-user recall with per-user `dataDir`s. `search_authored_plans` returns the stored `outputSchema` so a plan is re-submittable verbatim.

## Common Mistakes

- Do not omit `host: localHost(...)` in local code.
- Do not use Little Harness directly for ordinary Little Workflow authoring; use `little-workflow`.
- Do not pass `dynamicWorkflows: true`; pass `dynamicWorkflows()` from `little-workflow`. Do not rely on `activeTools` to restrict what a one-shot plan may use, and do not document skills as a dynamic-plan capability (v1 supports tools/MCP/bash only).
- Do not update package docs without checking whether `apps/little-harness-doc/content/docs/v0.1.0-alpha/` needs the same change.
- Do not pass a raw `defineWorkflow(...)` result to `createHarness({ workflows })`; wrap it with `asHarnessWorkflow`. Do not claim the workflow tool returns the typed output.
- Do not call just-bash (Tier-0) a security boundary or recommend `"in-process"` for model-authored code; do not say `localHost()` defaults to in-process.
- Do not show `createHarness({ stopWhen })`; `stopWhen` is a per-call option.
- Do not write install commands without `@alpha`, `ai@^7`, and a Node 22+ note during the alpha; do not tell users to `npm install @little-workflow/littledb` (it is unpublished — preview only).
- Do not tell the model to read author-source `./skills/...` paths inside the harness. Prompt-visible bodies are under `.agents/skills/<name>/SKILL.md`.
- Do not use GitHub/GitLab shorthand skill sources. `skill(...)` accepts local paths, local markdown files, inline files, or explicit Git URLs.
- Do not register user tools named `bash`, `constructor`, `prototype`, or `__proto__`.
- Do not import or configure MCP clients directly for declarative Harness MCP; only use `@ai-sdk/mcp` when documenting a manual client-lifetime path.
- Do not assume an undefined `type` fails. It runs and returns an `undefined_input_type` warning.
- Do not rely on trace files for secrets unless redaction settings cover the sensitive paths/metadata.
