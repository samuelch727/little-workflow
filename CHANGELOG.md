# Changelog

All notable changes to this project are documented here.

Little Workflow is in its **alpha phase**: breaking changes to the LWIR wire
format, public APIs, and persistence formats are expected between alpha releases.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the
project will adopt [Semantic Versioning](https://semver.org/) guarantees once it
reaches beta. Versions apply to the two published packages,
`@little-stack/harness` and `@little-stack/workflow`. Up to `0.2.0-alpha.1` they
were published as `little-harness` and `little-workflow`; `0.2.0-alpha.1` was a
`little-workflow`-only release. From `0.2.0-alpha.2`, the first `@little-stack`
release, Harness and Workflow share one version number.
`@little-stack/littledb` (formerly `@little-workflow/littledb`) is not published yet: it needs a LittleDB server that
is not public. Little Compute is unpublished; its first release candidate is
listed under Unreleased.

## [Unreleased]

### Little Compute (first release candidate)

- **Breaking:** the package publishes one command and five entry points:
  `little-compute`, and `@little-stack/compute` with `/client`, `/protocol`,
  `/harness` and `/self-host-tier1`. Operator, release and qualification
  executables still ship under `dist/` and run by path; they are no longer
  installed as separate commands. Internal entry points such as `/provider`,
  `/providers`, `/sandbox-runtime-broker` and `/storage-quota-authority` are no
  longer exported.
- **Breaking:** The `@little-stack/compute` root is a small, explicit API:
  `LittleComputeClient`, `LittleComputeError`, `LittleComputeApiError`,
  `LittleComputeTransportError`, `isLittleComputeError`,
  `COMPUTE_ERROR_REGISTRY`, `protocolVersion` and unversioned types such as
  `Operation`, `CreateOperationBody`, `HealthStatus` and `ReadinessStatus`.
  Versioned wire names and schemas are in `@little-stack/compute/protocol`, and
  the full client vocabulary is in `@little-stack/compute/client`.
- **Breaking:** Client errors share one hierarchy. Every failure is a
  `LittleComputeError` with a closed `code` and `retryable`.
- **Breaking:** `createOperation` takes the scope once. Pass `tenantId` and `projectId`
  on the call; the body no longer needs them, `schemaVersion` or
  `requestDigest`.
- **Breaking:** `health()`, `readiness()` and `destructiveReadiness()` are typed. A
  not-ready 503 is returned as `status: "not_ready"` or
  `"paused_safe_time_uncertain"` instead of thrown.
- **Breaking:** The thousands-environment completion methods left `LittleComputeClient`; they
  are qualification tooling.
- **Breaking:** Operator commands moved under `little-compute admin`. `init --advanced`
  is `admin init`, and `up`, `status` and `down --advanced` are `admin up`,
  `admin status` and `admin down`. `doctor`, `appliance`, `appliance-service`,
  `reinitialize`, `serve`, `init-roles`, `migrate`, `reconcile-*` and
  `storage-quota-host` are under `admin`, without version suffixes. The
  `dev foreground` alias is removed; use `dev up`.
- **Breaking:** `--model-protocol` takes kebab-case values: `openai-responses`,
  `openai-chat-completions`, `anthropic-messages` and `custom-http`.
- **Breaking:** `@little-stack/compute/harness` is a light entry point. It no longer loads
  PostgreSQL or `node:http`, and no longer exports the PostgreSQL session log,
  the Artifact spooling session log or the snapshot-backed file events.
- **Breaking:** One call gives a Harness host a Compute sandbox.
  `littleComputeSandbox({ socket })` or `littleComputeSandbox({ client })`
  replaces `createLittleComputeTier1ExecutionEnvironment`, and
  `LittleComputeSandboxError` replaces
  `LittleComputeTier1ExecutionEnvironmentError`. Options and the
  `Tier1SessionClient` port use `*Ms` names: `idleTimeoutMs`,
  `commandTimeoutMs`, `provisioningTimeoutMs`, exec `timeoutMs` and close
  `settlementMs`. `sandboxPrelude` is `prelude`.
- **Breaking:** `LittleComputeHarnessAgentGroupLauncherV1` is the
  `littleComputeAgentGroups(options)` builder, and its option types drop the
  `V1` suffix.
- **Breaking:** `@little-stack/compute/self-host-tier1` exports
  `createTier1SessionClient({ socket })`; the raw developer-socket opener is no
  longer public.
- **Added:** `little-compute --version` (`-v`). A bare `little-compute` prints usage and
  exits `0`.
- **Added:** New "Use from Little Harness" page in the Compute docs.
- **Changed:** The Compute npm README is a short quickstart; operator material moved to
  `docs/operations/`.
- **Changed:** `@little-stack/compute` documents its supported Node.js range,
  `^22.23.2 || ^24.18.1`.
- **Fixed:** the installed `little-compute` command did nothing and exited `0`
  when run through a symlinked bin, which is how npm and pnpm install it. It now
  compares real paths to decide that it is the main module.
- **Changed:** the package no longer ships the top-level `qualification/`
  fixtures, the `specs/` and `benchmarks/` folders, compiled fixture, test-helper
  or test-support modules, or two campaign reports that contained local machine
  paths. From `qualification/` it keeps only `workflow-templates/`, which the
  `little-compute-workflow-installer` command reads, and the four C sources that
  `scripts/build-owner-peer-helper-v1.mjs` compiles
  (`self-host-release-activation/owner-*.c`). The test-only
  `trustFixtureArtifactScope` and `preserveRequestedArtifactPolicyForTest` are no
  longer exported from `@little-stack/compute` or `little-compute/artifacts`. The
  `little-compute-attempt-completion-s3-physical-campaign` bin is removed, because
  it depends on test-support modules; run it from a source checkout. The package
  ships `qualification/topology-authority/self-hosting.md`, the deployment guide
  the README links for `little-compute-topology-authority`. README links that
  pointed outside the package now name the source-repository file instead.
- **Known limitations:**
  - An npm-installed `little-compute init` has no image build context, so it uses
    the published images `ghcr.io/samuelch727/little-compute:0.1.0-alpha.0` and
    `ghcr.io/samuelch727/little-compute-supervisor:0.1.0-alpha.0` unless you pass
    both image options. An anonymous check on 2026-10-09 was refused for both
    images (HTTP 401, then 403 for an anonymous token); it cannot tell whether
    they are missing or private. Until both can be pulled, an npm-installed
    `init` needs `--control-plane-image` and `--sandbox-image` pointing at
    compatible images, built from the same source, that you can pull.
  - `init`, `up`, `dev run` and `appliance --foreground-compatibility` have not
    been verified from the npm package. Only `little-compute --help` and `status`
    without a configuration were exercised from it.
  - The production `appliance --service-manifest` path is not supported from
    this package: it verifies the installed package against
    `installed-runtime-closure.v1.json`, which predates this payload.
  - The `admin` commands and the operator and qualification executables under
    `dist/` were not exercised from the npm package. Building and installing the
    owner native helpers from the package is also unverified.
  - The managed Cloudflare loop, worker scale-out, the credential-injecting egress
    proxy and hard subtree budgets are not built. Node must satisfy
    `^22.23.2 || ^24.18.1`.

## [0.2.0-alpha.3] - 2026-11-12

### Little Harness

- **Added:** Node-only `@little-stack/harness/compiler` exports `compileHarnessFolder`
  and `compileHarnessWorkspace`; `/compiled` runs their static agent registries on
  standalone workerd. Instructions and bounded binary skill assets bundle offline;
  host-factory agent exports create chat-local tools. Includes `demos/workerd-folders`.
- **Added:** `/remote-tools` validating contracts, portable HTTP/service-binding
  clients and authenticated Fetch handlers; `listenRemoteTools` in `/server`.
  Principal-scoped dedupe metadata and call-local `invocationId` support application-owned
  idempotency stores; retained unfinished replays preserve their occurrence.
- **Added:** admitted per-turn execution snapshots and owner-installed registries,
  isolated effective tools/skills/hooks, pinned provenance and a managed-client seam.
  LittleDB itself remains private.
- **Changed:** ordinary remote-tool wire serialization honors Date/toJSON and omits
  undefined object fields without weakening strict identity hashing. All remote-tool
  endpoints refuse redirects portably without forwarding credentials or retrying.
- **Changed:** `demos/workerd-chats` streams AI SDK replies through durable finalization,
  exposes parked input requests in stream metadata, and includes a loopback SQLite
  remote-orders example.
- **Fixed:** synthetic `/dev/null` supports shell redirection without persisting device
  files. Structural guards protect synthetic directories; command `executionId` correlates
  start, completion, denial and escalation without losing private attempt identity.
- **Fixed:** default Node folder factories share host session queues; explicit hosts stay
  isolated. Persistence failures remain visible; compiled skill validation rejects malformed
  or mixed inputs. just-bash minimum is 3.0.3 for upstream descriptor routing.

### Little Workflow and shared documentation

- **Breaking:** the bundled model catalog no longer includes four unverified models;
  see the migration note below.
- **Changed:** model-price records were re-verified after their 90-day check window;
  DeepSeek and Mistral rates were corrected and current verification dates recorded.
- **Changed:** unified Little Stack docs use little-stack.dev canonical routes, retaining
  historical URLs and marking which Compute and LittleDB features are unpublished.
- **Fixed:** setup verification preserves server diagnostics on architecture qualification
  failures; docs clarify scaffold defaults and existing Next setup flags.

**Migration:** the bundled model catalog drops `openai/o4-mini`, `perplexity/sonar-pro`,
`groq/llama-3.3-70b-versatile` and `amazon/nova-pro`, whose prices could not be
re-verified. Those models remain usable through AI SDK, but lose bundled description and price
metadata. Choose a priced catalog model when relying on SDK cost estimates, or
account for unpriced calls. Runtime API additions otherwise preserve alpha.2 usage.
Little Compute remains under Unreleased above.

## [0.2.0-alpha.2] - 2026-11-03

The first release under the `@little-stack` npm scope: `@little-stack/harness`
and `@little-stack/workflow`, both `0.2.0-alpha.2`.

- Little Harness: `virtualHost({ dataFs })` backs `localDir()` and memory with a
  just-bash filesystem, defaulting to hidden `/.little-harness/data/` in the
  session's filesystem.
- Little Harness: `dynamicWorkflows()` runs one-shot plans and defined workflows
  on `virtualHost()` through `virtualWorld`, with run files and kept plans in
  `dataFs`. App workflows and `once()` records use the virtual session's data
  directory too, with persistence inherited from the filesystem. The workerd
  chat example includes `plan:`, `define:` and `use:` flows
  and local workflow traces; restart reuse covers completed data only.
- Little Workflow: `virtualWorld({ fs, dataDir })` keeps events, artifacts and run
  files in a supplied filesystem, with shared event rules and process-local locks
  scoped by filesystem object and data root. Restricted runtimes use interpreted
  draft-07 validation; Node keeps Ajv. Persistence is inherited from the filesystem.

Workflow depends on Harness with `workspace:^`, which publishes as
`^0.2.0-alpha.2` instead of an exact pin. `pnpm run publish:alpha` checks that
neither version is on npm yet before it publishes. Little Compute
(`@little-stack/compute` `0.1.0-alpha.0`) is not part of this release; its notes
are under Unreleased.

### Breaking changes

- **Packages move to the `@little-stack` npm scope.** `little-harness` becomes
  `@little-stack/harness`, `little-workflow` becomes `@little-stack/workflow`,
  Little Compute ships as `@little-stack/compute`, and the private LittleDB
  client becomes `@little-stack/littledb`. Replace dependency names and import
  specifiers, including subpaths (`little-harness/connectors` becomes
  `@little-stack/harness/connectors`). Command names (`little-harness`, `little`,
  `little-compute`) are unchanged, and the versions already published under the
  old names stay installable. `little setup`, `little init` and
  `little-harness init` generate projects with the scoped names.

#### Little Harness

- **One name per sandbox concept.** The sandbox an agent's `bash` tool runs in
  is called a sandbox everywhere:
  - `localHost({ executionEnvironment })` is `localHost({ sandbox })`.
  - `HarnessExecutionEnvironmentMode` is `HarnessSandboxMode`.
  - `HarnessRuntime` and `HarnessExecutionEnvironment` are `HarnessSandbox`.
  - `HarnessExecutionEnvironmentFactory` is `HarnessSandboxFactory`.
  - `CreateExecutionEnvironmentOptions` and `CreateJustBashRuntimeOptions` are
    `CreateSandboxOptions`.
  - `tieredExecutionEnvironment()` is `tieredSandbox()`, with
    `TieredSandboxOptions`.
  - `createJustBashRuntime`, passed uncalled, is `justBashSandbox()`, which you
    call and which returns the factory. The deprecated `justBashRuntime()` is
    removed.
- **Session logs:** `createFileSessionLog()` is `fileSessionLog()` and
  `createInMemorySessionLog()` is `inMemorySessionLog()`. The `durability:`
  option on `createHarness`, `generateHarness` and `streamHarness` is removed;
  use `sessionLog:`.
- **Aliases are gone, with no deprecation period**, because no `@little-stack`
  version has been published:
  - `HarnessDurableServices`: use `HarnessOrchestrationServices`.
  - `HarnessDurabilitySink`: use `HarnessSessionLog`.
  - `GenerateHarnessResult` and `StreamHarnessFinished`: use `HarnessTurnResult`
    and `StreamHarnessTurnFinished`.
  - `HarnessWorkflowInheritance` and `HarnessToolProxy`.
- **Each symbol has one import path.**
  - The `./execution` and `./workspace` subpaths are removed; the same names are
    on the root, except the folder discovery helpers (see below).
  - The durable event contract (`emitHarnessOccurrence`,
    `canonicalHarnessEventRequestDigest`, `HarnessSessionLog`, the event
    validators) is only on `@little-stack/harness/events`.
  - Session-log transports (`fileSessionLog`, `inMemorySessionLog`,
    `remoteSessionLog`, `startSessionLogServer`) are only on
    `@little-stack/harness/remote-session`.
  - Agent Group ports, protocol types, errors and the 22 ledger projection types
    moved to the new experimental `@little-stack/harness/agents`. The root keeps
    only `HarnessAgentGroupsOptions`.
  - `createCheckpointTools` and `HARNESS_CHECKPOINT_TOOL_NAMES` are no longer
    exported; configure `createHarness({ checkpoints })`.
- **The root entry keeps 28 of its values** (33 with the new `once`, `resumeParked`,
  `answerInputRequest`, `listInputRequests` and `defineSchedule`), the ones an app
  needs to build and run an agent; `src/index.test.ts` pins the list. The other 126
  values moved, with no behavior change:
  - Sandbox building blocks (`createShellRuntime`, the tool bridges,
    `localSessionWorkspace`, `resolveSandbox`, `selectSandboxMode`,
    tracked-mount helpers, `classifyCommand`, `detectEmulationGap`,
    `tier0CapabilityMatrix` and the `TIER0_*` constants) moved to the new
    `@little-stack/harness/sandbox`.
  - Host building blocks (`createInMemoryOrchestrationServices`,
    `createDurableOrchestrationServices`, the durable stores,
    `HarnessOrchestrationServices`, `PreparedTurn`, `LocalSessionStore`,
    `LocalSessionQueue`, local paths, `sessionKeyToPathKey` and the local trace
    readers) moved to the new `@little-stack/harness/host`.
  - The event names (`HARNESS_EVENT_TYPES`, `isHarnessEventType` and the
    side-channel pair) moved to `@little-stack/harness/events`.
  - What Little Workflow and Little Compute build on (hashing and id helpers,
    skill and MCP resolution, workflow-tool plumbing, `discoverTools`,
    `discoverSkills`, `discoverWorkflows`) moved to the new
    `@little-stack/harness/internals`, which has no stability promise.
- **Agent Group launchers take one `paged` object.** The three optional
  `watchAgentGroupPage`, `joinAgentGroupPage` and `cancelAgentGroupPage` methods
  are one optional `paged: { watch, join, cancel }`, so a launcher has all three
  or none.
- **Parked turns are typed.** `generateHarness()` now returns, and
  `streamHarness().finished` now resolves to, the `status`-discriminated union the
  runtime already produced (`HarnessTurnResult` / `StreamHarnessTurnFinished`).
  A parked turn was previously cast to the completed type, so `output` could be
  `undefined` where the types promised a value. Check
  `status === "completed"` before reading `text`, `output`, `persistence` or
  `commitManual`; a parked result carries `continuationId` and `pending`.
- **`checkpoint` is a reserved tool name**, alongside `bash` and the five Agent
  Group tools, for configured and folder-discovered tools, even when
  `checkpoints` is not configured. Rename an existing tool called `checkpoint`.
- **Custom `sessionLog` implementations:** `DurableHarnessEventInput` requires
  `appendIdempotencyKey`, persisted events carry `canonicalRequestDigest`, and an
  event may carry `payloadArtifactId` instead of an inline `payload`. Little
  Workflow's recorder still requires inline payloads.

#### Little Workflow

- **One way to run a workflow.** `runWorkflow(workflow, input, options?)` and
  `workflow.run(input, options?)` take the same `RunWorkflowOptions`; `world`
  defaults to `localWorld()` and `tools` to the workflow's inline tools. The
  options-object form `runWorkflow({ world, workflows, input })` is removed.
  Deprecated multi-workflow orchestration moved to
  `runOrchestration({ workflows, orchestrator, input })`.
- **`defineWorkflow` takes the full workflow config**: `model` or `models`,
  `planner` as a model or a `PlannerConfig`, tools as a record, a
  `ToolRegistry` or names, `toolSelection`, `workflowVersionReuseStrategy`,
  `worker`, `memory` and `bash`. `createLittleWorkflow` moved to
  `@little-stack/workflow/internals`.
- **The root is an explicit, tested export list.** LWIR validation and
  registration moved to `@little-stack/workflow/lwir`, eval sets to
  `@little-stack/workflow/eval`, and runtime plumbing (world storage functions,
  harness plumbing, pricing, run reports, `runWorkflowCycle`,
  `executeWorkflowVersion`) to `@little-stack/workflow/internals`. Test helpers
  are no longer exported.
- **One scaffolder vocabulary.** `--here` always means the current directory;
  existing-Next mode is `--template existing-next`. `--workflow` is a boolean
  and `--workflow-name <name>` names the workflow. Flags a command ignores are
  rejected, and `little init` rejects `--yes`, `--no-install` and `--install`.
  `openai` is the default provider in `little setup`, `little init`,
  `little-harness init` and `little-harness new`.
- `rollbackSetup` is no longer exported from `@little-stack/workflow/scaffold`;
  use `recoverSetup()`.

### Added

- `@little-stack/harness`: an outcome report can carry a `revision`, the
  caller's order for reports under one `reportKey` (`reportHarnessOutcome`,
  `POST /sessions/<session>/outcomes`). A late retry of an older report no
  longer overrides a newer one: the trace reader ranks reports under a key by
  revision. At one revision the first report stands and a retraction wins. The
  route refuses a revision that isn't a whole number from 0, or comes without a
  `reportKey`. A sink can answer `{ ok: true, stale: true }` when its store
  already holds something newer; `HarnessOutcomeResult.stale` and the route's
  `stale` count those. In the private LittleDB client, `db.outcomeSink()` sends
  the revision on, and `db.feedback({ id, revision })` and
  `db.retractFeedback(id, { revision })` let LittleDB keep the highest revision
  it has applied per id. A retraction's revision is kept too. An older change is
  answered `stale: true` with the revision held, and changes nothing; a
  different report at the revision applied is a 409.
- `@little-stack/harness`: `turnLimits.refusedBeforeEffect(error, { provider, modelId })`,
  opt-in with `accounting: "logical-turn"`. The host says which rejected provider calls
  had no effect, such as Anthropic's 429 and 529. Harness asks only when the provider
  call itself rejects, never for an abort or an error inside a stream that began. A
  `true` settles the reservation as `refused`: no usage, no cost, still one step. A
  priced turn can then retry after an overload instead of stopping with
  `BudgetStateUnavailable`. Unset, every unknown attempt stays held, as before.
- `@little-stack/harness`: a turn limit reached on a model call AI SDK retried now fails the
  turn with the limit's own `HarnessTurnLimitError` and `reason`, instead of AI SDK's
  `RetryError` around it, so the agent server answers a failed turn with its reason, not a 500.
- `@little-stack/harness`: `virtualHost({ fs })`, a host that keeps each session's
  workspace and status in a just-bash filesystem instead of on disk, and the
  package now loads on workerd with a normal bundle. One self-hosted workerd
  process can serve many chats, each a Durable Object with its own files and
  `bash`; routing, saving each chat's files and sharding stay with the app. On
  workerd just-bash loads its browser build, so `python3`, `node` (`js-exec`),
  `sqlite3`, `tar`, `yq` and `xan` are unavailable: the harness turns Python and
  JavaScript off there and says so in the agent's system prompt, and Tier-0
  classification sends every command to `tieredSandbox()`'s next tier.
  `justBashSandbox()` runs over `workspace.filesystem` when a host sets it, and
  `subprocessSandbox()` refuses such a workspace. `createFsFileWriter` is on
  `@little-stack/harness/host`. `demos/workerd-chats` runs it end to end.
- `@little-stack/harness`: `createHarness({ turnOptions })`, a hook that decides
  each turn's model, system prompt and other per-run options from its session
  (`sessionId`, `session`, `extraBody`, `trigger`). It is awaited once per turn on
  every path that runs one: `generateHarness`, `streamHarness`, connectors,
  schedules and `little-harness start`. A call's own options win.
- `@little-stack/workflow`: `versionedHarnessWorkflow(source, build)` builds a
  workflow a harness calls per run, from the version its session runs, and
  `agentWorkflow(definition, { tools, models, planner })` builds an agent-made
  workflow so it runs outside its harness.
- `@little-stack/littledb` (unpublished): `db.managedHarness()` hands a harness's
  prompt and model to LittleDB through one `turnOptions` hook, with a declared
  content `schema`, model slots and per-turn tracing; `db.managedWorkflow()` does
  the same for a workflow's steps. An edit to the bootstrap after version 1 now
  becomes a "Changed in code" proposal instead of being ignored. Sessions leave a
  rolled-back version at their next check; resolve has a circuit breaker and an
  optional `lastKnownFile`; `littleDBFromEnv()` runs offline without
  `LITTLEDB_URL`; `@little-stack/littledb/testing` runs LittleDB in memory. Agent-made
  workflows honor LittleDB's trials, are redefined on the version the session was
  offered, and get `registry.world()` and `db.agentWorkflowEvalWorker()`.
- `little-harness`: Agent Groups (`createHarness({ agents })`) and environment
  milestones (`createHarness({ checkpoints })`), plus the `@little-stack/harness/events`
  and `@little-stack/harness/remote-session` subpaths, which resolve for both `import`
  and `require()`.
- `@little-stack/workflow/scaffold` exports `recoverSetup()`, which reports how setup
  recovery ended.
- `@little-stack/harness/connectors`: `emailConnector()` gives an agent its own
  email address. Add `connectors/email/connector.ts` with a Resend adapter and a
  sender allowlist, point Resend's `email.received` webhook at the connector's
  route, and each email thread becomes one session whose reply goes back in the
  same thread. It refuses auto-replies, unlisted senders and mail that fails DMARC
  before the agent sees them, removes quoted text, and marks replies
  `Auto-Submitted`. DMARC is read only from the `Authentication-Results` header of
  the server named by `senders.authServId`, which is required while
  `requireDmarc` is on. Unverified: no real email has been received through Resend
  Inbound yet, and whether Resend adds that header (and its authserv-id) is
  unconfirmed.
- `loadHarness(dir, { host })` runs a folder's agent on another host, such as a
  `localHost()` with your own data directory or sandbox.
- `harnessToolContext()` and `tryHarnessToolContext()` are exported from the
  Harness root, so a tool reads its typed context without a connector import.
- `@little-stack/harness/agents` exports `HARNESS_AGENT_GROUPS_PROTOCOL_VERSION`
  and `HARNESS_AGENT_GROUP_PAGES_PROTOCOL_VERSION`.
- `defineWorkflow({ plan })` defines a fixed-plan workflow that needs no model.
  `plan` is `{ steps }` or a full LWIR document.
- `isRunFailedError(error)` narrows a caught error to `RunFailedError`.
- The `little setup --workflow` starter is a fixed-plan `starter_echo` workflow
  with no model, loaded with `loadWorkflow`.
- `pnpm run check:unpublished-versions` fails when a package version about to be
  published is already on npm.
- The bundled model registry prices `anthropic/claude-sonnet-5-5` ($2 input, $10
  output and $0.20 cached input per million tokens), so its runs report a cost
  instead of counting as unpriced.
- `run_ad_hoc_plan` spells out the plan's shape in its input schema and names the
  template syntax and the model slots in its description. A step with a field its
  type does not take, an `ai.generate` step with no prompt, and `$input.x`-style
  references are rejected at submission with a message naming the right field, and
  missing `needs` are added as for planner drafts.
- `search_authored_plans` returns up to five plans whose last run completed, newest
  first, one per distinct plan, instead of every recorded run.
- `dynamicWorkflows({ models })` adds model slots, such as a cheaper model, for a
  plan's `ai.generate` steps besides `default`, the agent's own model.
- `dynamicWorkflows()` also gives the agent `define_workflow`, for work it expects
  to repeat. The agent sends an id, a description, input and output JSON Schemas, the
  tools to use, an optional policy and optionally the model slots its steps may use;
  the result is a `defineWorkflow` workflow that the agent's model plans once. From the
  next turn on, in every session on the same host `dataDir`, it is a tool named after
  its id, and `runWith` runs it in the defining call. Definitions are stored under
  `/persistent/dynamic-plans/workflows/`, and runs share one store,
  `<dataDir>/agent-workflows`, so the plan is kept across sessions. An id whose tool
  name is reserved (`bash`) or belongs to another of its workflows is refused, and a
  stored workflow that no longer checks out is left out of a turn with a warning
  instead of failing it. `dynamicWorkflows({ define: false })` leaves the tool out.
- `dynamicWorkflows({ registry })` decides what happens to the workflows an agent
  defines. `registry.defined(record, ctx)` runs after `define_workflow` stores a
  revision; the note it returns replaces the default note in the tool's answer,
  and its metadata reaches the run `runWith` starts. `registry.resolve(records, ctx)` runs at the
  start of each turn and returns which definitions, at which revision, the turn
  offers. Without a registry every stored definition is offered, as before; when
  `resolve` throws, the turn offers none and carries a warning.
- `dynamicWorkflows({ world })` takes a World, or a function that returns one per
  run, for runs of agent-defined workflows and one-shot plans, so a host can wrap
  them (to trace them, for example). The function is told the run's kind, ids,
  handle, `dataDir`, session and turn, and for a defined workflow its revision and
  the registry's metadata. The default is still a Local World in the harness's
  store. `@little-stack/workflow` exports the `DynamicWorkflowWorld` types.
- Little Harness turns on Anthropic prompt caching for the agent's model calls: a
  cache point on the system prompt, so the next session reads the tools and
  instructions from the cache, and Anthropic's automatic cache point at the end of
  the conversation, so each step reads what the step before it sent. That uses 2 of
  Anthropic's 4 cache points per request. On Amazon Bedrock (provider id starting
  with `bedrock`) only the system prompt's cache point is sent, since Bedrock
  rejects the automatic one for older Claude models; providers that do not read
  `providerOptions.anthropic` ignore both. `createHarness({ promptCaching: false })`
  turns it off, and a caller's own `providerOptions.anthropic.cacheControl` (a 1-hour
  TTL, say) is kept.
- `generateHarness` and `streamHarness` take `prompt`, one user message as plain
  text, so a script no longer builds UI message parts for one sentence. A message
  without `parts` (the AI SDK's `{ role, content }` shape) is now refused with an
  error that names it; it used to fail inside the AI SDK with "Cannot read
  properties of undefined".
- `once(tool, { key? })` marks a tool that writes. When a workflow step (in an ad-hoc
  plan, a workflow the agent defined, or a configured workflow) calls it again in the
  same session with the same input (or the same `key`), it gets the recorded result
  back and the tool does not run, so a resubmitted plan no longer writes twice. A
  result that cannot be saved (not JSON, or a failed disk write) makes a repeat fail
  with `HarnessPersistenceError` instead of running again. Calls the agent makes
  itself are not recorded. Every tool call those steps make now also gets the
  harness context of the agent's call (`harnessToolContext(options)` used to throw
  there) and an `idempotencyKey`.
- `humanInput` lets the agent ask a person without waiting: the `ask_person` tool
  returns at once with a task id, and `await_tasks` returns the answer, or parks
  the turn until it comes. Your `deliver` hook sends each question;
  `answerInputRequest()` records the reply (checked against the question's options
  or `answerSchema`), and `listInputRequests()` lists open questions. Tools can ask
  too, through `harnessToolContext(options).ask()`.
- `resumeParked()` continues turns that parked in `await_tasks` once their wait is
  over (tasks finished, an answer came, or `maxWaitMs` passed). A parked turn now
  saves its system prompt and conversation, and the continued turn starts from
  them with `await_tasks` returning what it waited for. Before this, nothing
  continued a parked turn.
- `PreparedTurn.dataDir`: a host may name a directory every session shares. `localHost`
  sets it to its `dataDir`.
- `little-harness start <name>` serves an agent folder: every connector in
  `connectors/` at `POST /connectors/<id>`, an HTTP API for messages, Input Type
  jobs and answers to the agent's questions (behind `--token`, or loopback only
  without one), the folder's schedules, and `resumeParked()` every 15 seconds.
  `little-harness dev <name>` runs it in a child process that restarts when a file
  changes, with a chat in the terminal (`:questions`, `:answer`).
- `schedules/*.ts` in an agent folder default-export `defineSchedule({ cron,
  timezone?, prompt | type + input, session?, catchUp? })`. The last run is
  recorded before it starts, so a restart never repeats a run, and runs missed
  while the server was down become one run. `little-harness schedules <name>`
  lists them; `schedules run <name> <id>` runs one now.
- `HarnessHost.dataDir`: the host's data directory, where `start` keeps schedule
  state. `localHost` sets it.
- An `ai.generate` step whose output failed the workflow's output schema now gets
  its self-repair run. With the default worker harness the repair failed with
  "Append key ... was already used with another request", because the repair's step
  events reused the original attempt's keys. They are now keyed by repair attempt.
- The registry also prices `anthropic/claude-haiku-5-5` ($0.10 input, $0.50 output
  and $0.01 cached input per million tokens, its rate for prompts up to 100k tokens).
- `result.plan` on every completed `runWorkflow` result says how the run got its
  plan: `kind` is `"drafted"`, `"kept"`, `"adapted"` or `"fixed"`, with
  `plannerCalled`, `workflowVersionId`, and for a kept or adapted plan
  `previousWorkflowVersionId` and the planner's `rationale`. `little run` prints
  it. `runOrchestration` results have no `plan`.
- `readWorkflowVersion(world, id)` reads the plan (LWIR) a run executed, so code
  no longer reads `<dataDir>/workflow-versions/<id>.json`.
- `workflowVersionReuseStrategy: "planner_reviews_each_run"` shows the planner the
  newest plan on every run, for workflows whose input values change what the
  plan should be.
- `defineWorkflow({ policy })`: rules the runtime adds, word for word, to the
  system prompt of every `ai.generate` step, whoever wrote the plan. The planner
  sees the policy and is told not to copy it into steps; it is part of the
  planning snapshot and the definition hash, so a change sends a saved plan back
  for review. A workflow without a policy keeps its hashes.
- `gradeRun(world, runId, { verdict, reason?, gradedBy? })` and
  `listRunGrades(world, { runId?, workflowVersionId? })`. Grades are stored under
  `<dataDir>/run-grades/`, outside the event log. A `"fail"` grade is a warning
  on the plan that run executed, with its reason in the planner's brief, so the
  next run goes to the planner instead of keeping the plan without a call; once
  the planner has weighed it, the plan is kept without a call again.
- A planner's draft that reads an earlier step's output without listing it in
  `needs` gets the entry added before validation, instead of a repair call. Only
  references within the same step list are inferred; a missing step, a
  reference out of a `parallel` body, or an entry that would close a cycle is
  still a validation error. Fixed plans are validated as written.
- The private LittleDB client (`@little-stack/littledb`, unpublished) sends what
  end users say about a turn to LittleDB as user feedback (scores with source
  `user`), which LittleDB's reviews, trials and rollback weigh next to its
  judges. `db.feedback({ traceId | sessionId, thumbs, rating, comment, survey,
  answers, userId, id })` sends it from your backend and `db.retractFeedback(id)`
  withdraws it; `feedbackId(userId, messageId)` builds a stable id.
  `db.feedbackHandler({ authorize, resolveTrace })` is a Fetch handler to mount
  on your own backend, so the browser can send feedback without holding the API
  key: it stores the user `authorize` returns, scopes ids to that user and
  refuses bodies over 16 KiB. `db.outcomeSink({ tracer })` sends Harness
  outcomes and chat reactions as feedback again, which the rebuilt client had
  stopped doing: `success` and `failure` are a thumbs up and down, `partial` is a
  rating of 3 out of 5, and a retraction withdraws the report.
  `tracer.traceIdForTurn(sessionId, turnId)` gives the trace of a turn. The
  vite-builder demo collects a thumb on each reply and a short session survey.
- The private LittleDB client (`@little-stack/littledb`, unpublished) can run a
  workflow's experiments: `db.workflowEvalWorker({ workflow, world, run, grade })`
  hands `run` each experiment run's version content, the dataset item's input
  and your World wrapped with the tracing World, so a code-defined workflow
  whose step prompts and models come from its LittleDB version is built from
  the candidate's content, traced into the run's trace and graded. With
  LittleDB's matching server changes, its reviewer reads a workflow's steps and
  proposes a change to one step's prompt or model, classified as a prompt or
  model change rather than a structural one. The tracing World now records an
  `ai.generate` step's prompt, with its expressions filled in, on the step's
  model call (`input.prompt`, and the model slot as `attributes.modelSlot`):
  the runtime's model-call event holds only the step input, so the prompt the
  step ran with never reached LittleDB.
- A session reads start to finish in LittleDB. `generateHarness` and
  `streamHarness` take `trigger` (`HarnessTrigger`: `{ kind, source?, from?,
  label? }`) for how the turn started; it goes on `harness.session.started` as
  string metadata (`triggerKind`, `triggerSource`, `triggerFrom`,
  `triggerLabel`), never in the session log or the prompt. The schedules
  runner (`schedule`, the schedule id and description), the Chat SDK, email
  and web connectors (`message`, the platform and the sender; email adds the
  subject), the agent server (`api`) and the REPL (`cli`) set one, and a
  trigger the caller passes wins. `runWorkflow` takes `trigger` (`RunTrigger`,
  with `sessionId`, `turnId` and `toolCallId` for a run a tool call started),
  recorded on the top-level `RunStarted` only; `asHarnessWorkflow` tools and
  dynamic workflows set it. The one-shot plan run context now carries the
  model's tool call id instead of the run id, and `DynamicWorkflowWorldContext`
  gains `toolCallId`. The private LittleDB client (`@little-stack/littledb`,
  unpublished) puts the trigger on the turn's trace and sends each run's trace
  with its trigger, the turn's session, and `parentTraceId` / `parentSpanId`
  pointing at the turn's trace and the tool call's span (a sub-run points at
  its parent run); the tracing World's `sessionId` is now only an override.
  `Trigger` is exported.
- Docs: [Guardrails and autonomy](apps/little-workflow-doc/content/docs/littledb/guardrails.mdx)
  covers LittleDB's new server features: how much of the improvement loop goes
  live without you (`review`, `guarded`, `auto`), guardrails in your own words
  with exact checks, the LittleDB agent you steer in plain words, and a money
  threshold enforced in two layers: at run time in the Harness tool with
  `harnessToolContext(options).ask`, which no version of the prompt can change,
  and as a LittleDB guardrail the loop must keep. No client changes are needed.

### Changed

- The private LittleDB client (`@little-stack/littledb`, unpublished) is rebuilt
  for the new LittleDB server: `createLittleDB({ url, apiKey })` replaces
  `littleDB()` and `littledb()`, and one client with one URL and one project API
  key does everything. `db.resolve()` picks the version (`{ system, model }`, for
  example) a session or run uses, with your code's config as the bootstrap;
  `db.harnessTracer()` and `db.tracingWorld()` send Harness turns and Workflow
  runs as traces in the background; `db.score()` records scores;
  `db.agentWorkflowRegistry()` makes each `define_workflow` definition a draft
  version with a proposal a person approves; and `db.evalWorker()` runs
  LittleDB's experiments inside your app. The package no longer depends on the
  Harness or Workflow packages at runtime. LittleDB also accepts OTLP/HTTP
  traces directly.
- `workflowVersionReuseStrategy: "planner_reviewed"` keeps the newest successful
  WorkflowVersion without calling the planner when the planner would read nothing
  new: the same definition, tools, model slots, output contract and input shape,
  with no reuse warning or block and no outer-loop note. Only input values
  differ. The run records a `reuse_unchanged` decision whose rationale starts
  "Kept without a planner call", and no `PlannerStarted` event. Once the planner
  has reviewed a change and kept the plan, later runs with nothing new keep it
  the same way. Anything else
  still goes to the planner, which keeps, adapts or replaces the candidate. A
  planned loan pre-approval workflow used to spend about 27k input tokens per run
  on a review that always kept the plan.
- The planner prompt tells the model to copy any rules, policy or thresholds in
  the workflow description word for word into the step that applies them, and to
  add, drop, tighten or loosen none. A planner on Claude used to paraphrase a
  lending policy into its own cut-offs and decline cases the policy never
  covered.

### Fixed

- `versionedHarnessWorkflow` runs a resumed run (the same reserved run id, for
  example after a crash) on the version it started on. Before, it asked for the
  session's version again, so a run that resumed after a version with a different
  definition went live failed with a manifest-changed error and could never finish.
  The version is now pinned in the World's `dataDir` (`run-pins/<runId>.json`)
  before the run's first event, and `prepare` gets it back as `pinned`; when two
  processes start the same run, both run and trace the first pin written. A run
  with a log but no pin runs as before, so the runtime still refuses it if the
  definition changed; a pin whose hash doesn't match its content or version fails
  the run instead of running the live version. `db.managedWorkflow().prepare({ pinned })`
  traces the run as the version it started on without resolving again, and refuses
  version metadata it didn't return.
- A durable Harness turn no longer runs a model-called tool twice when its
  `execute` returns nothing. The success record now says the result was
  `undefined`, so replay returns it instead of treating the call as still in
  flight. Success records written before this fix still replay as in flight.
- A durable Harness turn fails instead of reporting `completed` when the session
  log refuses a required record. A model-called tool runs only after its start
  record is acknowledged, a refused tool or model record stops later steps, and
  `streamHarness` now handles refused model-response records as
  `generateHarness` does.
- `streamHarness` gives model-called tools their model position, so the
  `checkpoint` tool works under streaming as it does under `generateHarness`.
- An outer loop (`maxOuterCycles > 1`) is driven by one caller at a time for a
  data directory and `outerLoopId`. A second caller waits, then returns the
  decision the first committed. The manifest always matches the committed
  supervise decision.
- Resuming an outer loop with different input fails with
  `outer_loop_input_mismatch` instead of returning the earlier result or running
  later cycles on the new input. Manifests record an `inputHash`; older ones
  take it from their first cycle's run.
- `@little-stack/littledb` (unpublished): eval workers name their claim
  (`workerId` and `attempt`) on every heartbeat and completion, and drop a run
  whose completion LittleDB refused because another worker holds it.
- `@little-stack/littledb` (unpublished): when several workflow runs or Harness
  turns share one `traceId`, their step, model-call, tool-call and memory spans
  keep separate ids instead of overwriting each other.
- `@little-stack/littledb` (unpublished): an outage no longer sends new sessions to
  a trial candidate (only live answers are kept as the fallback); the project
  holdout's `mode: "holdout"` is read and traced as `holdout` instead of failing
  the resolve; and an experiment run's pinned agent versions (`pins`) are used
  inside the run, whose traces are tagged `experiment`.

- The private LittleDB client no longer hangs after a scheduled send finds its
  queue already empty. That send stayed marked as running, so nothing queued
  after it was sent and the next `db.flush()` spun forever without yielding.
  An eval worker, which flushes before completing each run, hit it within a
  few runs at a concurrency of four.
- `little setup --rollback` reports what it did: nothing to recover, rolled back,
  finished cleanup of a committed setup, or manual recovery required. It no longer
  reports success when it found no setup journal. The interrupted-setup message
  names the real project directory, shell-quoted. `--rollback` now needs a
  project directory or `--here`.
- TypeScript projects that set `skipLibCheck: false` can type-check the public
  declarations without adding type packages themselves. `little-harness` now
  depends on `@types/json-schema`, which the AI SDK types it re-exports need, and
  `little-compute` depends on `@types/pg` and `@types/ws`.
- Every Little Harness error extends `LittleHarnessError` and carries a stable
  `code`, including the Agent Group, session-event, remote-session and
  file-session-log errors.
- Durable `loadWorkflow` treats installed packages as external when it bundles
  a workflow's import graph.
- `ai.generate` steps: `{{ }}` expressions in `with.prompt` and `with.system`
  are filled in before the model call, with the same roots as `input` (`input`,
  `steps.<id>.output`, `item`, `workflow`, `step`). The model used to receive the
  literal braces. A value that resolves to an object is sent as JSON.
- `ai.generate` steps: `with.system` reaches the model, after the worker's own
  system prompt. It used to be dropped.
- `ai.generate` steps are no longer offered the workflow's tools or `bash`.
  Free-text steps used to be offered all of them, but the step is a single model
  call that runs no tool, so a tool call ended the step with empty output. Call
  tools with `tool.call` steps. This includes `run_ad_hoc_plan` steps marked
  `bash: true`, which never got a working shell. A custom `aiLoop` adapter now
  receives an empty `tools` record for `ai.generate` steps; planner tasks
  keep `bash` and orchestrator tasks keep their tools.
- A `{{ steps.X.lastOutput }}` or `{{ steps.X.allVisits }}` read of a loop step
  that has not run yet (a back-edge read on the first pass) gives no value and
  `[]` instead of failing the run. An embedded expression with no value now
  renders as empty text instead of `undefined`. A run started before this
  change and resumed after it calls the model again for its next `ai.generate`
  step, because the recorded request no longer matches.
- A failed model call in the planner or an `ai.generate` step now fails the run
  with the provider's own error, such as a 401, 429 or 529. The AI SDK adapter
  used to swallow it: the planner got an empty draft, retried it as a bad draft,
  hit the same error, and the run ended with
  `EventAppendIdempotencyConflictError`. The AI SDK no longer prints the error to
  the console either.
- A planner, fixer or orchestrator model turn that ends in tool calls runs those
  tools and calls the model again. With the AI SDK the turn reports empty text,
  which used to end the task at once, so the tools never ran and the planner
  returned an empty draft.
- The planner is offered only `bash`, not the workflow's tools, so planning can
  no longer run a tool with side effects. Its prompt still lists every tool with
  its schemas for writing `tool.call` steps. A compile resumed after this change
  calls the planner model again, because its recorded request no longer matches.
- Each planner repair retry names its revision in the prompt. A planner that
  returned the same rejected draft twice used to replay its earlier session and
  fail with `EventAppendIdempotencyConflictError`; it is now asked again.
- The planner prompt shows each tool's output schema after its input schema, when
  the tool has one, so the plan can read `{{ steps.<id>.output.<field> }}` with
  the tool's real field names.
- The planner works on Claude. The AI SDK adapter asked for the plan as an
  object with an open schema, and `@ai-sdk/anthropic` sends every object schema
  to Claude's structured output with `additionalProperties: false`, so Claude
  could only answer `{}` and every compile failed with
  `planner_validation_exhausted`. The planner is now asked for text and its JSON
  is read from the reply, bare or inside a markdown fence. A reuse decision with
  an `lwir` field (`adapt`, `draft_fresh`) now reaches the compiler whole instead
  of being cut down to its `lwir`.
- When a reuse candidate is on offer, the planner prompt now shows the three
  decision objects (`reuse_unchanged`, `adapt`, `draft_fresh`) with the
  candidate's id and any warnings to acknowledge. A model planner was never told
  the format, so it drafted a new plan on every run.
- An `ai.generate` step with no `with.system` no longer sends an empty system
  prompt, which Claude rejects with "system: text content blocks must be
  non-empty".
- The default workflow harness sends a plan task's planning instructions once, in
  the system prompt. They also went into the first user message, so every planner
  call paid for them twice.
- A planner, fixer or orchestrator model turn that calls a tool that fails, with
  arguments the tool rejects or a tool name that does not exist, gets the error
  back as the tool result (`error-text` with the AI SDK) and can try again. It
  used to fail the whole compile. Permission refusals and cancellation still end
  the task.
- `ai.generate`, fixer and orchestrator model calls record the AI SDK model's
  real provider, so they are priced. The AI SDK's model classes define `provider`
  as a getter, which the runtime did not read, so these calls were recorded as
  provider `runtime` and every one ran unpriced on Claude, OpenAI and the rest.
  Only plain-object models with an own `provider` field were priced.

## [0.2.0-alpha.1]

A `little-workflow`-only release; `little-harness` stays at `0.2.0-alpha.0`.

### Added

- **`little setup`** creates a Node or Next.js project with a Little Harness agent
  and, with `--workflow`, a sample workflow, or adds them to an existing Next.js
  app. It is keyless by default, disables dependency lifecycle scripts, has no
  `--force`, previews with `--plan` without writing, and journals its writes so
  an interrupted run can be recovered with `--rollback`. See
  `packages/little-workflow/docs/setup.md`.
- `@little-stack/workflow/scaffold` exports `planSetup()`, `applySetupPlan()` and
  `rollbackSetup()`.

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
- **Connectors.** Chat SDK and web-rich connectors (`@little-stack/harness/connectors`,
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
  `instructions.md`) across 24 AI SDK providers; `@little-stack/harness/scaffold` exposes
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
  `@little-stack/harness/connectors`).
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
