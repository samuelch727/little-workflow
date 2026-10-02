import { join } from "node:path";
import { NextResponse } from "next/server";
import { resolveToolExtension } from "little-harness/connectors/runtime";
import { loadConnectorToolExtensions } from "little-harness/connectors/discovery";
import sendChannelUpdateExtension, {
  type SendChannelUpdateOutput,
} from "../../../../../agents/support/connectors/discord/tools/send-channel-update";

const TOOL_NAME = "send-channel-update";

type SendChannelUpdateInput = {
  customerId: string;
  summary: string;
  urgency: "normal" | "high";
};

type SendChannelUpdateTool = {
  execute?: (
    input: SendChannelUpdateInput,
    options: unknown,
  ) => Promise<SendChannelUpdateOutput>;
};

export type DiscordConnectorToolDemoResult = {
  connectorId: "discord";
  toolName: typeof TOOL_NAME;
  discordToolNames: string[];
  webRichToolNames: string[];
  webRichExposesTool: boolean;
  input: SendChannelUpdateInput;
  output: SendChannelUpdateOutput;
};

export async function runDiscordConnectorToolDemo(): Promise<DiscordConnectorToolDemoResult> {
  const agentDir = join(process.cwd(), "agents", "support");
  // Tool availability is structural: `send-channel-update` lives in `connectors/discord/tools/`, so
  // it is discovered ONLY for the Discord connector. The web-rich connector has no `tools/` folder,
  // so it exposes no connector-only tools — proven here by discovering both, not by a whitelist.
  const discordToolNames = Object.keys(await loadConnectorToolExtensions(agentDir, "discord", {}));
  const webRichToolNames = Object.keys(await loadConnectorToolExtensions(agentDir, "web-rich", {}));

  const tool = resolveToolExtension(TOOL_NAME, undefined, sendChannelUpdateExtension) as
    | SendChannelUpdateTool
    | undefined;

  if (tool?.execute === undefined) {
    throw new Error(`Discord connector tool ${TOOL_NAME} was not discovered.`);
  }

  const input: SendChannelUpdateInput = {
    customerId: "cust_enterprise_helio",
    summary: "Finance approval path is ready; keep success manager copied before renewal.",
    urgency: "high",
  };
  // `session`/`files` are the minimal shape `tryHarnessToolContext` recognizes; the harness spreads
  // these plus the active `connector` into a tool at run time. Here we supply the Discord endpoint so
  // the tool resolves the channel/audit id, exactly as it would in a live Discord run.
  const output = await tool.execute(input, {
    session: {},
    files: {},
    connector: {
      id: "discord",
      kind: "chat-sdk",
      endpoint: {
        id: "discord:discord_thread_demo",
        platform: "discord",
        threadId: "discord_thread_demo",
        userId: "discord_demo_user",
      },
    },
  });

  return {
    connectorId: "discord",
    toolName: TOOL_NAME,
    discordToolNames,
    webRichToolNames,
    webRichExposesTool: webRichToolNames.includes(TOOL_NAME),
    input,
    output,
  };
}

export async function POST() {
  return NextResponse.json(await runDiscordConnectorToolDemo());
}
