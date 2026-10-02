import { join } from "node:path";
import {
  loadChatSdkConnector,
  type LoadChatSdkConnectorOptions,
  type LoadedChatSdkConnector,
} from "little-harness/connectors/runtime";
import discordConnector, {
  type SupportDiscordExtraBody,
} from "../../../../agents/support/connectors/discord/connector";
import { supportMirrorDelivery } from "../../../../agents/support/connectors/shared/mirror-delivery";
import { loadCachedConnector, type ConnectorCache } from "../connector-cache";

const connectorCache: ConnectorCache<LoadedChatSdkConnector<SupportDiscordExtraBody>> = {};
export const SUPPORT_DISCORD_CONNECTOR_ID = "discord";

// Load by the descriptor OBJECT plus `connectorId`: the object infers the typed `TExtraBody` generic
// (a string reference is `unknown`), while `connectorId` keeps connector-scoped tool discovery,
// session attachment, and mirror delivery active.
export function createDiscordConnectorLoadOptions(): LoadChatSdkConnectorOptions<SupportDiscordExtraBody> & {
  connector: typeof discordConnector;
} {
  return {
    agentDir: join(process.cwd(), "agents", "support"),
    connector: discordConnector,
    connectorId: SUPPORT_DISCORD_CONNECTOR_ID,
    // `previousActive: "mirror"` keeps the previously-active surface (e.g. the web console sharing
    // this session id) mirrored; each connector's descriptor `deliver` does the actual posting.
    delivery: supportMirrorDelivery<SupportDiscordExtraBody>(),
  };
}

export function getDiscordConnector() {
  return loadCachedConnector(connectorCache, () =>
    loadChatSdkConnector<SupportDiscordExtraBody>(createDiscordConnectorLoadOptions()),
  );
}
