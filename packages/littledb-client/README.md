# @little-stack/littledb

The LittleDB client for Little Harness and Little Workflow apps: one URL and one API key.

> `@little-stack/littledb` is published from `0.2.0-alpha.4`; it needs a LittleDB account. The LittleDB server is not open source. See [release status](https://little-stack.dev/docs/releases).

LittleDB is the product of the Little stack: tracing and self-improvement for agents. Little
Harness and Little Workflow are the SDK that feeds it, and this client is the connection: it
sends each Harness turn and Workflow run as a trace, forwards what users said, resolves which
version to run, and runs LittleDB's experiments inside your app, where the tools and model keys
are. Managed workspaces, part of LittleDB's hosted service, report each turn's tier and
infrastructure cost through the same traces (the `compute` field). See the [LittleDB guide](https://little-stack.dev/docs/littledb) for service details.

```ts
import { createLittleDB } from "@little-stack/littledb";

const db = createLittleDB({ url: process.env.LITTLEDB_URL!, apiKey: process.env.LITTLEDB_API_KEY! });
```

Nothing here puts LittleDB on your app's critical path. Traces and scores are queued and sent in
batches in the background (retried, bounded, never thrown). `resolve` is cached and falls back
to the last answer, then to the config in your code. Call `await db.shutdown()` before the
process exits so the queue is sent.

## Installation and commands

Install the client with `pnpm add @little-stack/littledb@alpha`.
For agent bundling, install `@little-stack/harness@alpha ai@^7` in your project;
add `@little-stack/workflow@alpha` when using workflows. Harness and Workflow are
optional peers so the tracing client and `littledb --help` work without them.
Node.js 22 or newer is required. `esbuild` compiles agent folders and `typescript`
reads their provenance, so both are runtime dependencies of the bundling command.

```sh
npx @little-stack/littledb@alpha --help
npx @little-stack/littledb@alpha login --url https://littledb.example.com --project my-project
npx @little-stack/littledb@alpha deploy agents --all --branch dev --dry-run
```

The client needs a LittleDB account; the server is not open source.
Installing this client does not install or deploy the server.

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

### Feedback on part of a reply

Import the browser helper separately; it has no Node dependencies. Keep the same `selection`
when changing or withdrawing an answer:

```ts
import { selectionIn } from "@little-stack/littledb/selection";

const selection = selectionIn(replyElement);
if (selection !== null) {
  const response = await fetch("/api/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messageId, selection, thumbs: "down", tags: ["factual"] }),
  });
  const result = await response.json(); // result.selection?.anchor
}
```

To withdraw it later, reuse the saved `selection`:

```ts
if (selection !== null) {
  await fetch("/api/feedback", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messageId, selection }),
  });
}
```

The helper reads text nodes in document order, skips `data-feedback-ignore` subtrees, and trims
padding while adjusting its UTF-16 `start`/`end` indexes. Collapsed, blank and outside ranges,
and quotes over 2,000 UTF-16 units after trimming, return `null`. Pass a `Range` as the second
argument to use a saved selection.
`textSelection(text, start, end)` works without a DOM; invalid indexes, blank passages and
quotes over 2,000 UTF-16 units throw `RangeError`.

From your server, send the same first-class fields:

```ts
import { feedbackId } from "@little-stack/littledb";

await db.feedback({
  traceId, userId: hashedUserId,
  id: feedbackId(hashedUserId, messageId, selection),
  selection, thumbs: "down", tags: ["factual"], expected: "The corrected passage.",
  role: signedInUser.role, // from your server's session
});
```

Each highlight has a stable id based on `quote`, `start`, `path` and `ref`; an omitted selection
keeps the existing whole-reply id. `selection` needs a `quote`, JSON-pointer `path`, or app-defined
`ref`; quote context (`prefix`/`suffix`) and offsets are optional. A selection alone is not a
feedback signal: include thumbs, a rating, a comment or survey answers too. Tags are up to 10
reason codes of 1–50 characters, trimmed and deduplicated; `expected` is up to 4,000 characters.

**Role comes from your server.** Return `{ userId, role }` from `authorize()`; the handler ignores
body `role` and always strips browser `metadata.role` and `metadata.correction`, even if the
server returns no role. Other metadata is kept. The project's `feedback.expertRoles` decides
which roles are experts; other users' `expected` remains feedback, not an automatic test item.
Trusted direct server callers can still use LittleDB's temporary legacy metadata fallback.

The result's `selection.anchor.status` is `exact` for a literal match, `loose` for a normalized
match, `position` for an offset match, `pending` while the target is incomplete, or terminal
`not_found` when a finished target has no match. Pending/unmatched quotes remain the user's
words, never verified agent output. Path/ref-only selections have no anchor. The local fakes
simulate only `exact` and `not_found`, not the engine's pending lifecycle or normalized matching.

The handler forwards `selection.anchor`, `stale` and `revision`: a stale POST is `200`, an applied
one `201`, and a conflicting revision `409`. Send `revision` on DELETE too, in its JSON body or
with `?id=...&revision=...`, to keep retries ordered. The browser sends its original message/id
and selection; the handler scopes them to the authorized user.

Selected quotes, context and expected text are stored content, like comments; treat them as
untrusted user data and avoid putting personal information in them.

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


## The `littledb` command

The scoped package name must be typed in full with `npx`; the unscoped name belongs to a different package. The `littledb` command ships in `@little-stack/littledb` from `0.2.0-alpha.4`.

```sh
npx @little-stack/workflow@alpha setup my-app --template node --littledb --yes --install --verify
cd my-app
npx @little-stack/littledb@alpha login --url https://<your-littledb> --project <slug>
npx @little-stack/littledb@alpha deploy agents --all --branch dev
echo "Say hello in one sentence." | npx @little-stack/littledb@alpha chat support --branch dev
```

`login` opens browser approval and saves the terminal key with mode 0600. Interrupted polling resumes with the same command. `login --key <management-key> --project <slug>` supports scripts; prefer `LITTLEDB_MANAGEMENT_KEY` for CI so secrets do not enter shell history. `logout` removes `config.json`, `login-pending.json`, and the legacy `agents.json` sign-in in `~/.config/littledb`, and names those deletions in its output. It does not revoke keys; revoke them in LittleDB Settings. `whoami` shows the address, organization, project and scopes, never the key.

Commands retain the agent tool's arguments:

- `build [folder] [--out file]`, `deploy [folder] [--all --branch name] [--dry-run]`.
- `agents`, `status <agent>`, `versions <agent> [--branch name]`, `history <agent>`.
- `promote <agent> <branch|vN> [--to branch]`, `rollback <agent> [--branch name] [--to vN]`, `production <agent> <branch>`, `branch delete <agent> <branch>`, `url <agent> [--branch name]`.
- `chat <agent|url> [--branch name]` reads a piped message or opens an interactive terminal.
- `secrets set|list|rm` accepts an agent and name, or a name with `--all-agents`; secret values are read from stdin only.
- `users` configures access or lists, exports and deletes end-user data; `origins` configures allowed website origins.
- `models` lists, adds, removes and selects models.
- `schedules`, `credits`, `limits`, `retention`, `webhooks`, `email` and `user-secret` manage developer settings.

`--url`, `LITTLEDB_URL`, or the saved `~/.config/littledb/config.json` names LittleDB, not its agents service. The service address is discovered automatically; `LITTLEDB_AGENTS_URL` overrides it. CI may use `LITTLEDB_URL`, `LITTLEDB_MANAGEMENT_KEY` and `LITTLEDB_PROJECT` with no file. The legacy `~/.config/littledb/agents.json` remains readable. Without an agents service, the client library can still send runs.

Deployment output names the reporting organization/project and next chat/promote commands. `deploy --rotate-tracing-key` explicitly replaces the project's tracing key and invalidates its previous copy, potentially affecting another service. No rotation happens automatically. Demo-model starters warn that replies are canned.

The browser client and protocol are available as `@little-stack/littledb/agents/client` and `/agents/protocol`; Node bundling is `/agents/bundle`. The package root does not load esbuild or TypeScript. Operator commands `dev`, `admin`, `init` and `link` remain in the private `littledb-agents` executable.

The extra subpaths `/agents/cli`, `/agents/cli/git`, `/agents/bundle/plugins`,
`/agents/bundle/provenance` and `/agents/bundle/workspace` are internal integration
points for LittleDB’s own tool and may change without notice.
