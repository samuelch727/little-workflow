# Support Command Center Demo

A Next.js app that showcases Little Harness **chat connectors** across **two** agents and several
developer surfaces. One agent is exposed through multiple platform connectors, and tool availability
is derived from folder **structure** (plus an optional descriptor `toolPolicy`) rather than
hand-maintained whitelists.

## Agents & routes

| Flow | Page / route | Agent | What it demonstrates | Code |
| --- | --- | --- | --- | --- |
| Support command center | `/` → `POST /api/chat` | `agents/support` | web-rich connector streaming `UIMessage.parts` into a rich console | `agents/support/connectors/web-rich`, `src/app/api/chat/route.ts` |
| Side-by-side chat | `/chat-demo` → `POST /api/chat-demo/{web,discord}` | `agents/support` | same agent on web vs Discord; the tool-inventory reply proves Discord sees `send-channel-update` and web does not | `src/app/api/chat-demo/runner.ts` |
| Portable session | `POST /api/portable-demo/{web,discord}` | `agents/support` | one shared harness session moving between web and Discord with cross-surface **mirror** delivery (`previousActive: "mirror"` + descriptor `deliver`) | `src/app/api/portable-demo/runner.ts` |
| Discord tool demo | `POST /api/discord/tool-demo` | `agents/support` | runs the Discord-only `send-channel-update` tool and confirms web-rich never discovers it | `src/app/api/discord/tool-demo/route.ts` |
| Discord (live) | `POST /api/discord`, `GET /api/discord/gateway` | `agents/support` | real `@chat-adapter/discord` webhook + cron-started Gateway listener | `src/app/api/discord/`, `agents/support/connectors/discord` |
| Concierge "Relay" | `/concierge` → `POST /api/concierge/{web,slack}` | `agents/concierge` | a **second** agent: web json-render dashboards vs a real `@chat-adapter/slack` connector, with connector-scoped tools | `agents/concierge/`, `src/app/api/concierge/` |
| Slack simulate | `POST /api/concierge/slack/simulate` | `agents/concierge` | drives a synthetic Slack event through the real Slack connector offline via `createTestChat` + `simulateInbound` | `src/app/api/concierge/slack/simulate/route.ts` |
| CLI chat | `little-harness test support` | `agents/support` | the same agent folder in a terminal REPL | `agents/support` |

The **concierge** agent has its own walkthrough in
[`agents/concierge/README.md`](./agents/concierge/README.md); live Slack wiring is documented in
[`agents/concierge/SLACK_SETUP.md`](./agents/concierge/SLACK_SETUP.md).

The support agent lives in `agents/support`. Tools are auto-discovered from `agents/support/tools`,
connectors live in nested `agents/support/connectors/<id>/connector.ts` folders, and reusable rich
web renderers live in `agents/support/ui`.

The web and Discord routes load each connector by its typed descriptor object plus a `connectorId`
(e.g. `{ connector: discordConnector, connectorId: "discord" }`). The descriptor object infers the
connector's `TUser`/`TExtraBody` generics — a bare string id resolves to `unknown` — while
`connectorId` keeps portable session attachment, connector-scoped tool extension discovery, and
mirror delivery active. Discord also exposes a connector-only `send-channel-update` tool from
`agents/support/connectors/discord/tools/send-channel-update.ts`; the web connector does not expose
that tool.

## Setup

The live model uses DeepSeek through the AI SDK provider:

```bash
export DEEPSEEK_API_KEY=...
export DEEPSEEK_MODEL_ID=deepseek-v4-pro
export DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
```

The env loader **merges every** candidate `.env.local` it finds (an explicit
`SUPPORT_COMMAND_CENTER_ENV_FILE`, then the app dir, then the worktree root, then the main repo
checkout root). A key set by a nearer file wins, and a real `process.env` value always wins over any
file — so a repo-root `.env.local` holding only `DISCORD_*` no longer hides `DEEPSEEK_*` in a nearer
file. `export KEY=value` lines are supported, and secret values are never printed. To pin the demo to
one file, set `SUPPORT_COMMAND_CENTER_ENV_FILE=/absolute/path/to/.env.local`.

## CLI Chat

Use the same agent folder from a terminal REPL:

```bash
pnpm --filter support-command-center harness:chat
```

From this app directory, the raw command is:

```bash
pnpm exec little-harness test support
```

The REPL supports `:reset` and `:exit`.

## Web

Start the web-rich support console:

```bash
pnpm --filter support-command-center dev
```

Open `http://localhost:3000`. The browser talks to `POST /api/chat`, which loads
`agents/support/connectors/web-rich/connector.ts` through `loadWebRichConnector(...)`.
For the minimal side-by-side connector demo, open `http://localhost:3000/chat-demo`. That page is
just a web chat and a Discord chat against the same support harness. Both panels are prefilled with a
tool-inventory question so the web chat shows the web active tool set, while the Discord chat shows
its base support tools plus the Discord-only `send-channel-update` connector tool.
The sidebar also includes a connector tool demo button. It calls `POST /api/discord/tool-demo`,
loads `agents/support/connectors/discord/tools/send-channel-update.ts`, executes it with a Discord
connector context, and confirms the web-rich connector does not discover the same tool.
Use the portable session demo buttons to run a web-rich turn and a Discord-style connector turn
against the same `support:portable:heliosoft` harness session. The Discord side is driven offline by
the SDK's `createTestChat`/`createTestThread`/`createTestMessage` helpers plus
`loaded.simulateInbound(...)`, so the demo exercises the Little Harness connector loader,
connector-scoped tools, active connector context, session attachment, and mirror delivery without
needing Discord credentials.
The web connector accepts the shared id through `x-harness-session-id` or request `sessionId`, and
the Discord connector accepts it from message `raw.harnessSessionId`.

## Discord

Discord uses two routes:

```txt
POST /api/discord          # HTTP interactions and forwarded Gateway events
POST /api/discord/tool-demo # local connector-specific tool demo
GET  /api/discord/gateway  # cron-protected Gateway listener starter
POST /api/portable-demo/web     # web-rich turn in the shared portable session
POST /api/portable-demo/discord # Discord-style turn in the same portable session
```

Set the Chat SDK Discord adapter env vars before using it with a real Discord app:

```bash
export DISCORD_BOT_TOKEN=...
export DISCORD_PUBLIC_KEY=...
export DISCORD_APPLICATION_ID=...
export CRON_SECRET=...
```

Configure the Discord Developer Portal Interactions Endpoint URL to
`https://your-domain.example/api/discord`. Regular DMs, mentions, and message reactions require the
Gateway WebSocket; `vercel.json` runs `/api/discord/gateway` every 9 minutes so the listener overlaps
the default 10 minute duration and forwards Gateway events back to `/api/discord`.

Optional Gateway env:

```bash
export DISCORD_GATEWAY_WEBHOOK_URL=https://your-domain.example/api/discord
export DISCORD_GATEWAY_DURATION_MS=600000
```

## Tool availability & mirror delivery

Tool availability is **structural**: executable `agents/support/tools/*` are global, and
`agents/support/connectors/<id>/tools/*` are that connector's own tools. A connector narrows this
default only when it means to hide something, via the descriptor `toolPolicy` (`allow` whitelist or
`deny` blacklist — `deny` wins). The web connector needs no policy at all (it gets the full support
toolset), while the Discord connector carries `toolPolicy: { deny: ["evaluate-refund-policy",
"create-escalation"] }` so those heavier tools stay in the web console. `send-channel-update` is
Discord-only purely because it lives under `connectors/discord/tools/`, so the web console can never
see it — no whitelist required.

Cross-surface **mirror delivery** uses the first-class flow: the loaders pass
`delivery: { previousActive: "mirror" }` so whichever surface was previously `active` in a shared
session keeps receiving replies, and each connector descriptor owns a `deliver` (see the `deliver`
field in each `connector.ts`) that does the actual posting to its platform. The demo points both
`deliver`s at an in-memory outbox (`agents/support/connectors/shared/mirror-delivery.ts`) so tests and
local runs get a deterministic record; in production `deliver` would call the target platform SDK.
The web routes pass `waitUntil` (`after` from `next/server`) to `loadWebRichConnector` so that
fire-and-forget mirror delivery survives serverless. The one place the demo drives the registry by
hand — seeding the first mirror target before any hand-off exists — is clearly labeled in
`src/app/api/portable-demo/runner.ts` and uses `attachSessionConnector` with the `chatSdkEndpointId`
builder (no hardcoded endpoint strings).

## Verification

```bash
pnpm --filter support-command-center test
pnpm --filter support-command-center typecheck
pnpm --filter support-command-center build
pnpm --filter support-command-center exec little-harness --help
printf 'Reply with READY only.\n:exit\n' | pnpm --filter support-command-center harness:chat
```
