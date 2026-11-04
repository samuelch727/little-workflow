# @little-stack/littledb

The LittleDB client for Little Harness and Little Workflow apps: one URL and one API key.

> **Not published yet.** The package is private while LittleDB itself is not public. The demos
> in this repository use it from the workspace.

LittleDB is the product of the Little stack: tracing and self-improvement for agents. Little
Harness and Little Workflow are the SDK that feeds it, and this client is the connection: it
sends each Harness turn and Workflow run as a trace, forwards what users said, resolves which
version to run, and runs LittleDB's experiments inside your app, where the tools and model keys
are. Managed workspaces, part of LittleDB's hosted service, report each turn's tier and
infrastructure cost through the same traces (the `compute` field). See LittleDB's
`docs/pricing.md` for what is charged for.

```ts
import { createLittleDB } from "@little-stack/littledb";

const db = createLittleDB({ url: process.env.LITTLEDB_URL!, apiKey: process.env.LITTLEDB_API_KEY! });
```

Nothing here puts LittleDB on your app's critical path. Traces and scores are queued and sent in
batches in the background (retried, bounded, never thrown). `resolve` is cached and falls back
to the last answer, then to the config in your code. Call `await db.shutdown()` before the
process exits so the queue is sent.

## Resolve: which version to run

```ts
const resolution = await db.resolve({
  kind: "harness",
  slug: "support-desk",
  stickyKey: sessionId, // the same session always gets the same side of a trial
  bootstrap: { system: SYSTEM_PROMPT, model: "fast" }, // becomes version 1 when nothing is live
});
// resolution.content is what to run; resolution.versionId goes on the traces.
```

`resolution.mode` is `live`, `trial` (this key is in a trial of a candidate) or `none`.
`resolution.fallback` is set when LittleDB could not answer: `last_known` or `bootstrap`.

### Let LittleDB hold the model

A harness's model can live in LittleDB instead of your code: each version may name one as
`provider/model` (`deepseek/deepseek-flash`), and `resolution.model` says which runs (the
version's, the agent's setting, or the project's default) and who pays (`key`: your provider key,
no fee; `credits`: LittleDB credits through its model gateway). Switching models is then a new
version, tested like any fix, with no redeploy.

```ts
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createModelResolver } from "@little-stack/littledb/models";

const support = db.managedHarness({
  slug: "support-desk",
  bootstrap: { system: SYSTEM_PROMPT }, // no model in code
  resolveModel: createModelResolver({ providers: { deepseek: createDeepSeek } }), // keys from process.env
});
const harness = createHarness({ host, turnOptions: support.turnOptions }); // no model here either
```

A model paid with your key and no key set fails the turn naming the variable (`DEEPSEEK_API_KEY`);
it never falls back to credits. A slot from `models` still wins over LittleDB's model.

A parked turn keeps the model decision it started with, including the `provider/model` id,
`paidBy` and source. On continuation, `resolveModel` reconstructs that model from the saved
decision without asking LittleDB for the latest version or project model. Promotions, fresh
clients and another park do not change it. Keep `resolveModel` configured when resuming a turn
that used it; a missing resolver or invalid saved descriptor fails the turn. A new pin also
records when no resolved model was used, so adding a resolver later does not replace its code
model or named slot. Older named-slot pins remain usable; an older prompt-only pin without a
saved model decision cannot safely resume through `resolveModel` and is refused.

## Trace a harness

When Harness marks an optional copy `captured: false` because of a declared storage limit,
the tracer emits `{ unavailable: true, reason: "storage_limit", ... }` instead of its preview.
Only metadata attributes carry that preview. A later known segment cannot make the omitted
part of the same turn complete. This covers known storage-limit omissions; it does not load
ordinary captured artifact references or qualify partial captured previews as full evidence.
Evidence consumers must apply their own missing-content admission rules.

```ts
const tracer = db.harnessTracer({ harness: "support-desk", resolution, userId });
const agent = createHarness({
  model,
  system: resolution.content.system,
  onEvent: tracer.onEvent,
  // Harness previews default to 512 UTF-16 code units; previewBytes is the legacy option name.
  trace: { content: { previewBytes: 65_536 } },
});
await generateHarness({ harness: agent, session: sessionId, prompt });
db.score({ traceId: tracer.traceIdFor(sessionId)!, name: "task_success", value: 1 });
```

Each turn is a trace: a root `turn` span with the user message and the answer, an `llm` span
per model call (prompt, response, token usage with cache reads and writes split out, so
LittleDB can price it) and a `tool` span per tool call. The trace also carries `compute`: the
execution tier the turn reached (`tier-0`, the emulated shell over the session folder, or
`next-tier`, a real execution environment), the provider, the time commands were running and
what the sandbox said it cost, from the harness's `harness.runtime.usage` event; LittleDB
measures the Tier 0 share and the infrastructure cost per turn from it. Pass `traceId` to put
every turn of a session in one trace instead, each turn a child of a root span; an eval worker
does this. `captureContent: false` sends only structure and numbers.

### A session, start to finish

The turn's trace says how the turn started: `trigger` (`{ kind, source?, from?, label? }`) comes
from the harness's `trigger` option, which the schedules runner, the chat and email connectors,
the agent server and the REPL set for you (`{ kind: "message", source: "whatsapp", from }`,
`{ kind: "schedule", source: "<schedule id>" }`). A workflow run that a tool call started (an
`asHarnessWorkflow` tool, or an agent-made workflow or one-shot plan) is its own trace with
`trigger: { kind: "harness", sessionId, turnId, toolCallId }`, the turn's session, and
`parentTraceId` / `parentSpanId` pointing at the turn's trace and that tool call's span. A sub-run
points at its parent run's trace (`trigger: { kind: "workflow", runId }`). Use one `createLittleDB`
client for the tracer and the tracing World, so the run finds a turn trace id you set with
`traceIdFor`.

## User feedback

What users say about a turn (a thumbs up or down on a message, a rating, a comment, a survey)
goes to LittleDB as scores with source `user`, next to your judges' scores. LittleDB's reviewer
reads the complaints, and trials and the release watch hold back or roll back a version users
are clearly less happy with (`policy.feedback`). There are three ways in.

**From your backend**, with the turn's trace id:

```ts
import { feedbackId } from "@little-stack/littledb";

await db.feedback({
  traceId, // the turn the message came from (below)
  userId: hashedUserId, // pseudonymous, never an email
  id: feedbackId(hashedUserId, messageId), // send again to change the answer
  thumbs: "down",
  comment: "Didn't say when I'd get my money",
});

// An end-of-conversation survey: no trace id, the session's latest turn.
await db.feedback({
  sessionId,
  userId: hashedUserId,
  id: feedbackId(hashedUserId, `survey:${sessionId}`),
  survey: "csat-v1",
  answers: [
    { question: "resolved", value: true },
    { question: "ease", value: 4, scale: 5 },
    { question: "reason", choice: "too slow" },
    { question: "anything_else", text: "..." },
  ],
});

await db.retractFeedback(feedbackId(hashedUserId, messageId)); // the user took it back
```

`feedback` is sent at once, not queued, and throws `LittleDBError` (or `TypeError` for feedback
it can tell is invalid: it needs `traceId` or `sessionId`, and thumbs, a rating, a comment or
answers). A rating runs from 1 to `scale` (2..10, default 5); a comment is at most 4000
characters. The key needs the `feedback` scope (least privilege) or `ingest`.

**The turn's trace id.** Right after a turn, `tracer.traceIdFor(sessionId)` is its trace; keep it
with the message you show (in the AI SDK, in the message's `metadata`). From a turn id, which
every harness event carries, `tracer.traceIdForTurn(sessionId, turnId)` gives the same id
(`turnTraceId(sessionId, turnId)` unless you gave the tracer `traceIdFor` or `traceId`). With
neither, send `sessionId`.

**From the browser**, through a route on your own backend, so the browser never sees the key:

```ts
// app/api/feedback/route.ts (Next.js); any framework that speaks Request/Response works.
const handler = db.feedbackHandler({
  // Your session check. null answers 401. This userId is stored; one in the body is ignored.
  authorize: async (request) => {
    const user = await currentUser(request);
    return user === undefined ? null : { userId: hash(user.id) };
  },
  // Optional: the browser sends your message id; you name the turn (and check it is theirs).
  resolveTrace: async ({ messageId, sessionId }, { userId }) =>
    messageId !== undefined ? await traceOfMessage(messageId, userId) : sessionId === undefined ? null : { sessionId },
});
export { handler as POST, handler as DELETE };
```

```ts
// In the browser:
await fetch("/api/feedback", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ messageId: message.id, thumbs: "up" }),
});
await fetch(`/api/feedback?id=${encodeURIComponent(message.id)}`, { method: "DELETE" });
```

The handler takes the same fields as `db.feedback` plus `messageId`. It answers 401 without a
user, 415 without a JSON content type, 413 over 16 KiB (`maxBodyBytes`), 400 for invalid
feedback and 404 when `resolveTrace` returns nothing. Ids are scoped to the user: an `id` (which
defaults to `messageId`) is sent as `feedbackId(userId, id)`, so one user cannot replace or
withdraw another's answers, and your backend can rebuild the same id. LittleDB's own errors are
answered with a short message of the handler's own (details go to `onError`).

**Chat reactions and harness outcomes**, with no code of your own: give the outcome sink to a
Chat SDK connector's reactions, or to `reportHarnessOutcome` / `createHarnessOutcomeReporter`:

```ts
chatSdkConnector({ /* ... */ reactions: { sinks: [db.outcomeSink({ tracer })] } });
await reportHarnessOutcome({ session, status: "failure", detail: "Wrong refund amount.", sinks: [db.outcomeSink({ tracer })] });
```

| Outcome | Feedback |
| --- | --- |
| `success` / `failure` | thumbs up / down |
| `partial` | a rating of 3 out of 5 (0.5) |
| `score` between 0 and 1 | a rating on 1..5 instead (the exact score stays in `metadata.outcome.score`) |
| `detail` | the comment |
| `reporter` | the user id (reactions use `anon_<16 hex>`) |
| `reportKey` | the stable id: a changed reaction replaces the earlier one |
| `retracted: true` | withdraws it, unless the same person has since reacted the other way |
| `turnId` | the trace the tracer wrote for that turn; with no turn, the session's latest trace |

Every outcome goes under one score name, `thumbs` (`feedbackName` to change it), so a stream of
outcomes is one signal. Pass the `tracer` that traced the sessions so its trace ids are used. The
sink never throws: a failure goes to `onError` and is counted by the harness as a failed sink.

User ids should be pseudonymous (LittleDB stores them with each score). Comments are stored as
text and shown to LittleDB's reviewer as untrusted data, never as instructions.

## Trace a workflow

```ts
import { localWorld, runWorkflow } from "@little-stack/workflow";

const world = db.tracingWorld(localWorld({ dataDir }), { workflow: "lending.preapproval", versionId });
await runWorkflow(preapproval, input, { world });
```

The wrapper is still the inner World (reads, artifacts and recovery go to it); it also sends
each run as a trace: the run is the root span, each step attempt a child, and model and tool
calls sit under the step that made them. A model call's span holds the step's resolved prompt.
Pass `runWorkflow(..., { trigger: { kind: "webhook", source: "stripe" } })` to record how a run
started; `sessionId` on the World is only an override of the session a harness tool call gives.

### Let LittleDB improve a workflow

Keep each step's prompt and model slot in the version's content and build the plan from it.
LittleDB's reviewer can then change one step's prompt or model, and the change is judged as a
prompt or model change (medium or low risk) rather than a new workflow:

```ts
const bootstrap = {
  steps: {
    classify: { model: "fast", prompt: "Classify this message: {{ input.message }}" },
    reply: { model: "fast", prompt: "Reply to the customer. Category: {{ steps.classify.output }}" },
  },
};
const resolution = await db.resolve({ kind: "workflow", slug: "support.triage", bootstrap });
const config = resolution.content as typeof bootstrap;
const triage = defineWorkflow({
  id: "support.triage",
  models: [model(haiku, { id: "fast" })],
  plan: {
    steps: [
      { id: "classify", uses: "ai.generate", with: config.steps.classify, output: { mode: "choice", values: ["refund", "other"] } },
      { id: "reply", uses: "ai.generate", needs: ["classify"], with: config.steps.reply, output: { mode: "text" } },
    ],
  },
  // input, output...
});
const world = db.tracingWorld(localWorld({ dataDir }), { workflow: "support.triage", resolution });
const result = await runWorkflow(triage, input, { world });
db.score({ traceId: runTraceId(result.runId), name: "resolved", value: 1 });
```

Adding, removing or rewiring steps, or changing a schema or tool, stays a workflow change (high
risk), which waits for a person by default.

## Agent-made workflows behind review

With `dynamicWorkflows`, an agent can turn recurring work into a workflow with
`define_workflow`. Give it a LittleDB registry and every definition becomes a draft version
with a proposal in LittleDB. A turn offers only approved (live) versions, plus the drafts the
session made itself (`ownDrafts: false` turns that off).

```ts
import { dynamicWorkflows, localWorld } from "@little-stack/workflow";

createHarness({
  // ...
  dynamicWorkflows: dynamicWorkflows({
    registry: db.agentWorkflowRegistry({ harness: "support-desk" }),
    world: (run) =>
      db.tracingWorld(localWorld({ dataDir: run.dataDir }), {
        workflow: run.handle,
        origin: run.kind === "defined" ? "agent" : "planner",
        harness: "support-desk",
        versionId: (run.metadata?.littledb as { versionId?: string } | undefined)?.versionId,
      }),
  }),
});
```

When LittleDB cannot be reached, the registry offers the last list it fetched; with none,
only the session's own definitions (`offline: "stored"` offers every stored one instead).

## Run experiments in your app

LittleDB plans experiments (a candidate version against a dataset); your app runs them, since
it owns the tools and the model keys:

```ts
const worker = db.evalWorker({
  subjects: ["harness:support-desk"],
  concurrency: 2,
  run: async (run) => {
    const tracer = db.harnessTracer({ harness: "support-desk", ...run.trace });
    const answer = await runMyAgent(run.version!.content, run.item!.input, tracer.onEvent);
    return { output: answer, scores: [{ name: "task_success", value: grade(answer, run.item!.expected) }] };
  },
});
await worker.start(); // until worker.stop(); or worker.runOnce() in a script
```

A worker heartbeats its claims, flushes each run's trace before completing it, and completes a
run that threw with its error so LittleDB can retry it.

For a workflow, `workflowEvalWorker` does the wiring: it claims that workflow's runs, wraps your
World with the tracing World (tagged with the run's trace, version, experiment and item), and
grades what your `run` returns:

```ts
const worker = db.workflowEvalWorker({
  workflow: "support.triage",
  world: () => localWorld({ dataDir }),
  run: ({ content, input, world }) => runWorkflow(buildTriage(content), input, { world }),
  grade: ({ output, expected }) => [{ name: "correct", value: sameDecision(output, expected) ? 1 : 0 }],
});
await worker.start();
```

A run that throws (a failed workflow throws `RunFailedError`) is completed with its error and
not graded.

## Everything else

`db.request(method, path, body)` calls any other `/v1` endpoint (datasets, experiments,
proposals) and throws `LittleDBError` (`status`, `code`, `retryable`). `db.ingest(batch)` queues
raw traces, spans and scores; `db.flush()` sends the queue now; `db.stats()` counts what was
queued, sent and dropped. `onError` hears about problems off the app's path (by default a
`console.warn`, once a minute per kind).

Prefer OpenTelemetry? LittleDB also takes OTLP/HTTP traces (JSON or protobuf) at `POST /v1/otlp/v1/traces` with the
same API key.

## Entry points

- `.` — `createLittleDB`, `feedbackId` and their types.
- `./harness` — `createHarnessTracer`, `createAgentWorkflowRegistry` and `createOutcomeSink`, for hosts that wire the transport themselves.
- `./workflow` — `createTracingWorld` and `createWorkflowEvalWorker`.
- `./models` — `createModelResolver`: LittleDB's model for a harness as a model object, on your key or on credits.
- `./contract` — the `/v1` wire contract as Zod schemas.

The package has no runtime dependency on the harness or workflow packages: it reads their
events and Worlds structurally.

## Tests

`pnpm test` runs against an in-memory LittleDB. `src/live.test.ts` runs against a real server
when one answers at `LITTLEDB_TEST_URL` (default `http://127.0.0.1:7340`, key
`LITTLEDB_TEST_API_KEY`, default `ldb_dev_local_key`).
