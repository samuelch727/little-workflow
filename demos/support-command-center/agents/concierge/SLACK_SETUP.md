# Live Slack setup (concierge connector)

The concierge demo runs fully on the DeepSeek key alone — the web surface is live and the Slack surface
is exercised through the synthetic simulate route (`POST /api/concierge/slack/simulate`). This file
documents how to point the **real** `@chat-adapter/slack` connector at a live Slack workspace.

The connector is already wired in `src/app/api/concierge/slack/route.ts` (the Events webhook) and
`agents/concierge/connectors/slack/connector.ts` (`createSlackAdapter`). You only need a Slack app and a
few env vars.

## 1. Create a Slack app

1. Go to <https://api.slack.com/apps> → **Create New App** → **From scratch**. Pick your workspace.
2. **OAuth & Permissions** → Bot Token Scopes, add:
   - `chat:write` (post to channels / reply in threads — used by `post-to-channel` / `reply-in-thread`)
   - `app_mentions:read` (mentions)
   - `im:history`, `im:read`, `im:write` (direct messages)
   - `channels:history` (read thread history when `history: { source: "thread" }`)
3. **Install to Workspace**. Copy the **Bot User OAuth Token** (`xoxb-…`).

## 2. Choose a connection mode

`createSlackAdapter` supports both. The connector defaults to `mode: "webhook"`.

### Option A — Events API webhook (default, needs a public URL)
1. Run the app and expose it publicly (e.g. `ngrok http 3000`).
2. Slack app → **Event Subscriptions** → enable, set **Request URL** to
   `https://<public-host>/api/concierge/slack`. Slack will verify the URL.
3. Subscribe to bot events: `message.im`, `app_mention`.
4. Copy the **Signing Secret** from **Basic Information** → `SLACK_SIGNING_SECRET`.

### Option B — Socket Mode (no public URL)
1. Slack app → **Socket Mode** → enable. Create an **App-Level Token** with `connections:write`
   (`xapp-…`).
2. Set `mode: "socket"` in `agents/concierge/connectors/slack/connector.ts` and provide `appToken`.
   Start the socket listener from a long-running process (the adapter uses `@slack/socket-mode`).

## 3. Environment variables

Add to the repo-root `.env.local` (same file as `DEEPSEEK_API_KEY`):

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...        # Option A (webhook)
# SLACK_APP_TOKEN=xapp-...      # Option B (socket mode)
SLACK_BOT_USERNAME=relay        # optional, defaults to "relay"
```

## 4. Try it

DM the bot or @mention it in a channel:

> @relay post the v4.2.0 release status to #releases

The agent calls `get-release-status` then `post-to-channel` / `reply-in-thread`. On the web surface the
same prompt produces a json-render dashboard instead — same agent, connector-specific tools.

## Notes

- No Slack credentials are needed for local development or tests. The synthetic path
  (`runConciergeSlackSimulation`) drives the real connector descriptor with an inert adapter.
- The Slack-only tools currently record to an in-memory channel log for the demo. To post for real, have
  their `execute` call the Slack Web API via the adapter's client (the bot token above authorizes it).
