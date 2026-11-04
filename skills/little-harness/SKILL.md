---
name: little-harness
description: "Use when working with the little-harness package: createHarness, streamHarness, generateHarness, localHost, virtualHost (workerd, Durable Objects), inputType, skills, memory, persistent dirs, files, artifacts, trace events, the session log and durability replay, sandboxes (localHost({ sandbox }) auto/in-process/subprocess modes, subprocessSandbox, tieredSandbox, justBashSandbox, classifyCommand), chat connectors (Chat SDK, email, web-rich, attachments, reactions), outcome capture, workflows as tools (asHarnessWorkflow, workflowBudgets), agent folders and the little-harness CLI (start, dev, schedules with defineSchedule), or the workflow-harness adapter."
---

# Little Harness

## Overview

Use this skill to build, debug, or explain Little Harness runtimes. Little Harness is the generic agent session runtime; Little Workflow consumes its workflow-harness adapter.

## Required Checks

1. Search the docs website content and package docs first: see [package-docs.md](references/package-docs.md).
2. Verify active APIs against source when editing code: see [source-map.md](references/source-map.md).
3. Use `pnpm` for package scripts in this repo.
4. Run the narrowest relevant check after edits, usually `pnpm --filter @little-stack/harness test`, `pnpm --filter @little-stack/harness typecheck`, or a targeted Vitest file.

## Unified setup

Prefer `npx @little-stack/workflow@alpha setup` for new standalone/Next projects and additive existing Next (`--here --template existing-next --plan`). `--here` only means the current directory; the existing-app mode needs `--template existing-next`. Harness is mandatory; `--workflow` wires a durable keyless example (a fixed-plan `starter_echo` workflow). Install requires `--install`; Workflow native build requires `--allow-native-build`. `--verify` forces keyless smoke. Preserve conflicts and user edits; no blanket force, major upgrades, browser userId auth, paid provisioning or deployment. Recover an interrupted run with `setup <same-dir> --rollback` (or `--here` inside it); it reports nothing-to-recover, rolled-back, completed-cleanup or manual-recovery-required, and `recoverSetup()` returns that status. Compute and LittleDB are not published on npm. See `packages/little-workflow/docs/setup.md`.

## Quick Reference

| Need | Use |
| --- | --- |
| Install in an app (Node 22+, AI SDK 7) | `pnpm add @little-stack/harness@alpha ai@^7 zod @ai-sdk/<provider>` (`ai` is a peer dependency) |
| Create an agent workspace | `npx @little-stack/harness@alpha init` (pins `@little-stack/harness`, `ai@^7`, provider, TS 6 — never `latest`) |
| Script workspace creation | `little-harness init support-agents --provider openai --model gpt-5.2 --yes --no-install` |
| Script a custom OpenAI-compatible provider | `little-harness init local-agents --provider openai-compatible --model local-model --yes --no-install` |
| Initialize the current directory | `little-harness init --here --provider anthropic --model claude-sonnet-4-6` |
| Add an agent to a workspace | `little-harness new <name>` |
| Create a local runtime | `createHarness({ host: localHost({ dataDir }), model, ... })` |
| Run with no disk (workerd, a Durable Object per chat) | `createHarness({ host: virtualHost({ fs }), model, ... })`: the session's `/session`, `/artifacts`, `/persistent`, `/.agents` and its status (under `/.little-harness`) live in the just-bash filesystem `fs`; the app routes chats and saves `fs`. Options `dataFs` (localDir/memory/workflow backing filesystem or async session factory, default session fs under hidden `/.little-harness/data/`; shared visibility has no cross-session transactions), `store` (DurableJsonStore for ask_person/parked turns, default memory), `sandbox` (default `justBashSandbox()`; `subprocessSandbox()` refuses). On workerd no `python3`, `node`, `sqlite3`, `tar`, `yq`, `xan`; `localDir` and memory work without disk; `projectDir` needs localHost. `dynamicWorkflows()` uses `virtualWorld` over `dataFs`: one-shot runs live under `<dataRoot>/sessions/<pathKey>/dynamic-workflows/<runId>`, defined runs/kept plans under `<dataRoot>/agent-workflows`; filesystem durability is inherited and workflow skill folders are refused. Guide: `runtime/virtual-host.mdx`; example `demos/workerd-chats` |
| Chat/UI streaming | `streamHarness({ harness, messages, session })` |
| One-shot jobs | `generateHarness({ harness, type, input, session })` |
| One plain-text request | `generateHarness({ harness, prompt: "Pre-approve APP-1001.", session })` (or `streamHarness`); not with `messages`, `type` or `input` |
| Typed job modes | `inputType({ description, inputSchema?, output?, toMessages? })` |
| Stage skills | `skills: [skill("./skills/name"), skill("https://github.com/org/repo", { skills: ["name"] })]` or inline skill objects |
| MCP servers | `createHarness({ mcp: { servers: [...] } })`; defaults expose `mcp_list_tools` and `mcp_call_tool` |
| Chat connectors | `@little-stack/harness/connectors`; use `@little-stack/harness/connectors/runtime` for server route loaders/descriptors |
| Give an agent an email address | `connectors/email/connector.ts` with `emailConnector({ address, adapter: resend, state, senders: { allow, authServId } })` + a route calling `loadChatSdkConnector(...).webhook(req)` |
| Streaming helpers, agent-folder loader | the root entry (`streamHarness`, `generateHarness`, `loadHarness(dir, { host? })`, `loadWorkspace`); there is no `/execution` or `/workspace` subpath. The root is a pinned list of 33 values (`src/index.test.ts`); add to it only what an app needs to build and run an agent |
| Read tool context in `execute(input, options)` | `harnessToolContext(options)` from `@little-stack/harness` (also `/connectors`); `tryHarnessToolContext` outside a run |
| Session logs | `fileSessionLog`, `inMemorySessionLog`, `remoteSessionLog`, `startSessionLogServer` from `@little-stack/harness/remote-session`; `HarnessSessionLog`, `createHarnessAppendIdempotencyKey` and the durable event types from `@little-stack/harness/events` (not the root) |
| Where `bash` runs | `localHost({ sandbox })`: `"auto"` (default), `"in-process"`, `"subprocess"`, or a sandbox factory (`subprocessSandbox({ ... })`, `tieredSandbox({ nextTier })`, `justBashSandbox()`) |
| Classify a script before running it | `classifyCommand(script, { runtime, policy })` → `run` / `escalate` / `deny`; `detectEmulationGap(result)`; `tier0CapabilityMatrix()` (all from `@little-stack/harness/sandbox`) |
| Write your own sandbox | `@little-stack/harness/sandbox` (`createShellRuntime`, `createEnvironmentToolBridge`, `createRuntimeToolBridge`, `localSessionWorkspace`, `resolveSandbox`, tracked-mount helpers) |
| Write or tune a host | `@little-stack/harness/host` (`createInMemoryOrchestrationServices`, `createDurableOrchestrationServices`, durable stores, `LocalSessionStore`, `HarnessOrchestrationServices`, `sessionKeyToPathKey`, local trace readers) |
| Little Workflow / Little Compute plumbing | `@little-stack/harness/internals` (hashing, skill and MCP resolution, workflow-tool plumbing, folder discovery). No stability promise; never import it from app code |
| Workflows as tools | `workflows: [asHarnessWorkflow(defineWorkflowResult, { definitionIdentity })]` (`asHarnessWorkflow` from `@little-stack/workflow`) + `workflowBudgets` |
| Record whether a run worked | `reportHarnessOutcome({ session, status })`, `createHarnessOutcomeReporter({ harness })`; read with `little-harness outcomes` / `aggregateLocalOutcomes`; with LittleDB, `sinks: [db.outcomeSink({ tracer })]` also sends them as user feedback |
| Scaffold programmatically | `@little-stack/harness/scaffold` (`scaffoldProject`, `scaffoldAgent`, `scaffoldDependencyVersions`, ...) |
| Long-term memory | `memory({ sourceDir \| backend, harnessDir?, description?, canWrite?, instructions?, skill? })`; layers: `memory: [memory({ sourceDir: "memory/company", harnessDir: "/persistent/company", description, canWrite }), memory({ sourceDir: ({ extraBody }) => ..., harnessDir: "/persistent/me", description })]`. No memory tool: the agent edits files; a built-in `memory` skill says how, and a skill named `memory` in `skills` replaces it. Guide: `build-agents/memory.mdx` |
| Persistent files | `persistentDirs: [localDir({ harnessDir, sourceDir, commit })]` |
| Workflow adapter | `@little-stack/harness/workflow-harness` |
| Dynamic workflows (agent authors one-shot plans or defines workflows) | `dynamicWorkflows: dynamicWorkflows()` (helper from `@little-stack/workflow`); adds `run_ad_hoc_plan`, `search_authored_plans` and `define_workflow`. Defaults to `localWorld` on localHost, `virtualWorld` over `dataFs` on virtualHost; custom World callbacks receive optional `fs` with `dataDir` |
| Isolated fan-out (UNRELEASED) | `agents: { launcher, profiles, joinPolicies, reductionPolicies, ... }`; injects the five Agent Group tools. Launcher port/types/errors come from the experimental `@little-stack/harness/agents` |
| Durable agent checkpoints | `checkpoints: { writer }`; injects `checkpoint` while the trusted writer owns tier, identity, and verification |
| Ask a person without blocking | `humanInput: { deliver(request) }` (needs `localHost` or another host with `durable`); adds `ask_person` (returns `{ status: "asked", taskId }` at once) and `harnessToolContext(options).ask(question, { key? })` for tools (`humanInput: { tool: false }` = tools only). The agent reads the answer with `await_tasks`; if it is not in, the turn parks. `answerInputRequest({ harness, sessionId, requestId, answer: { option \| text \| value }, answeredBy? })`, `listInputRequests({ harness })`, then `resumeParked({ harness, onResult })` continues parked turns (also `maxWaitMs` timeouts; call it on a timer; a turn that fails to continue is retried after `retryDelayMs`, doubling, and dropped after `maxAttempts`, default 5). Re-answering with the same answer finishes an answer the process stopped recording. Guide: `build-agents/asking-a-person.mdx` |
| Serve an agent folder, run it on a timer | `little-harness start <name> [--port] [--host] [--token]` serves `connectors/`, `POST /sessions/<s>/messages` (`{ prompt }`), `POST /jobs/<type>`, `GET /questions`, `POST /sessions/<s>/questions/<requestId>/answer`, `POST /schedules/<id>/run`, and calls `resumeParked` every 15 s. Without `--token`/`LITTLE_HARNESS_TOKEN` it binds loopback only (a non-loopback `--host` refuses to start) and the API takes only JSON requests to `localhost`/`127.0.0.1`/`[::1]` with no `Origin`; set a token behind a tunnel (ngrok, cloudflared), since tunneled requests arrive from loopback. `little-harness dev <name>` restarts on change with a terminal chat (sends `LITTLE_HARNESS_TOKEN` when set). Schedules: `schedules/<id>.ts` default-exports `defineSchedule({ cron, timezone?, prompt \| type + input, session?: "new", catchUp?: true })` (root export); `little-harness schedules <name>` / `schedules run <name> <id>`. Guide: `build-agents/serving-agents.mdx` |
| Trace/debug | inspect `.little-harness/sessions/**/trace.ndjson` |
| Per-turn model and prompt | `createHarness({ turnOptions: async ({ sessionId, session, extraBody, trigger }) => ({ model?, system?, temperature?, activeTools?, providerOptions?, ..., onEvent? }) })` (`HarnessTurnOptions`): awaited once per turn after the session is known, on every path (`generateHarness`, `streamHarness`, connectors, schedules, `little-harness start`); a call's own options win, `runtime`/`trace` merge, both `onEvent`s run; a throw fails the turn |
| LittleDB manages the prompt (private, unpublished) | `const support = db.managedHarness({ slug, bootstrap: { system, model: "fast" }, schema: z.object(...), models: { fast, smart } })` then `createHarness({ ..., turnOptions: support.turnOptions })`: each turn runs its session's version (sticky; leaves a rolled-back version; outages fall back to the last live answer then the bootstrap, with a circuit breaker), traced with it. A bootstrap edit after v1 becomes a "Changed in code" proposal LittleDB rebases onto live (`littledb pull harness:<slug> --field system` takes the live text back). Content failing `schema` or naming an unknown slot runs the bootstrap. `support.registry` (+ `support.registry.world(inner)`) for agent-made workflows; `support.evalWorker({ run })` runs experiments (inside, turns run the candidate). `littleDBFromEnv()` is offline without `LITTLEDB_URL`; `testLittleDB()` from `@little-stack/littledb/testing` for tests. Workflows: `db.managedWorkflow({ slug, bootstrap })` + `versionedHarnessWorkflow(source, build)` from `@little-stack/workflow` |
| LittleDB (private, unpublished; needs a non-public LittleDB server) | `createLittleDB({ url, apiKey })` from `@little-stack/littledb`: by hand, `db.resolve({ kind: "harness", slug, stickyKey, bootstrap, schema? })` picks the version (`{ system, model }` content; `mode` live/trial/holdout/none) and you pass `system`/`model` per run to `generateHarness`/`streamHarness`; `onEvent: db.harnessTracer({ harness, resolution }).onEvent` sends each turn as a trace (raise `trace.content.previewBytes` from 512 for whole prompts), with how it started from `generateHarness`/`streamHarness({ trigger: { kind, source?, from?, label? } })` (`HarnessTrigger`; connectors, schedules, the agent server and the REPL set one, yours wins; sent as `triggerKind`/`triggerSource`/`triggerFrom`/`triggerLabel` metadata on `harness.session.started`, redact `triggerFrom` with `trace.redaction.metadataKeys`); `db.score({ traceId, name, value, source })`; `dynamicWorkflows({ registry: db.agentWorkflowRegistry({ harness }), world: (run) => db.tracingWorld(localWorld({ dataDir: run.dataDir }), { workflow: run.handle, ... }) })` makes each `define_workflow` a draft version with a proposal a person approves (each run's trace carries the session and points at the turn's trace and the tool call; no `sessionId` needed); `db.evalWorker({ subjects, run })` runs LittleDB experiments in the app. OTLP/HTTP at `<url>/v1/otlp/v1/traces` is the alternative. Docs: `reference/using-littledb.mdx` |
| LittleDB managed memory (private, unpublished; Convex LittleDB stack) | `memory: [db.memory.org<U>({ space: "lending-rules", org?: ({ extraBody }) => extraBody?.orgId, description, canWrite?, by?: ({ extraBody }) => ({ id, label, role }), seed?: new URL("./memory/lending-rules", import.meta.url), review?: "person" \| "after" \| "none" }), db.memory.user<U>({ user: ({ extraBody }) => ({ id, label }) })]`: each returns a plain Harness `memory()` option backed by LittleDB (harnessDir `/persistent/org/<space>` and `/persistent/me`). Org `canWrite` defaults to nobody; an org change waits for a person in the Memory tab (one waiting change per conversation; the conversation itself sees its own waiting edits); a person's memory saves at once and stays private (admins open it only through an audited action). `seed` is v1; a later folder edit is one "Changed in code" change. `org`/`user` returning nothing fail the turn. Traces get `memory <space>` retrieval spans with the exact revisions (snapshot) and a `saved` event. LittleDB down: last copy in the process (else empty), and that turn's changes are not saved (`onError`). `db.memory.handler({ authorize })` (GET lists, DELETE forgets a person's own memory) and `db.memory.forgetUser({ user, org })`. Workflows: `db.managedWorkflow({ memory: [...] })` reads it read-only, `run.memory.note()`. Offline: folders under `.littledb/memory` (`LITTLEDB_MEMORY_DIR`); tests: `testLittleDB().memory` (`files`, `waiting`, `approve`, `reject`, `setReview`, `put`). Docs: `littledb/memory.mdx`; gbrain as a plain `backend`: `cookbook/gbrain-memory.mdx` |
| LittleDB guardrails and autonomy (private, unpublished) | Set in LittleDB, not in code: `policy.autonomy.mode` (`review`/`guarded`/`auto`) decides what the improvement loop ships without a person; guardrails (UI, `/v1/guardrails`, or the LittleDB agent) are rules in words with exact checks (protected text/fields, behavior rules over tool calls) that a change must keep. The loop never changes tool code, so enforce money thresholds in the tool (`harnessToolContext(options).ask` above the limit) and add a guardrail so no version works against it. Docs: `littledb/guardrails.mdx` |
| Users' feedback to LittleDB (private, unpublished) | Stored as scores with source `user`; reviews, trials and rollback weigh it (`policy.feedback.gate`: `off`/`harm`/`require`). Reactions and outcomes: `sinks: [db.outcomeSink({ tracer, feedbackName? })]` (success/failure = thumbs up/down, partial = rating 3/5, a 0..1 `score` = rating, `detail` = comment, `reporter` = userId, `reportKey` = stable id, `revision` = the caller's order under the key (LittleDB keeps the highest; a late older one, or one without a revision once the id has one, is `stale` and the sink answers `{ ok: true, stale: true }`; a different report at the revision applied is a 409), `retracted` withdraws unless the person since reacted the other way (with a revision, the store decides); never throws). Backend: `db.feedback({ traceId \| sessionId, thumbs?, rating?: { value, scale? }, comment?, survey?, answers?, userId, id: feedbackId(userId, messageId) })` (needs a target and something said; throws), `db.retractFeedback(id)`. Browser: mount `db.feedbackHandler({ authorize: (req) => ({ userId }) \| null, resolveTrace? })` (Fetch handler, `POST`/`DELETE`; forces `userId`, scopes ids per user, 16 KiB limit, JSON only; the key never reaches the browser). A turn's trace: `tracer.traceIdFor(sessionId)` right after it, or `tracer.traceIdForTurn(sessionId, event.turnId)`. Key scope `feedback` (or `ingest`). Keep `userId` pseudonymous; comments reach the reviewer as untrusted data. Docs: `build-agents/user-feedback.mdx` |

## Generic Harness Pattern

```ts
import { openai } from "@ai-sdk/openai";
import {
  createHarness,
  inputType,
  localHost,
  streamHarness,
} from "@little-stack/harness";
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

Use `@little-stack/harness/workflow-harness` only for Little Workflow-compatible harness work:

```ts
import { createWorkflowHarness } from "@little-stack/harness/workflow-harness";

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
import { createHarness, localHost } from "@little-stack/harness";
import { dynamicWorkflows } from "@little-stack/workflow"; // helper injects the plan-lowering factory

const agent = createHarness({
  host: localHost({ dataDir: ".little-harness" }),
  model,
  tools: { docsSearch, docsRead },
  dynamicWorkflows: dynamicWorkflows(), // off by default; NOT a bare `true`
});
// Optional: dynamicWorkflows({ exclude: ["dangerousTool"], limits: { maxSteps, maxRuntimeMs }, models: { fast: haiku }, define: false })
```

Adds two model tools: `run_ad_hoc_plan` (author + run a step-DAG plan of `tool.call`/`ai.generate` steps; returns the result) and `search_authored_plans` (recall a prior plan and re-submit it; returns up to five completed plans, newest first, one per distinct plan). A `tool.call` step is `{ id, uses, tool, with }`; an `ai.generate` step is `{ id, uses, model, prompt, output? }`, where `model` is `default` (the agent's model) or a slot from `models`. Unknown step fields, an empty prompt and `$input.x`-style references are rejected at submission; missing `needs` are added. Every submission re-runs every step; wrap tools that write with `once(tool, { key: (input) => input.applicationId })` so a step that repeats the call in the same session gets the recorded result (this covers configured workflows' steps too; agent's own calls and other sessions run again; a result that cannot be saved as JSON makes a repeat throw `HarnessPersistenceError` instead of rerunning). Step tool calls get the agent call's harness context plus `harnessToolContext(options).idempotencyKey` (same tool + input or key + session).

It also adds `define_workflow` (off with `define: false`), for work that will come again: the agent sends `{ id, description, inputSchema, outputSchema, tools, policy?, models?, runWith? }` and gets a `defineWorkflow` workflow planned once by its own model (steps on `default` or a `models` slot, limited to the definition's `models` list when given; `policy` in every model step). From the next turn on, in every session on the same host `dataDir`, it is a tool named after the id (`.` becomes `_`); `runWith` runs it in the defining call. Same id again = new revision. Definitions live in `/persistent/dynamic-plans/workflows/`; runs, plans and grades in `<dataDir>/agent-workflows` (open with `localWorld` for `gradeRun`). See the docs site guide `build-agents/dynamic-workflows.mdx`.

Two optional hooks put agent-defined workflows under the host's control. `dynamicWorkflows({ registry: { defined?, resolve? } })`: `defined(record, { sessionId, turnId })` runs after `define_workflow` stores a revision and may return `{ note?, metadata? }` (the note replaces the default one in the tool's answer; the metadata reaches the `runWith` run); `resolve(records, ctx)` runs at turn start and returns the offers (records, other revisions, or definitions the registry holds, each with optional `metadata`). Without a registry every stored definition is offered; if `resolve` throws, the turn offers none and carries a warning. `dynamicWorkflows({ world })` takes a World or `(run) => World` for defined-workflow and one-shot-plan runs; `run` is `{ kind: "defined" | "ad_hoc", workflowId, handle, runId, dataDir, sessionId, turnId, definition?, revision?, metadata? }`, and the default stays a Local World at `run.dataDir` (the host's agent-workflow store for defined workflows, the session's store for one-shot plans). LittleDB's registry and tracing World use these hooks (below).

## Implementation Notes

- `createHarness` requires `host`; UNRELEASED source can omit `model` when the call or `turnOptions` supplies one (the published alpha still requires a default). Without any model the turn fails before a provider call.
- LittleDB's `managedHarness({ resolveModel })` can supply a `provider/model` descriptor and payer (`key` or `credits`); named `models` slots take precedence. A parked turn pins its version, content and actual model decision. Fresh clients and repeated parks restore the same descriptor through `resolveModel` without resolving latest; retain that resolver on restart. A malformed model pin, removed required resolver, or legacy prompt-only pin with no model decision fails closed. Legacy named-slot pins still work; a new explicit code/slot decision is not replaced when a resolver is later added. A missing provider key must fail rather than switch to credits. The hook's `metadata` reports the version; its `pin` is the opaque durable decision used to continue it.
- `generateHarness()` resolves to `HarnessTurnResult`, a union on `status`: `completed` or `parked` (a tool
  parked the turn). Narrow with `status === "completed"` before reading `text`, `output`, `persistence` or
  `commitManual`; `trace`, `session` and `artifacts` exist on both. Every example that reads a completed-only
  field needs that guard, or it does not compile.
- Checkpoints (UNRELEASED: not in published `0.2.0-alpha.0`) are opt-in through `checkpoints: { writer }`. The model may supply only a label,
  `goal_reached | pre_risky_op` kind, rationale, and evidence artifact ids. The writer derives durable
  identity and owns tier, state, author, time, cost, retention, and verification; the model cannot claim
  `verified_green`. The writer receives the Harness-supplied session/turn/model-step/sequence position, and
  retries carry the same deterministic call identity. A writer may return `coalesced` with an existing
  milestone id for a distinct semantically redundant call; preserve that call's own identity instead of
  treating milestone id as the call key. Little Compute's Direction-v2 local profile coalesces against the
  current compatible checkpoint head, not any historical matching tree, and does not rewrite the original
  milestone's Harness position. The retained advanced profile keeps its existing non-coalescing replay behavior.
- Agent Groups (UNRELEASED: not in published `0.2.0-alpha.0`; label docs that use `agents` accordingly) are
  opt-in through the neutral `agents` launcher port. The model selects declared composite
  profile, join-policy, and reduction-policy handles; it never supplies raw resources, secrets, tools,
  network policy, priority, verifier, or check-set bindings. Schemas enumerate trusted handles/descriptions;
  per-member and aggregate prompt bounds apply, and reservations run concurrently. `spawn_agent` lowers to a
  one-member atomic group. The launcher port (`HarnessAgentGroupLauncher`), its request/result types, the
  `HarnessAgentGroup*Error` classes, the `HARNESS_AGENT_GROUPS_PROTOCOL_VERSION` /
  `HARNESS_AGENT_GROUP_PAGES_PROTOCOL_VERSION` constants and the ledger projection types are imported from the
  experimental `@little-stack/harness/agents` entry; only `HarnessAgentGroupsOptions` is on the root.
  Launchers must atomically accept all ordered members or none, use unique group refs,
  and deduplicate `callIdentity`; accepted group/member bindings commit through one durable authority. Throw
  `HarnessAgentGroupLaunchRejectedError` only when no member was accepted. Other start failures are
  acceptance-indeterminate and retry the same identities. A v1-only launcher keeps byte-identical complete
  snapshots and a 1,024-member configuration ceiling. Supplying the optional `paged: { watch, join, cancel }`
  object (all three or none, enforced by the type) selects the 10,000-member aggregate/change path: cursors are opaque, authenticated or store-bound, and distinguish
  invalid/expired/mismatched errors. The v2 page request accepts legacy v1 member changes while preferring an
  explicit gap-free `member | group_control` change union; group-only deadline/return/cancel transitions consume
  the same sequence instead of fabricating a member update. Aggregate version equals the page high-water;
  canonical byte/count/cursor limits and exact request replay fail closed. Join/cancel `begin` mutates once while
  cursor `continue` only reads the stored result. A bounded join may return a durable, digested
  `pendingOperation`; Harness presents it as `operation.state: "waiting"` and requires its exact ref on
  continuation instead of inventing a deadline result. Little Compute's paged launcher
  (`littleComputeAgentGroups`, from the unpublished `@little-stack/compute/harness`) projects only bounded
  summaries plus opaque Artifact refs; its legacy snapshot methods intentionally fail and are not selected
  when `paged` is present. Its internals belong on Compute's "Use from Little Harness" page, not in Harness docs. A paged ledger must
  reserve each join-begin identity before launcher I/O and share its active reservation fence with group GC.
  If a launcher binds an operation ref but the response payload or terminal visibility is incomplete, Harness
  returns `operation.state: "continue_required"` with only that opaque ref; the caller resumes through the
  normal join continuation, and the reservation is released only after visibility is authorized.
  The compact ledger path is O(changes), with deterministic
  sequence/member/receipt records and direct response-loss recovery on both Map and file durable stores; atomic
  launch remains O(members), uses a direct ref index rather than history scans, and persists an exact start-envelope
  digest. Prepared launch journals compact after commit and reconstruct replay with point reads. After acceptance,
  exact start replay returns an immutable accepted-start receipt before launcher I/O; it never exposes mutable
  terminal rows, relaunches the group, or rewinds progressed member authority. Receipt replay
  requires an authority-bound commit identity (including zero-change join reductions), not just a matching
  high-water mark. Replay history retains 4,096 sequences plus bounded live-call/expiry windows and permanent
  retired-call digests, with a 65,536-call typed lifetime ceiling before adapter I/O; old cursors fail with typed
  `expired`, and cursorless reads reopen at the durable high-water. Explicit exact-CAS terminal collection removes
  bulky group/task/operation/result-ref authority crash-safely while leaving compact global group/start receipts
  that block cross-session resurrection. GC revalidates immediately before deletion and conditionally removes
  exact owner digests through a recoverable cleanup state. Its owner list is bound to exact member first-publication
  identities and aggregate result-ref count; durable `deleting` is an irreversible writer fence across restarts.
  Result-ref publication uses sorted per-ref locks and recoverable claims proven by the exact immutable publication
  sequence; unchanged refs preserve their first publication sequence/revision/digest. Operation result
  bytes stay hidden from the model until the page reaches their version, and result refs must have direct same-group
  ownership published no later than that version. Legacy snapshots and
  pages both require separately fenced join reductions, bounded
  summaries/result refs, terminal-only bounded failure codes, bounded timestamps, and no raw child output.
  Queued/running members cannot publish a result ref or failure code. `first_verified` requires a
  trusted receipt bound to configured verifier/check-set handles; only derived `verified: true` is model-facing.
  Adapter task refs stay internal. The two base ledger capabilities are optional unless `agents` is configured;
  the page trio additionally requires compact group lookup and O(changes) page projection.
  After external launch binding, mutate/cancel through the Agent Group port rather than generic task-ledger
  methods.
- `little-harness init` is the guided wizard for new workspaces. It asks for project name, searchable
  AI SDK language-provider/model selection, optional custom provider model id, and dependency install
  confirmation. The catalog currently offers 24 provider choices: the official AI SDK language-model
  providers plus a custom OpenAI-compatible API scaffold. Some providers require more than an API key;
  use the env vars printed by the CLI and generated in `agent.ts`. Without `--provider` (for example
  with `--yes`) the provider is `openai`, the same default as `little setup` and `little init`.
  Unknown options are rejected; `little-harness init --workflow` points to `little setup --workflow`
  (Little Workflow's scaffolder), and `init --help` / `new --help` print usage.
- `little-harness new <name>` adds another agent to an existing workspace; do not present it as the
  primary new-workspace command.
- Install: Node.js >= 22; `ai` is a **peer dependency** (`^7.0.0`) — `pnpm add @little-stack/harness@alpha ai@^7 zod @ai-sdk/<provider>`. AI SDK 6 is unsupported. The root entry re-exports `LanguageModel`, `ModelMessage`, `UIMessage`. Package exports use the `default` condition (require(esm) works) and expose `./package.json`.
- AI SDK 7 names in examples that call `ai` directly: `instructions` (not `system`) for `generateText`/`streamText`, `isStepCount` (not `stepCountIs`), `onStepEnd`/`onEnd`, and tool execute options carry `context` (not `experimental_context`) — custom tools reading `callerRunIdentity`/`sequenceIndex`/`modelStepId`/a workflow `signal` read `context`. The harness's own options are unchanged: `createHarness({ system })`, `toUIMessageStreamResponse()`. `stopWhen` is a per-call `generateHarness`/`streamHarness` option (not `createHarness`), defaulting to `isStepCount(workflowBudgets.maxModelSteps ?? 20)`.
- `localHost()` defaults to `.little-harness` and stores sessions, artifacts, persistent checkouts, staged skills (`.agents/`), turns, workflow run stores (`workflows/`), and traces. It sets the optional `HarnessSession.dataDir` port field to the session folder; a custom host without `dataDir` gets `<cwd>/<sessionId>/workflows`.
- Sandbox modes: `localHost({ sandbox })` (type `HarnessSandboxMode | HarnessSandboxFactory`) defaults to `"auto"` (was `"in-process"` before 0.2.0): in-process just-bash only when `runtime.python` and `runtime.javascript` are both explicitly `false` and network is off; `subprocessSandbox()` otherwise (so almost always). `"in-process"`, `"subprocess"` (defaults only), or a factory override it. `subprocessSandbox({ env, watchdogGraceMs, initTimeoutMs, nodePath, workerPath })`: empty env by default (replaced, not merged), SIGKILL watchdog (5000 ms grace), 30 s init deadline; bundlers need `workerPath` or `@little-stack/harness` kept external.
- Tier-0 contract: just-bash is a **compatibility layer for trusted tool patterns, not an isolation boundary**. Never describe it as protecting against untrusted scripts. Model-authored code must not run in-process (`"auto"`/`"subprocess"` enforce this; `"in-process"` does not). The subprocess sandbox is the floor beyond pure read tools; `defenseInDepthForAdapter("subprocess")` is true and `("in-process")` false because the layer patches process-wide globals. Neither tier confines native code — use an OS sandbox behind a custom factory.
- Tiered execution (opt-in): `localHost({ sandbox: tieredSandbox({ tier0?, nextTier?, policy?, matrix? }) })` (`tier0` defaults to `justBashSandbox()`, in-process just-bash). Escalates when `classifyCommand` returns `"escalate"` (before running) or `detectEmulationGap` matches stderr after a Tier-0 run (retried once). Sticky; carries env + cwd only; invisible to the model (hints from Tier-0). Needed-but-unavailable tier or `policy.denyCommands` → refused with exit code 126 (`TIER_REFUSED_EXIT_CODE`). Events: `harness.runtime.tier.escalated`, `harness.runtime.tier.unavailable`, `harness.runtime.command.denied`. Unsupported commands run on Tier-0 exit 127 (`command not found`). Dispose bracket uses `snapshotTrackedMounts`/`emitTrackedMountFileChanges` (from `@little-stack/harness/sandbox`).
- Disposal errors of any sandbox are reported as `harness.runtime.dispose.failed` (never thrown; `doctor` counts it as a failure).
- Harness ports break in 0.2.0: a sandbox factory (`HarnessSandboxFactory`, e.g. the one `justBashSandbox()` returns) takes `CreateSandboxOptions` with `{ workspace }` (a `HarnessWorkspaceSpec`), not `{ session }`; `toolContext` is required when `tools` are passed to a sandbox factory; `HarnessSession` gained `setStatus`, `markMessageStaged`, and read-only-persistent-dir accessors; `HarnessHost.kind` is a `string`.
- Workflows as tools: `createHarness({ workflows })` takes `HarnessWorkflow` objects. A `defineWorkflow` result must be wrapped: `asHarnessWorkflow(workflow, { definitionIdentity })` from `@little-stack/workflow` (`definitionIdentity` required: stable string or `{ notApplicable: true }`); `loadWorkflow(folder)` results already are HarnessWorkflows. Tool name = id segments joined by `_` (`billing.refund` → `billing_refund`). The model receives `{ status, runId, outputSummary?, outputPath? }` (failures add `causeCode`, `message`), with `outputSummary` capped at 4096 chars — never the typed output. `workflowBudgets.maxConcurrentWorkflowRuns` (10) / `maxQueuedWorkflowRuns` (100) bound inline fan-out per session (FIFO; overflow → `causeCode: "max_queued_workflow_runs"`). Agent folders discover `workflows/*.ts` default exports (must be HarnessWorkflows) via `loadHarness`.
- Outcome capture: `outcome.reported` is a side-channel trace event (not in the session log). `reportHarnessOutcome({ session | sessionId+harness | tracePath, status, score?, detail?, source?, reporter?, reportKey?, revision?, retracted?, stepPath?, promptHash?, sinks? })` and `createHarnessOutcomeReporter({ harness, sinks?, source? }).report(...)` never throw (result `{ recorded, event?, delivered, stale, failed, errors }`; `stale` counts sinks whose store already held something newer). Under one `reportKey` the reader ranks by `revision` (missing lowest); at one revision the first report stands and a retraction wins. Read with `aggregateLocalOutcomes({ dataDir, sessionId? })`, `aggregateOutcomes`/`foldOutcomeReports`, or `little-harness outcomes [session-id]` (rates per promptHash/stepPath with sample size `n`; `successRate` null when n = 0).
- Chat SDK connectors: `reactions` are ON by default (thumbs up/down on agent replies → outcomes, `source: "chat-sdk"`, pseudonymous reporter `anon_<16 hex>`); `reactions: false` opts out; `reactions: { sinks: [db.outcomeSink({ tracer })] }` sends them to LittleDB as user feedback. `attachments` are on by default: inbound files become UIMessage `file` parts (10 MiB per file, `DEFAULT_ATTACHMENT_MAX_BYTES`; `attachments: { maxBytes, onSkipped }`; `false` opts out); skipped files become a text note, never a failed turn. Helpers `resolveInboundAttachments`, `createReactionOutcomeHandler`, `classifyReaction` are exported from `@little-stack/harness/connectors` (not `/runtime`).
- `@little-stack/harness/scaffold` exports `initWorkspace`, `scaffoldAgent`, `scaffoldProject`, `renderAgentSource`, `resolveProvider`, `resolveModelChoice`, `scaffoldDependencyVersions`, `providerDependency`. Scaffolds pin `@little-stack/harness` (^own version), `ai` ^7.0.0, the provider's AI SDK 7 range, and TypeScript 6 — never `latest`.
- The sandbox, tools, session log, and orchestration are decoupled ports (docs site: Runtime → Execution Environments). Sandboxes (`HarnessSandbox`) are created per turn by a `HarnessSandboxFactory` from a `HarnessWorkspaceSpec` (mount table + capability toggles), never from a session object; `localHost({ sandbox })` swaps the factory, `localHost({ orchestration })` swaps the durable ledgers (`createInMemoryOrchestrationServices()` from `@little-stack/harness/host` ships as an alternative; both backends share one ledger core over a five-method `DurableJsonStore`), and `localSessionWorkspace(session)` (from `@little-stack/harness/sandbox`) builds the canonical `/session`,`/artifacts`,`/persistent`,`/.agents` layout.
- For a configured experimental Little Compute prepared installation, its `littleComputeSandbox({ socket, preferPreparedSessions: true })` adapter (from `@little-stack/compute/harness`) tries prepared acquire before ordinary open. A Tier-1 session is one persistent shell: commands from parallel tool calls queue and run one at a time rather than failing as busy. Only an explicit miss permits fallback; uncertain errors refuse escalation. The Harness prelude and workspace handoff still run. With the `prepared-workspace-overlay.v1` kernel feature, unused stock can serve different workspace paths within the same project/configuration/runtime identity; the one-use claim verifies and installs an archive up to 128 KiB before promotion. Larger archives miss to ordinary open. Earlier installations match exact workspace bytes and path. Opened sessions report `source` (`prepared`/`ordinary`) and, after an explicit miss, `preparedMissReason` (`stock_empty`, `workspace_too_large`, `slot_unavailable`, `unreported`); `littleComputeSandbox({ onSessionOpened })` observes them without being able to fail escalation. Private keepalives and workspace installation do not count as user commands; maintenance stops before handoff. Fixed Python developer-socket timings are not a Harness/Vite latency guarantee.
- `subprocessSandbox()` runs just-bash in a lazily spawned child process: exec + `js-exec` tool calls proxy over stdio to the parent's Runtime Tool Bridge, and spawn receives an empty environment by default so parent credentials never reach sandboxed code (the OS may inject non-secret process metadata). Events are identical to the in-process adapter because `createShellRuntime()` owns them once.
- The durable event log is the session's source of truth: `startSessionLogServer()` serves the strict `lh.remote-session.v1` protocol over HTTP (optional bearer token) and `remoteSessionLog({ baseUrl })` is a `HarnessSessionLog` client (configured via `sessionLog`; there is no `durability` alias; both from `@little-stack/harness/remote-session`, the type from `@little-stack/harness/events`) — a fresh process with the same `runId` resumes from the remote log alone. Every `DurableHarnessEventInput` requires a caller-generated `appendIdempotencyKey`; derive it before transport with `createHarnessAppendIdempotencyKey({ runId, eventType, logicalEventId })` (from `@little-stack/harness/events`). It is distinct from optional causal `occurrenceId`. Identical `(runId,key,digest)` retries return the original event/sequence, different content conflicts, and transports/stores must never invent a replacement key. Use `payloadArtifactId` instead of inline `payload` for large content. Multi-step turns re-call the model per step on replay; tool side effects are never re-executed. A model tool runs only after its `harness.tool_call.started` append is acknowledged, and a failed model or tool append fails the turn (`generateHarness` rejects, `streamHarness` `finished` rejects) instead of completing.
- File mutation emitters allocate one stable `occurrenceId` at the mutation boundary and share it across the mutation's file/tool/artifact projections. Repeated byte-identical writes are distinct occurrences; never use a content hash as the logical mutation identity. Remote adapters pass that identity to `createHarnessFileMutationEvents()` before transport retry.
- Turn budgets: `turnLimits.accounting` defaults to `"run"` (legacy per-run reset). `"logical-turn"` persists actual SDK-visible provider attempts and known response cost across parks/resume/restarts through `orchestration.turnBudgets`; initial trusted session + runId identify the origin and continuation `budgetRef` must survive unchanged. Concrete V2/V3/V4 model handles and `prepareStep.model` overrides are metered before actual provider I/O, not by `model.called` notifications. Genuine repeated calls count again; completed response/tool-effect replay has no fake model charge. A step-only budget (no `maxCostUsd`) may continue after unknown usage, retaining every reservation as a consumed step; it never converts unknown usage to zero or refunds the step. With a cost ceiling, pending reservations or invalid/unknown usage/pricing stop with `BudgetStateUnavailable`; HTTP status/isRetryable alone is not a zero-usage certificate; only the host may attest a free refusal with opt-in `turnLimits.refusedBeforeEffect(error, { provider, modelId })`, asked only when the provider call itself rejects (never aborts, begun-stream errors or usage-less streams), which settles the reservation `refused` (`refusal: "host-attested"`, zero usage/cost, still one step). A limit reached on an AI SDK retry throws the typed `HarnessTurnLimitError`, not `RetryError`. Missing/corrupt accounting stops both modes and grants no fresh allowance. Known cost threshold uses `CostLimitExceeded`; a crossing call may finish, so do not promise a prepaid hard cap or exactly-once provider billing. `deadlineMs` stays per run. File budget writes/origin journals fsync before ack; custom stores need optional `writeJsonDurable`; memory only qualifies within its instance. No Convex/caller counters.
- Trusted callers can supply async `beforeInvocation` to generate/stream/resume; the actual provider boundary awaits it then rechecks required-record errors/abort. Rejection blocks entry; `onEvent` cannot provide a safety fence. With this hook aliases fail closed: use concrete models, including dynamic overrides. An already in-flight invocation may finish.
- `fileSessionLog()` (from `@little-stack/harness/remote-session`) is a single-process reference backend: default sync acknowledges only after file and parent-directory fsync, newline commits each record, only a final unterminated fragment is discarded, and malformed complete records or per-run sequence gaps fail closed. `sync: false` is not crash durable; use Little Compute PostgreSQL for multiple writers.
- Treat every bundled file-backed durable root as private to the Harness process (for example mode `0700`, never tenant-writable). Portable JavaScript filesystem APIs cannot make ancestor validation and the following operation one fd-relative `O_NOFOLLOW` transaction, so the file backend is not a hostile-local-user path-race boundary; use database-backed orchestration for mutually untrusted writers.
- Trusted remote file adapters call `createHarnessFileMutationEvents()` from `@little-stack/harness/remote-session` after a file outcome is durable; this is the same canonical `harness.file.*` / `harness.artifact.created` serializer used by the local evented writer. Treat it as a bounded protocol boundary: metadata is plain JSON (no accessors/symbols), at most 10,000 nodes/64 levels/256 KiB, with 64 KiB strings, 1 KiB keys/labels, and 4 KiB paths.
- Developers can keep authored local skills in `./skills/<name>/`; the runtime materializes resolved skills read-only under `.agents/skills/<name>/` from the harness working directory.
- Remote skills must use explicit Git URLs, not shorthands like `org/repo` or `github:org/repo`. Omit `skills` to install all non-internal skills from the source; include a commit SHA/ref when version pinning matters because the cache is keyed by resolved commit SHA.
- Private remote skills can use per-source bearer auth or the host-level `LITTLE_SKILLS_GIT_TOKEN` plus `LITTLE_SKILLS_GIT_TOKEN_HOSTS` fallback.
- Risk gates are optional. Put `skillOidcToken` on `createHarness` or resolver defaults, and use `skillMaxRisk` globally or per source plus `skillRisk` for selected remote skill names.
- Remote Git skill failures are soft at runtime: unavailable repositories, missing selected skills, and failed remote audits skip that remote source and surface warnings. Local path/frontmatter errors remain strict.
- Little Compute workspace transfer excludes the runtime-owned top-level names `workspace`, `.little-compute-managed-agent`, `.little-compute`, and `.little-compute-supervisor`; keep caller application files outside those names.
- User tool names cannot be `bash`, `checkpoint`, or one of the five reserved Agent Group tool names, whether the tool
  is configured in `createHarness` or discovered under `tools/`, and even when `checkpoints` or `agents` is not
  configured; rename an existing tool called `checkpoint`. The runtime injects `bash`, injects `checkpoint` only when
  `checkpoints` is configured, and injects Agent Group tools only when `agents` is configured.
- Configured, discovered and MCP `start_*` tool names are allowed unless their exact name collides with an active generated workflow launcher; workflow handles still cannot begin with `start_`.
- Tool handlers receive Little Harness context through AI SDK execute options: `session`, `files`, `artifacts`, `extraBody`, `abortSignal`, and replay/spooling helpers. Read it typed with `const { files } = harnessToolContext(options)` (from `@little-stack/harness`); never type the second argument as `any`.
- Every error Little Harness throws on purpose extends `LittleHarnessError` with a stable `code` (for example `"page_call_limit"`, `"harness_append_idempotency_conflict"`, `"remote_session_protocol_error"`, `"file_session_log_durability_error"`); catch the base class to handle them all.
- MCP is exposed as ordinary AI SDK gateway tools, not a parallel execution API. Default gateway names are `mcp_list_tools` and `mcp_call_tool`; optional aliases are still normal tools.
- MCP gateway tools use the same trace, durability replay, Runtime Tool Bridge, abort signal, and `toolResultSpooling` behavior as other tools. Oversized MCP output goes through normal tool result artifacts.
- Anthropic prompt caching is on by default (`promptCaching`): the system prompt carries a cache point and the request turns on automatic caching, so later sessions and steps read the shared tools and instructions from the cache. That is 2 of Anthropic's 4 cache points; on Amazon Bedrock (provider id starting with `bedrock`) the automatic one is left out because Bedrock rejects it for older Claude models. Keep dates, user names and other per-session values out of `system`, or every session misses the cache. `createHarness({ promptCaching: false })` turns it off.
- MCP guide skills are staged under `.agents/skills/<server-id>-mcp/SKILL.md` when configured. They are guidance only and do not grant capability; `mcp` config and tool visibility control access.
- Per-agent `connectors/` folders are connection layers, not harness capabilities. `loadHarness()` ignores them.
- Both `@little-stack/harness/connectors` and `@little-stack/harness/connectors/runtime` statically reach `node:fs/promises` (via the shared `streamHarness` → skill-staging code), so a value import from either is server-only; a types-only import (`import type`) from any subpath is safe. The real distinction is discovery, not `node:fs`: `/connectors/runtime` omits the filesystem discovery helpers so a bundler does not statically link the connector-module dynamic-import machinery through it — that is why it is the right server-bundle surface.
- Use `@little-stack/harness/connectors` for the full surface: connectors, web-rich routes, session helpers, tool extensions, `harnessToolContext` (also on the root), tool UI types, plus the discovery helpers (`discoverConnectors`, `loadConnectorDescriptor`, `loadConnectorToolExtensions`). A value import statically links the discovery module. Explicit discovery-only import: `@little-stack/harness/connectors/discovery`.
- Use `@little-stack/harness/connectors/runtime` in server bundles for connector descriptors, route loaders, session registry, tool-context helpers, and tool-UI types. String connector ids still work because the loaders dynamically load discovery at call time.
- Prefer nested connector folders such as `agents/support/connectors/slack/connector.ts` when a connector has tool extensions, renderers, or delivery helpers. Flat `connectors/slack.ts` descriptors still work for simple connectors.
- A string connector reference like `loadChatSdkConnector({ agentDir, connector: "slack" })` is the shortest way to opt into extension discovery and portable session attachment. A statically imported descriptor object plus `connectorId` is functionally equivalent (same discovery/attachment/mirror) and is the typed option — a descriptor infers `TExtraBody`/`TUser`, a string ref is `unknown`. Neither is universally preferred; pick per route. A descriptor object without `connectorId` disables folder tools, session attachment, and mirror delivery.
- Use `extendTool(baseTool, { execute })` in `connectors/<id>/tools/<tool-name>.ts` for real connector capabilities. The folder name is the connector id and the file name is the model-facing tool id. Abstract base tools without `execute` are exposed only when the active connector provides an executable extension. The explicitly imported base wins over a same-name `tools/` base. Connector tool filenames are reserved-name validated (`bash`, `__proto__`, `constructor`, `prototype`, identifier regex).
- Read the harness execution context in a connector tool with `harnessToolContext<TExtraBody>(options)` (throws outside a run) or `tryHarnessToolContext<TExtraBody>(options)` (returns undefined). Do not cast `options`. `ctx.connector?.endpoint` is a typed `SessionConnectorEndpoint`. `ctx.extraBody` is `TExtraBody | undefined`.
- Carry connector-only tools programmatically with descriptor `tools?: ToolSet` (npm-distributed/inline connectors; loads even without `connectorId`; folder tools win per name).
- Abstract (execute-less) tools are hidden from the model on plain `streamHarness`/`generateHarness`/CLI runs too, each emitting a `{ code: "policy_warning", metadata: { reason: "abstract-tool-hidden", tool } }` warning. `bash`/runtime tools are unaffected.
- Do not put web/json-render/React presentation-only renderers in connector `tools/`; keep renderers under `ui/` or connector renderer folders. `connectors/web-rich/renderers/` is a naming convention with no runtime behavior.
- Portable connector sessions record active/passive/mirror/disabled endpoints in `/session/.harness/connectors.json`. First-class mirroring: both surfaces return the same session id, the taking-over run passes `delivery: { previousActive: "mirror" }`, and the mirror target declares a descriptor `deliver`. Explicit `delivery.deliverers[connectorId]` wins over descriptor `deliver`. Mirror delivery is successful-post-run text delivery, not live multi-surface streaming. For manual control use `attachSessionConnector`/`detachSessionConnector`/`setSessionConnectorDelivery` with `chatSdkEndpointId`/`webRichEndpointId` to build endpoint ids. Registry reads/writes are serialized only within one runtime process; multi-instance/serverless hosts need host-level locking or compare-and-swap around shared session files.
- Deploying to serverless: connector modules load via dynamic import, so set `serverExternalPackages` (little-harness, chat, adapters) and `outputFileTracingIncludes` per connector route in `next.config.ts`. Passing a statically imported descriptor object + `connectorId` + descriptor `tools` skips the dynamic connector import: this combination tolerates a missing `connectors/<id>/` folder (folder-tool discovery returns `{}` instead of throwing `Connector not found.`), so no connector files need to exist on disk — but `loadHarness` still reads the agent folder (`agent.ts`/tools/skills/instructions) from `agentDir`, so those files still need `outputFileTracingIncludes` unless you supply a custom `loadHarness`. On web-rich, pass `waitUntil` so `afterRun`/mirror delivery survive.
- Email: `emailConnector({ address, adapter, state, senders })` is a `chat-sdk` descriptor (Resend via `@resend/chat-sdk-adapter`; route receives the `email.received` webhook). `senders` is required (`{ allow: ["a@x.com", "@x.com"] | "anyone", requireDmarc? (default true), authServId? }`); while `requireDmarc` is on, `authServId` (the receiving server's `Authentication-Results` id) is required or `emailConnector` throws, and only that server's headers count (folded headers unfolded, each read on its own). A `From` that is not exactly one address, or that the adapter reads as a different address, is refused as `sender-not-allowed`. Unverified in this alpha: no real email has been received through Resend Inbound yet, and whether Resend adds `Authentication-Results` (and its authserv-id) is unconfirmed; find the id by logging a refused test email's `email.headerValues["authentication-results"]` from `onSkip`. The policy runs in an adapter wrapper **below** the Chat SDK, so refused mail (`automated`, `not-addressed`, `sender-not-allowed`, `dmarc-not-passed`, `other-sender` (Reply-All into a thread someone else started), `reply-limit`, `duplicate`, `rejected` via `accept`) never reaches history; `onSkip` observes it. Default `transform` strips quoted replies/signatures and saves the original to `/session/email/<id>.txt`; an email with no text gives the agent its subject. One session per email thread (`email:<sha16>`), replies go to the sender only with `Auto-Submitted: auto-replied`, an empty reply sends nothing, typing is a no-op. Needs durable state (thread map, history, dedupe, reply counts). Set `runtime: { bash: false }` on agents that read email (the connector warns otherwise). `simulateInbound` skips the email policy; test it with signed webhooks + stubbed `fetch` (demo `src/app/api/email/email-route.test.ts`).
- Test Chat SDK connectors offline: `loadChatSdkConnector({ ..., createChat: createTestChat() })`, then `connector.simulateInbound({ thread, message })` with `createTestThread`/`createTestMessage` from `@little-stack/harness/connectors/runtime`. `simulateInbound` runs the full pipeline and bypasses the enabled-trigger check.
- CLI: `little-harness test <agent> --connector <id>` loads a connector's toolset into the REPL; `little-harness connectors <agent>` lists discovered connectors and skipped candidates; `little-harness outcomes [session-id]` aggregates `outcome.reported` events. Inspection commands (`sessions`, `trace`, `files`, `artifacts`, `diff`, `doctor`, `outcomes`) are read-only; `test` runs the model; `start`, `dev` and `schedules run` run it too.
- For custom web tool rendering, import types from individual tool modules and use `ToolOutputPart<"tool-name", typeof import("../tools/name").default>`.
- When bash and JavaScript are enabled, configured tools are also exposed inside `js-exec` through the Runtime Tool Bridge as `tools.<name>(args)`. Use this for batched or programmatically assembled tool calls; events use `caller: "runtime"`.
- Disable runtime bridge exposure with `runtime: { toolBridge: false }`, or by disabling `javascript`/`bash`. It is not advertised when per-call `activeTools` or `prepareStep` hides `bash`.
- Memory: each memory is a Persistent Dir of plain files; each layer in `memory: [...]` needs its own `harnessDir`, not inside another (throws). Every turn the prompt gets a `# Memory` section: per mount its path, `description`, whether this turn may change it, `instructions`, and one line per file (frontmatter `description`, else the start of the text, 600 characters; hidden files skipped; bounded by `maxIndexBytes`, with a `policy_warning` `reason: "memory_index_truncated"` when files don't fit). `canWrite({ extraBody })` is a generic `PersistentDir` option: false mounts the dir read-only for the turn (sandbox and `session.files` refuse writes), skips `store`, and the note says read-only. `backend: { load, store? }` replaces `sourceDir` (exactly one): `store` gets plain file changes (`created`, `updated`, `deleted` = forgotten). The built-in `memory` skill (`src/memory/skill.ts`) is added when any memory has `skill` not `false` and no skill named `memory` exists. With `runtime.bash === false` the turn adds `load_skill` (any skills) and `list_files`/`read_file`/`write_file`/`delete_file` scoped to memory folders; a user tool with those names throws in `createHarness`. Only agent turns see memory; workflow steps do not.
- `streamHarness` returns a UI message stream that can be consumed once; await `finished` for trace, artifacts, persistence, and warnings. AI SDK error chunks fail the turn: `text`, `output`, and `finished` reject, partial text may have streamed, and after-turn Persistent Dir commits are skipped.
- Directory skills must have `SKILL.md` frontmatter with `name` and `description`.
- Dynamic workflows (`dynamicWorkflows`) are opt-in and injected via `dynamicWorkflows()` from `@little-stack/workflow` — a bare `true` cannot work because `@little-stack/harness` cannot import the lowering factory (circular dep). `createHarness` throws a clear error on a malformed value.
- Core invariant: a one-shot plan can never reference a capability outside the agent's own configured snapshot (tools, MCP, bash). Out-of-snapshot references fail at submit with `capability_not_allowed`; recall re-validates against the *current* snapshot. **The agent decides a plan's tools by authoring the steps** — that is the access decision, not per-call `activeTools` (a routing concern that does not restrict plans). For a developer-controlled ceiling use `dynamicWorkflows({ exclude })` or a narrower harness.
- v1 plans support only `tool.call` and `ai.generate` steps; `code.run`/`parallel`/`decision` are rejected at submit. `output.from` must name the plan's terminal step. Plans are frozen (canonical hash) and replay-proof, run **inline** (caps: `maxSteps` 8, `maxRuntimeMs` 120000, validated positive integers), and are never added to the workflow library.
- A plan's `ai.generate` step is one model call with no tools or bash: the default workflow harness offers it none, even when the agent's snapshot has bash, so a plan reaches tools only through `tool.call` steps. Skills are not a plan capability in v1.
- On `virtualHost`, app workflow runs and `once()` records also use `dataFs` under `<dataRoot>/sessions/<pathKey>/workflows` and `once`; running/unrecorded once state is keyed by the filesystem object and record path. Unsaved records may be lost in a mid-turn restart and calls may run again; durability is inherited, with no process-crash exactly-once promise.
- Authored plans persist to `/persistent/dynamic-plans` (a registered persistentDir) and recall across harness instances sharing the host `dataDir` — same scoping as `memory`; isolate multi-user recall with per-user `dataDir`s. `search_authored_plans` returns the stored `outputSchema` so a plan is re-submittable verbatim.

## Common Mistakes

- Do not omit `host: localHost(...)` in local code.
- Do not use Little Harness directly for ordinary Little Workflow authoring; use `@little-stack/workflow`.
- Do not pass `dynamicWorkflows: true`; pass `dynamicWorkflows()` from `@little-stack/workflow`. Do not rely on `activeTools` to restrict what a one-shot plan may use, and do not document skills as a dynamic-plan capability (v1 supports tools/MCP/bash only).
- Do not implement Agent Groups as ordinary async tool tasks, let the model request raw capabilities, expose
  child transcripts, or treat a generic launcher exception as proof of rejection. Do not accept unversioned
  or stale observation snapshots, bare verification booleans, reused external group refs, or conflicting
  same-revision join reductions. Do not enable only part of the page trio, trust caller sequences or forgeable
  cursors, re-run join/cancel while continuing pages, or reconstruct all members during a steady-state page.
- Do not update package docs without checking whether `apps/little-harness-doc/content/docs/v0.1.0-alpha/` needs the same change.
- Do not pass a raw `defineWorkflow(...)` result to `createHarness({ workflows })`; wrap it with `asHarnessWorkflow`. Do not claim the workflow tool returns the typed output.
- Do not call just-bash (Tier-0) a security boundary or recommend `"in-process"` for model-authored code; do not say `localHost()` defaults to in-process.
- Do not show `createHarness({ stopWhen })`; `stopWhen` is a per-call option.
- Do not write install commands without `@alpha`, `ai@^7`, and a Node 22+ note during the alpha; do not tell users to `npm install @little-stack/littledb` (it is unpublished — preview only).
- `trace.content.previewBytes` is a legacy option name bounding UTF-16 code units (default 512), with a dangling high surrogate dropped at the boundary. It is not a UTF-8 storage quota or a full-content guarantee; file/artifact caps and byte/hash metadata remain true bytes.
- A host's `FileWriter.limits.maxFileBytes` describes an existing ceiling. Over-limit optional trace copies are marked `captured:false`/`storage_limit` without writing an artifact; do not raise a required storage limit or treat that reference's preview as complete content.
- Do not tell the model to read author-source `./skills/...` paths inside the harness. Prompt-visible bodies are under `.agents/skills/<name>/SKILL.md`.
- Do not use GitHub/GitLab shorthand skill sources. `skill(...)` accepts local paths, local markdown files, inline files, or explicit Git URLs.
- Do not register user tools named `bash`, `constructor`, `prototype`, or `__proto__`.
- Do not give two memory layers the default `/persistent/memory`; name each `harnessDir`. Do not put folder paths or who-may-write rules in a custom `memory` skill; the per-turn note carries them. Do not take the role `canWrite` checks from what the user typed; set `extraBody` from your own sign-in. Do not fall back to `"unknown"` in a per-user `sourceDir` function; validate the id and throw when it is missing (Local Host rejects a function result that is absolute, has `..`, or leaves `dataDir`).
- Do not import or configure MCP clients directly for declarative Harness MCP; only use `@ai-sdk/mcp` when documenting a manual client-lifetime path.
- Do not assume an undefined `type` fails. It runs and returns an `undefined_input_type` warning.
- Do not rely on trace files for secrets unless redaction settings cover the sensitive paths/metadata.

## Identified caller delivery

For dedicated API-owned sessions, use caller-mode scoped dispatch paths (`messages`, `resume`,
`stop`, `turn`, `staged/:messageId` under `/sessions/:s/dispatches/:d/`). Never fall back on404 to
legacy Stop/staging. Opt-in pins session mode; legacy-only sessions cannot convert. Reject-busy
requires exact prior-target cancellation before another logical dispatch. Keep immutable caller
resume/message IDs, readable durable replay logs, concrete model handles and fail-closed provider
and tool invocation hooks. `model.called` is pre-provider: staged input stays claimed/unknown
until durable response proof; never infer unread. End updates must compare the concrete run ID.
Reference: `packages/little-harness/docs/contracts/dispatch-delivery.md`.
