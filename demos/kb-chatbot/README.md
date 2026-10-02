# kb-chatbot — a self-improving knowledge-base chatbot

A company knowledge-base assistant built on **little-harness** + **littleDB**. Users add
documents on the fly by attaching them to a chat message, answers cite the knowledge base,
👍/👎 reactions become run outcomes, and littleDB's dreaming turns those outcomes into a
better prompt.

It is also the repo's **first harness + littleDB integration**, so a fair amount of this
README is about where the two SDKs meet and where they do not.

```
        ┌──────────────────────────────────────────────────────────────┐
        │  chat surface (Slack connector / simulateInbound)            │
        │    message ──► attachments ──► chat.stageMessage             │
        │    reply    ◄── streamHarness                                │
        │    👍 / 👎  ──► outcome.reported                             │
        └───────┬───────────────────────────────┬──────────────────────┘
                │                               │
   per-session  │ system + model + onEvent      │ reactions.sinks
   managed      │                               │
   config       ▼                               ▼
        ┌───────────────┐               ┌────────────────┐
        │  harness run  │──── traces ──►│  littleDB      │
        │  bash, KB,    │               │  engine :7878  │
        │  kb_ingest_   │               └───────┬────────┘
        │  file workflow│                       │ judge pass
        └───────┬───────┘                       ▼
                │                       ┌────────────────┐
                │ after-turn commit     │  control plane │
                ▼                       │  :3000         │
        ┌───────────────┐               │  dream ──► proposal
        │ knowledge/    │◄──────────────│  canary ──► promote
        │ (shared KB)   │  prompt that  └───────┬────────┘
        └───────────────┘  produced it          │
                                                ▼
                                 a NEW session resolves the promoted
                                 config and runs the improved prompt
```

## Layout

```
demos/kb-chatbot/
  driver.mjs                              offline PASS/FAIL driver + --ask + --loop
  loop.mjs                                the littleDB loop (unverified — needs the stack)
  seed-knowledge/                         3 sample company docs, tracked
  knowledge/                              the LIVE knowledge base (gitignored, seeded on first run)
  agents/librarian/
    agent.ts                              createHarness: host, model, persistentDirs, chat.stageMessage
    instructions.md                       system prompt AND littleDB bootstrap prompt
    env.ts                                DeepSeek model + slot map + demo paths
    knowledge.ts                          seed → live KB copy
    littledb.ts                           managed config, per session
    load.ts                               the connector loader that injects per-session config
    workflows/ingest-file.ts              defineWorkflow → asHarnessWorkflow (summarize + catalog line)
    connectors/slack/connector.ts         chatSdkConnector descriptor
```

## Running it

```bash
# from the repo root, once:
pnpm install
pnpm --filter little-harness build
pnpm --filter little-workflow build
pnpm --filter @little-workflow/littledb build

export DEEPSEEK_API_KEY=...          # or put it in a .env.local at the repo root

# offline: no littleDB, scripted conversation, PASS/FAIL per step
pnpm --filter kb-chatbot demo

# interactive REPL against the same agent folder
pnpm --filter kb-chatbot harness:chat

# the full littleDB loop (needs the stack — see below)
pnpm --filter kb-chatbot demo:loop
```

### Offline mode (the default)

`node driver.mjs` runs entirely without littleDB. It drives the *same* `run()` pipeline a
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

### littleDB mode

Set `LITTLEDB_URL` and the same driver wires managed config, the trace reporter, and the
outcome sink. Nothing else changes:

```bash
LITTLEDB_URL=http://localhost:3000 \
LITTLEDB_ENGINE_URL=http://localhost:7878 \
pnpm --filter kb-chatbot demo
```

| Variable | Default | Meaning |
|---|---|---|
| `LITTLEDB_URL` | *(unset)* | Control plane. **Unset ⇒ littleDB is entirely out of the loop.** |
| `LITTLEDB_ENGINE_URL` | `http://localhost:7878` | Trace engine. |
| `LITTLEDB_HARNESS_ID` | `kb-librarian` | Harness slug in littleDB. |
| `LITTLEDB_CHANNEL` | `production` | Release channel. |
| `LITTLEDB_PROJECT_KEY` | *(unset)* | Cloud only; local mode sends no key. |
| `DEEPSEEK_API_KEY` | — | Required. Also required **inside littleDB** for dreaming. |
| `KB_CHATBOT_MODEL_SLOT` | `deepseek-v4-flash` | Bootstrap `modelSlot`. |
| `SLACK_SIGNING_SECRET` | *(unset)* | Set it and the connector uses the real Slack adapter. |

`--loop` (`loop.mjs`) drives the whole cycle against a running stack: the conversation with
littleDB wired, a wait for the registry sync tick and one judge pass, `POST
/api/harnesses/<slug>/dream`, then `canary` and `promote` on the proposal, then a **fresh**
session that prints the config version it pinned.

### What has actually been run

| Path | Status |
|---|---|
| Offline mode (`LITTLEDB_URL` unset) | **Verified** — 5/5, live DeepSeek. |
| littleDB mode (managed config, reporter, outcome sink) | **Verified against a stub control plane**: the managed prompt reached the model on every turn, the first `/api/config/resolve` carried `bootstrapConfig`, `onEvent` posted trace envelopes and eval-run uploads, and the sink posted both reactions on `harness_slack:<threadId>`. One resolve per session, as designed. |
| `--loop` against the real littleDB stack | **Not run.** Endpoints, payloads and timings are written from the littleDB source (`viewer/src/routes/api`, `viewer/src/server`), not measured. |
| The real Slack webhook path | **Not run.** Needs `SLACK_SIGNING_SECRET` and a Slack app. |

## How per-session managed config is wired

littleDB resolves config **once per session** and hands back
`{ harnessOptions: { system, model, skills }, reporter, configVersionId }`. But
`createHarness` builds **one** harness with static options, and `loadChatSdkConnector`
loads **one** agent folder. Neither is per-session.

The seam that makes it work is the third one: **`loadChatSdkConnector({ streamHarness })`**.
`StreamHarnessOptions extends HarnessAgentOptions`, and `resolveTurnConfig`
(`packages/little-harness/src/execution/stream-harness.ts:1030`) merges that call's `system`
and `model` over the harness config **for that run only**. `onEvent` rides the same options
object and is invoked *alongside* the harness-level one, not instead of it
(`stream-harness.ts:1180`).

That seam is **synchronous**, so the async `createSessionConfig` cannot happen inside it.
The connector's `beforeRun` — which the run pipeline awaits *before* calling `streamHarness`
(`connectors/chat-sdk.ts:811`) — resolves and caches it first; the wrapper only reads the
cache. See `agents/librarian/littledb.ts` and `agents/librarian/load.ts`.

**`skills` cannot be applied this way at all.** `skills` is on `CreateHarnessOptions` only,
not on `HarnessAgentOptions`, so a promoted bundle carrying skills resolves cleanly through
`bundleToHarnessOptions` and is then silently dropped. The demo logs a warning rather than
pretending otherwise.

## Sharp edges

- **A cold-cache control-plane outage fails the FIRST session hard.** `createSessionConfig`
  runs inside `beforeRun`, and `createConfigResolver`'s fallback rethrows when there is no
  cached bundle yet — so the connector's `run()` rejects and the turn dies. Only sessions
  after the first are protected by the `~/.littledb/config-cache` fallback.
- **The trace reporter re-uploads the whole eval run after EVERY event.**
  `createLittleDbHarnessReporter.onEvent` calls `uploadEval` per event
  (`packages/littledb-client/src/harness/reporter.ts:76`), and the payload carries the full
  replay transcript plus base64 file snapshots. The stub run recorded 87 trace envelopes and
  **91 full eval-run uploads** for one three-turn conversation.
- **The config cache location is not configurable from `littledb()`.** `LittleDbOptions`
  accepts a `cache`, but there is no env or path knob, so the default writes into
  `~/.littledb/config-cache` — outside the project, shared across every demo on the machine.
- **Config pickup is next-session-only.** A resolved bundle is pinned for the session's
  lifetime. An open thread keeps the old prompt forever; only a new thread (a new session)
  sees a promotion. `--loop` opens a fresh thread for exactly this reason.
- **A promoted model-swap with an unresolvable slot throws at session creation.**
  `bundleToHarnessOptions` throws `could not resolve model slot "<x>"` when `modelFor`
  returns `undefined`, and that happens inside `beforeRun` — i.e. it fails the turn. Keep
  `modelForSlot` in `env.ts` in sync with every slot anyone can promote.
- **The judge scans the newest 50 completed runs engine-wide, per pass.** Coverage is
  scoped, not eventual: on a busy engine your runs can age out of the window before they are
  ever scored, and `judgeAvg` is then an average over what *was* scored.
- **Judging is off unless `JUDGE_MODEL` is pinned** to a concrete model id (an alias is
  rejected), and `POST /dream` answers `503` without a `DEEPSEEK_API_KEY` in littleDB's env.
- **littleDB replay sees file hashes, not contents.** The harness `file.*` events the
  reporter turns into `FileSnapshot`s carry what the event carried; a replay is not a
  reconstruction of the knowledge base at that moment.
- **`sampling`, `toolManifest` and `memoryPolicy` on the config bundle are inert.** Nothing
  in the harness adapter maps them onto harness options. They are required by
  `ConfigBundleSchema`, so the demo sends `{}` / `null`, and dreaming can change them with
  no observable effect.
- **Reaction session ids must agree on both sides.** The run pipeline keys sessions
  `<adapter>:<threadId>`; so does the reaction handler. A custom `session` callback without
  a matching `reactions.session` produces outcomes on a session id that has no trace, and
  the join is silently empty. This demo therefore uses the defaults on both sides.
- **The Slack adapter needs a signing secret at connector LOAD time.** `adapter.create()`
  runs before any message exists, so the descriptor branches on `SLACK_SIGNING_SECRET` and
  falls back to a credential-free stub under the same adapter name.
- **`createTestChat()` has no `onReaction`.** The shipped test double cannot exercise the
  reactions surface; `driver.mjs` subclasses it to add the one missing method.
- **Workflow event stores land in the process CWD, not the harness data dir.** An inline
  workflow receives `persistence.dataDir = "<sessionId>/workflows"` — a relative path
  (`packages/little-harness/src/execution/turn-tools.ts:88`) that `localWorld` resolves
  against `process.cwd()`. The demo gitignores and cleans `slack:*/` for this reason.
- **Host writes into `/persistent` do not commit.** `chat.stageMessage` writes uploads into
  `/session/uploads` on purpose — only runtime/bash writes are tracked by the Persistent Dir
  and committed after the turn. The model moving the file is what publishes it.

## Customer app — Northwind Helpdesk

`customer-app/` is the customer-facing surface: a small web chat (`http://localhost:3100`)
that bridges onto the same chat-sdk connector the Slack path uses. Everything a customer
does there — asking, uploading a document, reacting 👍/👎 — flows through the real harness,
the real littleDB trace reporter, and the real outcome sink. The developer console
(littleDB, `:3000`) and this app are deliberately separate applications: customers never
see traces.

```bash
LITTLEDB_URL=http://localhost:3000 node customer-app/server.mjs
```
