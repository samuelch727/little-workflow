# workerd-chats

Many chats in one self-hosted [workerd](https://github.com/cloudflare/workerd)
process, each with its own files and its own `bash`, on Little Harness's
`virtualHost()`.

- **One Durable Object per chat.** The router sends `/chats/<id>/...` to the object
  for that id, created on first use.
- **Files in SQLite, one row per file.** `src/chat-files.ts` opens the chat's rows
  as a just-bash filesystem, reads a file's row only when something reads that
  file, and writes back only the paths a turn changed.
- **Turns in order.** Turns of one chat run one after another; different chats run
  at the same time. Answers use that same queue.
- **Questions and traces in SQLite.** `src/chat-store.ts` implements the harness's
  `DurableJsonStore`, and `trace_events` keeps events locally without any network.
- **Agent workflows without disk.** One-shot plans and reusable workflows run on
  `virtualWorld()` over the chat's data filesystem.

The host, turn execution and human-input helpers come from Little Harness.
Routing, the chat's storage and its message history are this app's, and you can
change all of them.

## Run it

From the repository root, build the harness and workflow packages:

```bash
pnpm install
pnpm --filter @little-stack/harness build
pnpm --filter @little-stack/workflow build
```

Then, in this folder:

```bash
pnpm build        # bundle src/worker.ts into dist/worker.js
pnpm serve        # workerd serve workerd.capnp, on port 8080, data in ./data

curl -X POST localhost:8080/chats/a/messages -H 'content-type: application/json' \
  -d '{"text":"echo hello > notes.txt && cat notes.txt"}'
curl localhost:8080/chats/a/files
```

Without a key, each chat runs a scripted model that runs your message as one bash
command and replies with what bash printed. Set `DEEPSEEK_API_KEY` before
`pnpm serve` for a real model (`deepseek-v4-flash`). `pnpm dev` runs the same app
under `wrangler dev` instead.

## Tools on your Node data service

The optional remote tool keeps its SQLite connection, query code and credentials
in `data-service.mjs`, outside the workerd bundle. It uses the shared validating
`src/remote-contracts.ts`. Start the loopback service in another terminal (Node
22.13 or later):

```bash
export DATA_API_TOKEN=local-development-only
node --experimental-strip-types data-service.mjs # 127.0.0.1:8788
```

Use the same `DATA_API_TOKEN` in the terminal running `pnpm serve`, then:

```bash
curl localhost:8080/chats/orders/messages -H 'content-type: application/json' \
  -d '{"text":"orders:open"}'
```

`workerd.capnp` binds `DATA_API` to `127.0.0.1:8788` and reads the token from the
environment. To change ports, set `DATA_API_PORT` on Node and edit that external
address. A missing token leaves the remote tool unregistered. Wrong tokens and
an unavailable service produce ordinary tool errors, allowing another turn.
The demo's fixed `demo` principal can read only its own seeded orders; the row
owned by `other` is excluded by a parameterized query.

This is a credentialed **loopback development example**. The service token proves
the demo host called; it is not proof of an end user's identity. For a deployable
service use TLS and verify per-user proof from a dedicated header (issuer,
audience and expiry), then authorize each resource against that principal.
`context` is only a host assertion. See the
[remote-tools guide](../../apps/little-harness-doc/content/docs/v0.1.0-alpha/build-agents/remote-tools.mdx).
The demo router itself has no user authentication; user/chat namespacing remains
a separate follow-up. Its trace table is not automatically a replay session log.
Use business keys for retried writes; a timeout is an uncertain outcome.

## Stream a reply

JSON remains the default. Request an AI SDK UI message stream with
`Accept: text/event-stream`, or add `?stream=1`:

```bash
curl -N localhost:8080/chats/a/messages -H 'content-type: application/json' \
  -H 'accept: text/event-stream' \
  -d '{"text":"echo hello > notes.txt && cat notes.txt"}'
```

The stream includes tool inputs, tool outputs and text as they happen. Its
`finish` chunk is held until the harness finishes, message history is recorded,
and `ChatFiles.save()` succeeds. The response then ends with `[DONE]`. A failed
turn sends one generic `error` chunk and no `finish`; treat partial text as
unacknowledged until `finish`. Trace export remains best-effort in the background.

In a React client that already uses `@ai-sdk/react` and `ai`, connect `useChat`
through `DefaultChatTransport`. Send only the last message's text: this server
owns the chat's history.

```tsx
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";

export function useWorkerdChat(chatId: string) {
  return useChat({
    transport: new DefaultChatTransport({
      api: `/chats/${encodeURIComponent(chatId)}/messages?stream=1`,
      prepareSendMessagesRequest: ({ messages }) => ({
        body: {
          text: messages.at(-1)?.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text).join("") ?? "",
        },
      }),
    }),
  });
}
```

Use the hook's `sendMessage({ text: "echo hello" })` and render its `messages`
in your app. Stopping the client or leaving the page stops delivery only: the
server keeps running the turn, saving files and history, and holding that chat's
queue slot. There is no server stop endpoint. A streamed `ask:` turn also sends
`finish` after saving its parked state and user message, with
`messageMetadata: { status: "parked", requests }`. In `useChat`, read the input
request ID from the assistant message's `metadata.requests[n].requestId`, then
send it to the existing `/answers` endpoint:

```bash
curl -X POST localhost:8080/chats/a/answers -H 'content-type: application/json' \
  -d '{"requestId":"input_...","answer":{"text":"The blue notebook"}}'
```

That endpoint resumes the parked turn. A completed turn's `finish` is unchanged.

## Plans and reusable workflows

With the scripted model, `plan:<text>` runs a one-shot plan: `word_count` counts
the words, then a model step writes `Words: <count>`. The reply contains the
plan's completed result and output.

```bash
curl -X POST localhost:8080/chats/a/messages -H 'content-type: application/json' \
  -d '{"text":"plan:one two three"}'
curl -X POST localhost:8080/chats/a/messages -H 'content-type: application/json' \
  -d '{"text":"define:notes.words"}'
curl -X POST localhost:8080/chats/a/messages -H 'content-type: application/json' \
  -d '{"text":"use:notes.words:four fresh words here"}'
```

`define:<id>` saves a reusable word-count workflow. Its tool is offered from the
next turn on; `use:<id>:<text>` calls it. Its first run calls the scripted planner,
which adapts the real compiler's tool-and-model skeleton. Later inputs of the
same shape keep the saved plan without calling the planner again, including
after a process restart when the definition and prior run completed first.

The default data root is hidden at `/.little-harness/data`. Definitions live
under `dynamic-plans/workflows`, one-shot runs under
`dynamic-workflows/<runId>`, and reusable workflow runs and kept plans under
`agent-workflows`. The World wrapper only observes events for local tracing;
it preserves the host's filesystem object and stores runtime files there.
`ChatFiles` saves those files at the end of the turn. One process owns that
filesystem, which is one Durable Object here. These completed-state guarantees
do not recover workflow runs interrupted mid-turn.

## Keep state across restarts

The `ChatStore` adapter stores JSON documents in the object's SQLite `docs`
table. Its promise-chain mutex covers one store instance, which is one chat
Durable Object. Files and message history are saved before a turn or answer
returns HTTP success.

With the scripted model, a message beginning with `ask:` asks a person and parks:

```bash
curl -X POST localhost:8080/chats/a/messages -H 'content-type: application/json' \
  -d '{"text":"ask:Which notebook should I use?"}'
# Copy requestId from the response's requests array, then answer (even after restart):
curl -X POST localhost:8080/chats/a/answers -H 'content-type: application/json' \
  -d '{"requestId":"input_...","answer":{"text":"The blue notebook"}}'
```

An acknowledged parked turn, plus completed files and saved message history,
survives a restart. A turn running or resuming when the process dies is not
recovered; claimed resume records stay claimed. A reply completed before its
history was saved is not recovered either. This example provides no exactly-once
recovery protocol. Empty folders and symlinks are not persisted.

## Traces without internet

`GET /chats/a/trace?after=0` returns `{ events }`. Each row adds `id`, a SQLite
`AUTOINCREMENT` cursor, to the original event. Use the last returned `id` as the
next `after` value. A row's `source` is `harness` or `workflow`. Its original
`sequence` is preserved: per session for Harness events, per `runId` for Workflow
events. Compare sequences only within their source and run; only `id` orders
the combined trace. Workflow rows keep their original `eventId`, `recordedAt`
and payload, plus the parent session and turn ids. Every
insert commits independently, and its transaction prunes all but the newest
5,000 rows. Poll before retention removes unseen rows; a cursor cannot recover
pruned history. `TRACE_LIMIT` can lower retention for a local pruning test.

The harness writes its hidden `trace.json` counter before exposing each event.
`ChatFiles` writes that file through to SQLite immediately so a crash before the
normal end-of-turn save cannot reuse an exposed sequence. Other files still
save at the end of the turn.

LittleDB export is optional. Set **both** `LITTLEDB_URL` and `LITTLEDB_API_KEY`
to send Harness events through the unchanged `@little-stack/littledb` tracer.
With either absent, the app constructs no client and makes no LittleDB calls;
there is no default URL. Export flushes in the background after each turn.
Failures log once per in-memory chat object and do not fail the turn or remove
its local traces.

## A model without internet

Set `MODEL_BASE_URL` (for example `http://127.0.0.1:11434/v1`) and `MODEL_NAME`
to use an OpenAI-compatible vLLM, Ollama or llama.cpp server. `MODEL_API_KEY` is
optional. These settings take precedence over DeepSeek; without either model
configuration, the scripted model needs no network.

The sample workerd network policy allows public servers and `127.0.0.1`.
For a model or LittleDB on another LAN host, add only that chosen IP or subnet
to the `internet` service's `allow` list in `workerd.capnp`. This is workerd's
outbound policy, separate from the model URL; a URL alone does not grant access.

`pnpm test` bundles the app, serves it with workerd on a free port, and checks that
chats keep separate files, that eight chats run at once, that one chat's turns run
in order, and that missing commands fail clearly. It also exercises parked-turn
restart and answers, saved history, SIGKILL before file save, trace cursor
pruning, zero LittleDB calls for off/partial settings, export outage, and a fake
compatible model. Workflow tests run a tool-and-model plan and verify that a
completed definition stays offered after restart, retaining its workflow version
with an unchanged-plan decision and no planner call. Streaming tests check UI
chunk order and framing, saved state before `finish`, a failed finalization,
queue ordering through a delayed save, client disconnect and restart, parked
questions, query-string opt-in, and streamed workflows. Fault injection exists
only in the generated test config; the shipped `workerd.capnp` has no
`TEST_FAULTS` binding. The suite strips
provider/model/LittleDB settings and gives workerd
only loopback network access. It needs no key.

To run it in a container, `pnpm build` first, then
`docker build -t workerd-chats . && docker run -p 8080:8080 -v chats:/app/data workerd-chats`.

## What workerd's bash lacks

workerd loads just-bash's browser build, which has no `python3`, `node`
(`js-exec`), `sqlite3`, `tar`, `yq` or `xan`. The harness tells the agent so in its
system prompt. `jq`, `grep`, `sed`, `awk` and the rest of just-bash's commands
work. For the full list of limits, see the "Run on workerd" docs page.

The keyless scripted model accepts `parallel-bash:<command>` to issue two identical
bash tool calls in one model step. This exercises exact command IDs and overlapping
execution inside one chat/turn; response events expose only allowlisted IDs and scope,
not command text, output or raw metadata.
