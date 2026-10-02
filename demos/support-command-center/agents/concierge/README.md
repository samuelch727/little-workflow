# Connector Showcase — "Relay"

A focused demo of Little Harness **chat connectors**: one agent, two **real** connectors, each with
its own platform-native tools. The same prompt produces a different platform-native output depending on
which connector is active — proving connector-scoped tool isolation.

| Connector | Kind | Connector-specific tools | Output shape |
| --- | --- | --- | --- |
| **Web** | `webRichConnector` | `render-dashboard` | a [json-render](https://json-render.dev/) generative-UI dashboard, rendered live in the browser |
| **Slack** | `chatSdkConnector` + real `@chat-adapter/slack` | `post-to-channel`, `reply-in-thread` | channel text |

Both connectors share the base `get-release-status` tool. Tool isolation is **structural**: a tool
under `connectors/web/tools/` is web-only and one under `connectors/slack/tools/` is Slack-only, so
the web connector never sees the Slack tools and vice-versa — no whitelist required. The Slack
connector additionally opts out of the global `list-releases` tool with a targeted blacklist
(`toolPolicy: { deny: ["list-releases"] }` in `connectors/slack/connector.ts`).

## Run it

Needs only `DEEPSEEK_API_KEY` in the repo-root `.env.local` (the web surface is fully live; the Slack
surface runs through a synthetic event path — no Slack credentials required).

```bash
# from demos/support-command-center
DEEPSEEK_MODEL_ID=deepseek-v4-flash pnpm dev      # flash is cheap; omit for the v4-pro default
# open http://localhost:3000/concierge
```

- **Web panel:** "Show me the v4.2.0 release status as a dashboard." → the agent calls
  `render-dashboard` and a json-render dashboard appears.
- **Slack panel:** "Post the v4.2.0 release status to #releases." → the agent calls `post-to-channel`
  and the channel feed shows the post.

## Live Slack

The real `@chat-adapter/slack` connector is wired at `src/app/api/concierge/slack/route.ts`. To point it
at a live workspace, follow [SLACK_SETUP.md](./SLACK_SETUP.md).

## Tests

```bash
pnpm vitest run agents/concierge src/app/api/concierge src/components/concierge-showcase.test.tsx
# live DeepSeek smoke (hits the API):
RUN_LIVE=1 DEEPSEEK_MODEL_ID=deepseek-v4-flash pnpm vitest run src/app/api/concierge/concierge-live.test.ts
```

## Layout

```
agents/concierge/
  agent.ts · env.ts                     # env.ts re-exports the support DeepSeek loader
  data/releases.ts                      # synthetic release snapshots
  tools/get-release-status.ts           # shared base tool
  tools/list-releases.ts                # global tool; Slack denies it via toolPolicy
  connectors/
    web/connector.ts                     # webRichConnector (no toolPolicy needed)
    web/tools/render-dashboard.ts        # web-only (structure-scoped, plain executable tool)
    slack/connector.ts                   # real @chat-adapter/slack; toolPolicy: { deny: [...] }
    slack/tools/{post-to-channel,reply-in-thread}.ts   # slack-only (structure-scoped)
    slack/channel-log.ts                 # globalThis-backed (survives discovery module boundary)
    shared/session-id.ts
  ui/
    catalog.ts · registry.tsx · spec.ts  # json-render catalog + renderer + spec builder
    types.ts · tool-parts/render-dashboard.tsx
src/app/api/concierge/{web,slack,slack/simulate}/...   # routes
src/app/concierge/page.tsx · src/components/concierge-showcase.tsx
```

Tool availability is derived from folder structure; connector tools read the harness execution
context (the active connector endpoint) cast-free via `tryHarnessToolContext`, and the Slack simulate
route drives a synthetic event offline through the real connector with `createTestChat` +
`loaded.simulateInbound(...)`.
