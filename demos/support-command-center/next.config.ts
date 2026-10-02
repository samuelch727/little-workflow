import type { NextConfig } from "next";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(fileURLToPath(import.meta.url));
const supportAgentTraceFiles = [
  "./agents/support/agent.ts",
  "./agents/support/env.ts",
  "./agents/support/instructions.md",
  "./agents/support/connectors/discord/connector.ts",
  "./agents/support/connectors/discord/tools/send-channel-update.ts",
  "./agents/support/connectors/shared/mirror-delivery.ts",
  "./agents/support/connectors/shared/session-id.ts",
  "./agents/support/connectors/web-rich/connector.ts",
  "./agents/support/data/store.ts",
  "./agents/support/tools/check-service-status.ts",
  "./agents/support/tools/create-escalation.ts",
  "./agents/support/tools/evaluate-refund-policy.ts",
  "./agents/support/tools/lookup-customer.ts",
  "./agents/support/tools/lookup-orders.ts",
  "./agents/support/tools/summarize-ticket-history.ts",
];
const supportAgentTraceExcludes = [
  "./agents/support/**/*.test.ts",
  "./agents/support/**/*.test.tsx",
  "./agents/support/ui/**/*",
];

// The concierge connectors are loaded via dynamic import (connector discovery),
// which Next output tracing cannot follow, so enumerate the runtime files.
const conciergeAgentTraceFiles = [
  "./agents/concierge/agent.ts",
  "./agents/concierge/env.ts",
  "./agents/support/env.ts", // concierge/env re-exports the support DeepSeek loader
  "./agents/concierge/data/releases.ts",
  "./agents/concierge/tools/get-release-status.ts",
  "./agents/concierge/ui/spec.ts", // server-side spec builder (type-only json-render import)
  "./agents/concierge/connectors/shared/session-id.ts",
  "./agents/concierge/connectors/web/connector.ts",
  "./agents/concierge/connectors/web/tools/render-dashboard.ts",
  "./agents/concierge/connectors/slack/connector.ts",
  "./agents/concierge/connectors/slack/channel-log.ts",
  "./agents/concierge/connectors/slack/tools/post-to-channel.ts",
  "./agents/concierge/connectors/slack/tools/reply-in-thread.ts",
];
const conciergeAgentTraceExcludes = [
  "./agents/concierge/**/*.test.ts",
  "./agents/concierge/**/*.test.tsx",
  "./agents/concierge/ui/registry.tsx",
  "./agents/concierge/ui/catalog.ts",
  "./agents/concierge/ui/tool-parts/**/*",
];

const nextConfig: NextConfig = {
  turbopack: {
    root: join(appDir, "../.."),
  },
  serverExternalPackages: [
    "little-harness",
    "chat",
    "@chat-adapter/discord",
    "@chat-adapter/slack",
    "@chat-adapter/state-memory",
  ],
  outputFileTracingIncludes: {
    "/api/chat": supportAgentTraceFiles,
    "/api/discord": supportAgentTraceFiles,
    "/api/discord/gateway": supportAgentTraceFiles,
    "/api/discord/tool-demo": supportAgentTraceFiles,
    "/api/chat-demo/discord": supportAgentTraceFiles,
    "/api/chat-demo/web": supportAgentTraceFiles,
    "/api/portable-demo/discord": supportAgentTraceFiles,
    "/api/portable-demo/web": supportAgentTraceFiles,
    "/api/concierge/web": conciergeAgentTraceFiles,
    "/api/concierge/slack": conciergeAgentTraceFiles,
    "/api/concierge/slack/simulate": conciergeAgentTraceFiles,
  },
  outputFileTracingExcludes: {
    "/api/chat": supportAgentTraceExcludes,
    "/api/discord": supportAgentTraceExcludes,
    "/api/discord/gateway": supportAgentTraceExcludes,
    "/api/discord/tool-demo": supportAgentTraceExcludes,
    "/api/chat-demo/discord": supportAgentTraceExcludes,
    "/api/chat-demo/web": supportAgentTraceExcludes,
    "/api/portable-demo/discord": supportAgentTraceExcludes,
    "/api/portable-demo/web": supportAgentTraceExcludes,
    "/api/concierge/web": conciergeAgentTraceExcludes,
    "/api/concierge/slack": conciergeAgentTraceExcludes,
    "/api/concierge/slack/simulate": conciergeAgentTraceExcludes,
  },
};

export default nextConfig;
