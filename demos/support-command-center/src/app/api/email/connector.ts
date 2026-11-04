import { join } from "node:path";
import {
  loadChatSdkConnector,
  type ChatSdkChatConstructor,
  type LoadChatSdkConnectorOptions,
  type LoadedChatSdkConnector,
} from "@little-stack/harness/connectors/runtime";
import { Chat } from "chat";
import emailConnector from "../../../../agents/support/connectors/email/connector";
import { loadCachedConnector, type ConnectorCache } from "../connector-cache";

const connectorCache: ConnectorCache<LoadedChatSdkConnector> = {};
export const SUPPORT_EMAIL_CONNECTOR_ID = "email";

export function createEmailConnectorLoadOptions(): LoadChatSdkConnectorOptions & {
  connector: typeof emailConnector;
} {
  return {
    agentDir: join(process.cwd(), "agents", "support"),
    connector: emailConnector,
    connectorId: SUPPORT_EMAIL_CONNECTOR_ID,
    // Pass the Chat SDK constructor this app depends on, rather than letting Little Harness import
    // `chat` itself.
    createChat: Chat as unknown as ChatSdkChatConstructor,
  };
}

export function getEmailConnector() {
  return loadCachedConnector(connectorCache, () => loadChatSdkConnector(createEmailConnectorLoadOptions()));
}
