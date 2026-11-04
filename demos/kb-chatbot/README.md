# kb-chatbot — a self-improving knowledge-base chatbot

A company knowledge-base assistant built on **little-harness** + **LittleDB**. Users add
documents on the fly by attaching them to a chat message, answers cite the knowledge base,
👍/👎 reactions become scores on the turns they grade, and LittleDB's reviewer turns the
traces and their scores into a proposed better prompt.

It was the repo's **first harness + LittleDB integration**, so a fair amount of this README is
about where the two meet and where they do not.

```
        ┌──────────────────────────────────────────────────────────────┐
        │  chat surface (Slack connector / simulateInbound)            │
        │    message ──► attachments ──► chat.stageMessage             │
        │    reply    ◄── streamHarness                                │
        │    👍 / 👎  ──► outcome.reported                             │
        └───────┬───────────────────────────────┬──────────────────────┘
                │                               │
   per-session  │ system + model + onEvent      │ reactions.sinks
   version      │                               │
                ▼                               ▼
        ┌───────────────┐               ┌──────────────────────────┐
        │  harness run  │── traces ────►│  LittleDB  :7340         │
        │  bash, KB,    │── scores ────►│  traces, scores          │
        │  kb_ingest_   │               │  reviewer ──► proposal   │
        │  file workflow│◄── resolve ───│  approve ──► live version│
        └───────┬───────┘               └──────────────────────────┘
                │ after-turn commit
                ▼
        ┌───────────────┐
        │ knowledge/    │   a NEW session resolves the approved
        │ (shared KB)   │   version and runs the improved prompt
        └───────────────┘
```

## Layout

```
demos/kb-chatbot/
  driver.mjs                              offline PASS/FAIL driver + --ask + --loop
  loop.mjs                                the LittleDB loop (unverified — needs a server with a reviewer key)
  seed-knowledge/                         3 sample company docs, tracked
  knowledge/                              the LIVE knowledge base (gitignored, seeded on first run)
  agents/librarian/
    agent.ts                              createHarness: host, model, persistentDirs, chat.stageMessage
    instructions.md                       system prompt AND LittleDB bootstrap prompt
    env.ts                                DeepSeek model + slot map + demo paths
    knowledge.ts                          seed → live KB copy
    littledb.ts                           resolve per session, tracer, reactions as scores
    load.ts                               the connector loader that applies the session's version
    workflows/ingest-file.ts              defineWorkflow → asHarnessWorkflow (summarize + catalog line)
    connectors/slack/connector.ts         chatSdkConnector descriptor
```

## Running it

```bash
# from the repo root, once:
pnpm install
pnpm --filter @little-stack/harness build
pnpm --filter @little-stack/workflow build
pnpm --filter @little-stack/littledb build

export DEEPSEEK_API_KEY=...          # or put it in a .env.local at the repo root

# offline: no LittleDB, scripted conversation, PASS/FAIL per step
pnpm --filter kb-chatbot demo

# interactive REPL against the same agent folder
pnpm --filter kb-chatbot harness:chat

# the full LittleDB loop (needs a server — see below)
pnpm --filter kb-chatbot demo:loop
```

### Offline mode (the default)

`node driver.mjs` runs entirely without LittleDB. It drives the *same* `run()` pipeline a
real Slack message would, through `simulateInbound`, and checks observable effects rather
than prose:

1. **Ask a question the seed KB answers** — expects the 20-day accrual and a
   `Source: vacation-policy.md` citation.
2. **Upload a document** (a `data`-backed attachment, so no network) — expects the file to
   be **committed into `knowledge/`** by the model's own `cp`, and a new line in
   `catalog.md`. The `kb_ingest_file` workflow runs inside the turn and its `outputSummary`
   is what the model quotes back.
3. **Ask a question only the new document answers, from a different thread** — proves the
   KB is shared across sessions, not per-thread.
4. **React 👍 and 👎** — expects `outcome.reported` on both sessions.
5. **`little-harness outcomes`** — prints the success rate with its sample size.

State is reset at the start of every run (`--keep-state` opts out), so the run is
idempotent — step 3 cannot pass because a previous run already ingested the file.

### LittleDB mode

Set `LITTLEDB_URL` and `LITTLEDB_API_KEY` and the same driver resolves a version per session,
traces every turn, and sends the reactions as scores. Nothing else changes:

```bash
# in the littledb checkout: API and web UI on :7340, and a key for local apps
pnpm dev

LITTLEDB_URL=http://127.0.0.1:7340 LITTLEDB_API_KEY=ldb_dev_local_key pnpm --filter kb-chatbot demo
```

| Variable | Default | Meaning |
|---|---|---|
| `LITTLEDB_URL` | *(unset)* | The LittleDB server. **Unset ⇒ LittleDB is entirely out of the loop.** |
| `LITTLEDB_API_KEY` | — | Required with `LITTLEDB_URL`. A project API key. |
| `LITTLEDB_HARNESS` | `kb-librarian` | Harness slug in LittleDB. |
| `LITTLEDB_CHANNEL` | `production` | Release channel. |
| `DEEPSEEK_API_KEY` | — | Required, for the Librarian. |
| `KB_CHATBOT_MODEL_SLOT` | `deepseek-v4-flash` | The bootstrap version's `model`. |
| `SLACK_SIGNING_SECRET` | *(unset)* | Set it and the connector uses the real Slack adapter. |

What lands in LittleDB:

- **Version 1** is the bootstrap `{ system, model }` the first resolve carries:
  `instructions.md` (or `LIBRARIAN_PROMPT_FILE`) and the model slot. A proposal can change
  either; a session runs the version it resolved, for its whole life.
- **One trace per turn**, filed under the session (`slack:<threadId>`) with the version id: the
  turn, each model call with its tokens and cost, each tool call.
- **A `user_feedback` score per reaction** (source `human`): 1 for 👍, 0 for 👎, on the turn's
  trace, one per rater per message. Changing a reaction replaces the score; removing it deletes
  the score.

`--loop` (`loop.mjs`) drives the whole cycle against a running server: the conversation with
LittleDB wired, `POST /v1/reviews` (LittleDB's built-in reviewer, which needs a model key in
LittleDB's own environment), approval of the proposal it makes, then a **fresh** session that
prints the version it resolved.

### What has actually been run

| Path | Status |
|---|---|
| Offline mode (`LITTLEDB_URL` unset) | **Verified** — 5/5, live DeepSeek. |
| LittleDB mode (resolve, tracer, reaction scores) | **Verified without a model** against a local LittleDB: resolve with the bootstrap, a traced turn on a stand-in model, a reaction as a `user_feedback` score, its retraction. |
| `--loop` against a real LittleDB | **Not run.** It needs a reviewer model key in LittleDB and a DeepSeek key here. |
| The real Slack webhook path | **Not run.** Needs `SLACK_SIGNING_SECRET` and a Slack app. |

## How the per-session version is wired

LittleDB resolves a version **per session** (the session id is the sticky key, so a session
in a trial stays on its side of it). `createHarness` builds **one** harness, so the version
cannot come from its static options.

It comes from the harness's **`turnOptions`** hook. `agents/librarian/littledb.ts` builds
`db.managedHarness({ slug, bootstrap, schema, models })`, and `agent.ts` passes its
`turnOptions` to `createHarness`. The hook runs at the start of every turn, after the session
is known: it resolves the session's version, returns that version's `system` and `model` for
this turn only, and adds the session's LittleDB tracer as an `onEvent` next to the harness's
own. Every way a turn starts (the Slack connector, `little-harness test`, the driver) goes
through it, so the connector needs nothing for LittleDB except the reaction sink.
`load.ts` only flushes traces at the end of each turn.

`LibrarianVersion` (a zod schema) is the shape of a version. LittleDB is told it, so it never
proposes a version the Librarian cannot run, and a version that does not match never runs.

## Sharp edges

- **A promotion reaches new sessions only.** A session keeps its version, so an open thread
  keeps the old prompt after an approval; only a new thread (a new session) sees it. `--loop`
  opens a fresh thread for exactly this reason. A **rollback** does reach open threads: each
  session checks its version every 30 seconds and moves off one that was rolled back.
- **A version with an unknown model slot does not run.** When a version names a slot
  `modelForSlot` in `env.ts` does not know, the session runs the bootstrap instead and the
  trace says so. Keep the slot map and the `model` enum in `LibrarianVersion` in sync.
- **Editing `instructions.md` does not change production straight away.** LittleDB keeps the
  live version and opens a "Changed in code" proposal for the edit, which ships like any
  other proposal.
- **When LittleDB is unreachable a session runs on the bootstrap** (or the last version it
  resolved), and says so in a warning. The turn still runs.
- **Reaction session ids must agree on both sides.** The run pipeline keys sessions
  `<adapter>:<threadId>`; so does the reaction handler. A custom `session` callback without
  a matching `reactions.session` puts scores on a session that has no trace, and the join is
  silently empty. This demo therefore uses the defaults on both sides.
- **The Slack adapter needs a signing secret at connector LOAD time.** `adapter.create()`
  runs before any message exists, so the descriptor branches on `SLACK_SIGNING_SECRET` and
  falls back to a credential-free stub under the same adapter name.
- **`createTestChat()` has no `onReaction`.** The shipped test double cannot exercise the
  reactions surface; `driver.mjs` subclasses it to add the one missing method.
- **Workflow event stores land in the process CWD, not the harness data dir.** An inline
  workflow receives `persistence.dataDir = "<sessionId>/workflows"`, a relative path that
  `localWorld` resolves against `process.cwd()`. The demo gitignores and cleans `slack:*/`
  for this reason.
- **Host writes into `/persistent` do not commit.** `chat.stageMessage` writes uploads into
  `/session/uploads` on purpose — only runtime/bash writes are tracked by the Persistent Dir
  and committed after the turn. The model moving the file is what publishes it.

## Customer app — Northwind Helpdesk

`customer-app/` is the customer-facing surface: a small web chat (`http://localhost:3100`)
that bridges onto the same chat-sdk connector the Slack path uses. Everything a customer
does there — asking, uploading a document, reacting 👍/👎 — flows through the real harness,
the real LittleDB tracer, and the real outcome sink. The developer console (LittleDB's web
UI, `:7340`) and this app are deliberately separate applications: customers never see
traces.

```bash
LITTLEDB_URL=http://127.0.0.1:7340 LITTLEDB_API_KEY=ldb_dev_local_key node customer-app/server.mjs
```
