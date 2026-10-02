# Changelog

All notable changes to this project are documented here.

Little Workflow is in its **alpha phase**: breaking changes to the LWIR wire
format, public APIs, and persistence formats are expected between alpha releases.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the
project will adopt [Semantic Versioning](https://semver.org/) guarantees once it
reaches beta. Versions apply to both published packages, `little-workflow` and
`little-harness`, which are released together. `@little-workflow/littledb` is not
published yet: it needs a littleDB service that is not public.

## [Unreleased]

## [0.2.0-alpha.0] - 2026-10-01

The first npm release since `0.1.0-alpha.1`, and the first Apache-2.0 release on
npm (`0.1.0-alpha.2` was tagged in the repository but never published). Both
packages now run on **AI SDK 7** and **Node.js 22+**.

### Breaking changes

- **AI SDK 7.** `ai` is a peer dependency (`^7.0.0`) of both packages instead of a
  bundled dependency: install `ai@^7` and an AI SDK 7 provider package. AI SDK 6
  is no longer supported.
- **Node.js >= 22**, the AI SDK 7 floor.
- **`localHost()` defaults `executionEnvironment` to `"auto"`** (was
  `"in-process"`): a turn that can run model-authored code or reach the network
  runs in the subprocess sandbox. Pass `executionEnvironment: "in-process"` to keep
  the old behavior.
- **Turn-failure semantics.** A mid-stream provider `error` chunk now fails the
  turn in `streamHarness`/`generateHarness`: `result.text`, `result.output`, and
  `result.finished` reject, and after-turn Persistent Dir commits are skipped.
- **Abstract (execute-less) tools are hidden from the model** on every run path,
  not just connector-loaded runs; each emits a `policy_warning`.
- **Harness ports.** `createJustBashRuntime` takes `{ workspace }` instead of
  `{ session }`, and `toolContext` is required when `tools` are provided at the
  factory boundary. `HarnessSession` gains `setStatus`, `markMessageStaged`, and
  the read-only-persistent-dir accessors; `HarnessHost.kind` widens to `string`.
- **Tool context key.** Harness and workflow code that calls a tool directly now
  passes its context on the AI SDK 7 `context` execute option (was
  `experimental_context`). Custom tools reading `callerRunIdentity`,
  `sequenceIndex`, `modelStepId`, or a workflow `signal` from
  `experimental_context` must read `context`.
- **Workflow stores of harness turns** live under the session data dir
  (`<dataDir>/sessions/<session>/workflows`) instead of
  `<cwd>/<sessionId>/workflows`. Runs recorded under the old path are not found on
  resume.
- **The orchestrator composition surface is deprecated** (`LWF_DEP_ORCHESTRATOR`):
  `plan_workflow`/`run_workflow`/`start_workflow` and
  `runWorkflow({ workflows, orchestrator })`. Compose with `defineWorkflow` ->
  `asHarnessWorkflow` -> `createHarness({ workflows })`.
- **LWIR rejects declared-but-unimplemented fields** (secrets broker, egress
  allowlist, escalated repair, step cache) instead of accepting and ignoring them,
  and rejects records keyed by a non-string schema (`z.record(z.number(), V)`).
- **Scaffolds pin versions.** `little-harness init`/`new` and `little init`/`add`
  write the CLI's own version and AI SDK 7-compatible ranges instead of `latest`.
- `ChatSdkConnectorOptions.transport` (the no-op `{ mode: "webhook" }`) is removed.
- Durable replay: a recorded model request that carried file parts re-records,
  because AI SDK 7 tags file-part data. Text-only requests replay unchanged.

### little-workflow

#### Added
- **`defineWorkflow`** and a typed `runWorkflow(definition, input)`; folder
  workflows (`little-workflow.json` + `workflows/<name>/workflow.ts`) loaded with
  `loadWorkflow`.
- **`asHarnessWorkflow`** adapts a workflow into a Little Harness tool. It accepts
  a `defineWorkflow` result directly; `definitionIdentity` is required.
- **CLI:** `little init`, `little add workflow|harness`, `little test`, and
  `little report` (JSON or `--table`). `little init --help` and `little add --help`
  print usage.
- **Real USD costs** per step, session, and run (`RunResult.usage.costUsd`,
  `runReport`/`formatRunReport`, `priceModelCall`) from a bundled model registry
  with pricing provenance and a staleness gate.
- **Dynamic workflows** — opt in with `dynamicWorkflows: dynamicWorkflows()` on
  `createHarness`. The agent gains `run_ad_hoc_plan` (author and run a one-shot
  `tool.call`/`ai.generate` step-DAG for a request no configured workflow fits) and
  `search_authored_plans` (recall a plan authored on a prior run). A one-shot plan
  is frozen under a canonical hash, runs once inline, is never added to the
  workflow library, and can never exceed the agent's own capability snapshot
  (tools, MCP, and agentic bash; skills are not a plan capability in v1).
  Capability drift is re-checked on resubmission (`capability_not_allowed`).
  Configure with `dynamicWorkflows({ exclude, limits })`; agentic bash inside a
  plan runs with network disabled in v1.
- The workflow tool's result carries an `outputSummary` (compact, at most 4096
  characters) so the calling model sees what a completed run produced.
- `z.record()` schemas: LWIR accepts `propertyNames` for string- and enum-keyed
  records, enforced at run time.
- LWIR accepts the annotation keywords `description`, `title`, and `examples`
  (so `.describe()` works on workflow and tool schemas).
- `lwir-input-cone@v1` (`inputConeHash`/`inputConeSnapshot`) and experimental
  eval-set bundles with a local content-addressed store.
- `ai.generate` steps self-repair malformed structured output.

#### Changed
- The AI SDK adapter targets AI SDK 7: `instructions` instead of `system`, and
  `usage` as the all-steps total.
- `little init` writes `pnpm.onlyBuiltDependencies: ["better-sqlite3"]` so pnpm 10
  builds the event store's native binding.
- Package exports use the `default` condition and expose `./package.json`.

#### Fixed
- Cached input and reasoning tokens are read from AI SDK 7's `inputTokenDetails` /
  `outputTokenDetails`; without this, cached input was priced at the full rate.
- Registry prices corrected and delisted models removed.
- `little init`/`add` reject unknown options instead of treating them as names.

### little-harness

#### Added
- **Connectors.** Chat SDK and web-rich connectors (`little-harness/connectors`,
  `/connectors/runtime`, `/connectors/discovery`) with descriptor-owned tools and
  mirror delivery, a session connector registry with first-class mirror lifecycle
  (`detachSessionConnector`, `setSessionConnectorDelivery`, `previousActive`),
  `waitUntil` for serverless hosts, test helpers (`createTestChat`, a loaded
  connector's `simulateInbound`), and
  `little-harness test <agent> --connector <id>` / `little-harness connectors <agent>`.
- **Chat attachments.** Files on an inbound Chat SDK message become UIMessage
  `file` parts that reach `chat.stageMessage` and the model (per-file cap 10 MiB
  via `attachments: { maxBytes }`; opt out with `attachments: false`).
- **Outcome capture.** `outcome.reported` trace events, `reportHarnessOutcome` /
  `createHarnessOutcomeReporter`, Chat SDK reactions as outcomes (on by default;
  `reactions: false` to opt out), and the `little-harness outcomes` CLI.
- **Agent folders and project CLI.** `little-harness init`, `new`, and `test`
  scaffold and chat with agent folders (`agents/<name>/agent.ts`, `tools/`,
  `instructions.md`) across 24 AI SDK providers; `little-harness/scaffold` exposes
  the scaffolders and the pinned dependency table.
- **Execution environments.** `localHost({ executionEnvironment })` takes
  `"auto"`, `"in-process"`, `"subprocess"`, or a factory.
  `subprocessSandbox()` runs just-bash in a child process with an empty
  environment, a SIGKILL watchdog (`watchdogGraceMs`), and an init deadline
  (`initTimeoutMs`). `HarnessExecutionEnvironmentFactory` +
  `HarnessWorkspaceSpec` build environments from a host-neutral mount table, and
  the custom-adapter surface (`createShellRuntime`, `resolveTraceOptions`,
  `createEnvironmentToolBridge`, `buildWorkspaceFs`, `bashOptionsForRuntime`,
  `execBashSafely`) is exported. The subprocess wire protocol is not.
- **Tiered execution** (`tieredExecutionEnvironment`, opt-in). One runtime that
  owns Tier-0 and a lazily provisioned `nextTier`, switching mid-turn when
  `classifyCommand` returns `"escalate"` or `detectEmulationGap` finds a gap
  (retried once). Escalation carries env and cwd only; a command that needs an
  unavailable tier is refused with exit code 126. New events
  `harness.runtime.tier.escalated`, `harness.runtime.tier.unavailable`,
  `harness.runtime.command.denied`, and `harness.runtime.dispose.failed`; disposal
  reports what a higher tier writes to tracked mounts
  (`snapshotTrackedMounts`/`emitTrackedMountFileChanges`).
- **Command classification.** `classifyCommand`, `detectEmulationGap`, and the
  versioned `tier0CapabilityMatrix()`.
- **Remote session log.** `startSessionLogServer()` (append-only HTTP log with
  optional bearer auth and a body cap), `remoteSessionLog()` (with per-request
  `timeoutMs`), `createInMemorySessionLog()`, and `createFileSessionLog()`. A fresh
  process can resume a recorded run from the remote log alone.
- **Orchestration ports.** `createInMemoryOrchestrationServices()` and
  `createDurableOrchestrationServices({ rootDir, store })` over a five-method
  `DurableJsonStore`; `localHost({ orchestration })` injects alternatives.
- **Task ledger and scheduling**: task control tools, park/resume, a workflow
  scheduler, and workflow inspection tools.
- `workflowBudgets.maxConcurrentWorkflowRuns` / `maxQueuedWorkflowRuns` bound
  inline workflow-tool fan-out (FIFO queue).
- `sessionLog` is the canonical name of the durable event log option
  (`durability` remains as an alias); `HarnessSessionLog` and
  `HarnessOrchestrationServices` are the canonical type names.
- `harnessToolContext` / `tryHarnessToolContext` typed tool-context helpers (from
  `little-harness/connectors`).
- `HarnessSession.dataDir` (optional; set by `localHost`) and re-exported
  `LanguageModel`, `ModelMessage`, and `UIMessage` types.

#### Changed
- The model loops use the AI SDK 7 callbacks (`onStepStart`, `onStepEnd`,
  `onToolExecutionStart`/`End`, `onEnd`), `instructions`, `isStepCount`, and the
  stateless `toUIMessageStream`. Tool-call trace payloads and durable tool replay
  keep their shape: the loops restore the step number and outcome that AI SDK 7
  tool-execution events no longer carry.
- Core types no longer import just-bash's `NetworkConfig`;
  `HarnessNetworkPolicy` is the structurally compatible neutral type.
- Chat SDK `history: { source: "thread" }` honors `fallback` and returns just the
  inbound message for an empty thread; transcript dedupe also matches
  `platformMessageId`.
- Package exports use the `default` condition (so `require()` works on Node's
  `require(esm)`) and expose `./package.json`.

#### Fixed
- A pre-dispose workspace snapshot that throws no longer skips tier disposal.
- `doctor` counts `harness.runtime.dispose.failed` as a failure.
- The subprocess sandbox survives worker-pipe errors, attributes proxied tool
  calls to the right shell call under concurrency, and retires a worker that
  reports a fatal error.
- Turn loops dispose the execution environment before closing the MCP gateway,
  and failure-path event emission no longer masks the original turn error.
- Durable replay bridges recordings made before the abstract-tool filter existed.
- The session-registry lock spans jiti module graphs.
- The Tier-0 hardening asymmetry between the two just-bash adapters is one
  documented rule, `defenseInDepthForAdapter`.
- Scaffolds no longer emit retired DeepSeek model ids.

## [0.1.0-alpha.2] - 2026-06-16

First release published as open source. Tagged in the repository; never published
to npm, where the next release after `0.1.0-alpha.1` is `0.2.0-alpha.0`.

### Changed
- **Relicensed to the [Apache License 2.0](./LICENSE)** (OSI-approved). The
  earlier `0.1.0-alpha.0`/`0.1.0-alpha.1` packages on npm carried a
  source-available license; from this release the project is open source.

### Added
- Open-source project files: `README.md`, `CONTRIBUTING.md`, `SECURITY.md`,
  and `CODE_OF_CONDUCT.md`.
- A CI workflow running build, lint, typecheck, and tests on pull requests.

## [0.1.0-alpha.1] - 2026-06-15

### Added
- Initial public alpha of `little-workflow` (workflow authoring, planner
  compilation, LWIR validation, durable Local World execution/replay, and the
  `little` CLI) and `little-harness` (local-first agent runtime primitives and
  the workflow harness adapter).
