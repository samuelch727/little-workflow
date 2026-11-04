# Source Map

Use source and tests to verify docs when behavior matters.

| Task | Source files |
| --- | --- |
| Public exports | `packages/little-harness/src/index.ts` (root, pinned by `src/index.test.ts`); `src/sandbox.ts`, `src/host.ts` and `src/internals.ts` for the `/sandbox`, `/host` and `/internals` subpaths |
| Harness creation and config normalization | `packages/little-harness/src/create-harness.ts`, `packages/little-harness/src/types.ts` |
| Non-streaming runs | `packages/little-harness/src/execution/generate-harness.ts` |
| Streaming chat routes | `packages/little-harness/src/execution/stream-harness.ts` |
| AI SDK messages and runtime tools | `packages/little-harness/src/runtime/messages.ts`, `packages/little-harness/src/runtime/tools.ts` |
| Local host sessions and paths | `packages/little-harness/src/local-host/` (`local-host.ts`, `paths.ts`, `session-store.ts`, `workspace-spec.ts`) |
| Sandbox modes (`HarnessSandboxMode`, the `"auto"` rule, `selectSandboxMode`) | `packages/little-harness/src/local-host/execution-environment.ts` |
| Orchestration ledgers and the five-method store | `packages/little-harness/src/local-host/durable-services.ts`, `packages/little-harness/src/local-host/durable-store.ts`, `packages/little-harness/src/local-host/in-memory-orchestration-services.ts` |
| Tier-0 runtime (in-process just-bash, `defenseInDepthForAdapter`, `bashOptionsForRuntime`) | `packages/little-harness/src/runtime/just-bash-runtime.ts` |
| Shared shell runtime and tracked-mount events | `packages/little-harness/src/runtime/shell-runtime.ts` |
| Tiered execution (`tieredSandbox`, `TIER_REFUSED_EXIT_CODE`) | `packages/little-harness/src/runtime/tiered-runtime.ts` |
| Command classification and the capability matrix | `packages/little-harness/src/runtime/command-classification.ts`, `packages/little-harness/src/runtime/tier0-capability-matrix.ts` |
| Subprocess sandbox (options, worker; the wire protocol is internal) | `packages/little-harness/src/sandbox/subprocess/` |
| Remote/file/in-memory session log and server | `packages/little-harness/src/remote-session/` |
| Turn tool assembly, workflow store paths, runtime disposal (`harness.runtime.dispose.failed`) | `packages/little-harness/src/execution/turn-tools.ts` |
| Workflows as tools (tool result compaction, run budgets) | `packages/little-harness/src/workflows.ts`, `packages/little-harness/src/utils/workflow-concurrency.ts`; the `asHarnessWorkflow` adapter lives in `@little-stack/workflow` (`src/harness-workflow.ts`) |
| Outcome capture and aggregation | `packages/little-harness/src/outcomes/` (`record.ts`, `aggregate.ts`, `types.ts`), `aggregateLocalOutcomes` in `packages/little-harness/src/trace/inspect.ts`, reactions in `packages/little-harness/src/connectors/reactions.ts` |
| Event names (including side-channel `outcome.reported`) | `packages/little-harness/src/events/names.ts` |
| File and artifact handling | `packages/little-harness/src/files/`, `packages/little-harness/src/execution/evented-file-writer.ts` |
| Persistent dirs | `packages/little-harness/src/persistent-dir/commit.ts`, `packages/little-harness/src/local-host/local-dir.ts` |
| Memory helper | `packages/little-harness/src/memory/memory.ts` |
| Skill staging | `packages/little-harness/src/skills/` |
| Trace inspection and validation | `packages/little-harness/src/trace/` |
| Error base class and stable codes (`LittleHarnessError`) | `packages/little-harness/src/errors.ts`, `packages/little-harness/src/errors-hierarchy.test.ts` |
| Durable model and tool replay | `packages/little-harness/src/events/durability.ts`, `packages/little-harness/src/events/occurrence.ts` |
| Chat connectors (descriptors, loaders, email, discovery, session registry, tool extensions, attachments, reactions, testing doubles) | `packages/little-harness/src/connectors/` (`descriptors.ts`, `chat-sdk.ts`, `email.ts`, `email-message.ts`, `web-rich.ts`, `discovery.ts`, `session-registry.ts`, `tool-extensions.ts`, `tool-context.ts`, `attachments.ts`, `reactions.ts`, `testing.ts`, `runtime.ts`, `index.ts`) |
| CLI (`init`/`new`, REPL, `test`/`connectors`/`outcomes`, provider catalog, pinned scaffold versions) | `packages/little-harness/src/cli/` (incl. `scaffold-versions.ts`, `provider-catalog.ts`, `agent-scaffold.ts`), `packages/little-harness/src/cli.ts`, `packages/little-harness/src/cli-core.ts`, `packages/little-harness/src/scaffold.ts` (the `@little-stack/harness/scaffold` subpath) |
| Agent-folder loader and workspace discovery (`loadHarness`, tool/skill/workflow discovery, tool-name policy, module loader) | `packages/little-harness/src/workspace/` (`load-harness.ts`, `discover-tools.ts`, `discover-skills.ts`, `discover-workflows.ts`, `tool-name-policy.ts`, `module-loader.ts`, `index.ts`) |
| Little Workflow adapter | `packages/little-harness/src/workflow-harness/` |
| Dynamic workflows (config, tools, authored-plans store, `define_workflow` and its store, registry hooks, allowed-caps) | `packages/little-harness/src/dynamic-workflows/` (`types.ts` incl. `AgentWorkflowRegistry`, `config.ts`, `tools.ts`, `authored-plans-store.ts`, `agent-workflow-tools.ts`, `agent-workflows-store.ts`); per-turn offers via `offeredAgentWorkflows` (in `agent-workflow-tools.ts`), allowed-capabilities and parent-snapshot bash in `src/execution/turn-tools.ts`; the plan lowering/factory and the `world` hook live in `@little-stack/workflow` (`src/dynamic-workflow-*.ts`) |
| LittleDB client (private, unpublished): tracer, registry, tracing World, resolve, eval worker, user feedback | `packages/littledb-client/src/` (`client.ts`, `resolve.ts`, `exporter.ts`, `worker.ts`, `feedback.ts`, `harness/tracer.ts`, `harness/outcome-sink.ts`, `harness/registry.ts`, `workflow/tracing-world.ts`, `contract.ts`) |
| Agent Groups (neutral launcher contract, injected tools, trusted profiles, revision fencing; the experimental `@little-stack/harness/agents` entry is `src/agents/index.ts`) | `packages/little-harness/src/agents/index.ts`, `packages/little-harness/src/agents/types.ts`, `packages/little-harness/src/agents/tools.ts`, `packages/little-harness/src/tasks/ledger.ts`, `packages/little-harness/src/execution/turn-tools.ts` |

Tests are often the fastest examples. Use:

```bash
rg "createHarness|streamHarness|generateHarness|inputType|memory|workflowHarness" packages/little-harness/src -g '*.test.ts'
rg "tieredSandbox|justBashSandbox|classifyCommand|subprocessSandbox|sandbox:" packages/little-harness/src -g '*.test.ts'
```

Package subpaths are declared in `packages/little-harness/package.json` `exports`: `.`, `./events`, `./agents` (experimental), `./connectors`, `./connectors/runtime`, `./connectors/discovery`, `./workflow-harness`, `./remote-session`, `./scaffold`, `./package.json`. The root (`src/index.ts`) does not re-export `./events` or `./remote-session`; the Agent Group port lives in `src/agents/index.ts`.
