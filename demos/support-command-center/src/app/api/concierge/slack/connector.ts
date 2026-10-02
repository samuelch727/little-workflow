import { join } from "node:path";
import {
  loadChatSdkConnector,
  type LoadChatSdkConnectorOptions,
  type LoadedChatSdkConnector,
} from "little-harness/connectors/runtime";
import slackConnector, {
  type ConciergeSlackExtraBody,
} from "../../../../../agents/concierge/connectors/slack/connector";
import { loadCachedConnector, type ConnectorCache } from "../../connector-cache";

const connectorCache: ConnectorCache<LoadedChatSdkConnector<ConciergeSlackExtraBody>> = {};
export const CONCIERGE_SLACK_CONNECTOR_ID = "slack";

// Load by the descriptor OBJECT plus `connectorId` (the object infers the typed `TExtraBody`; a
// string reference is `unknown`). No tool-policy wiring needed here: availability is structural
// (global tools + the slack/tools/* connector tools), and the Slack connector descriptor's
// `toolPolicy: { deny: ["list-releases"] }` removes that one global tool.
export function createConciergeSlackConnectorLoadOptions(): LoadChatSdkConnectorOptions<ConciergeSlackExtraBody> & {
  connector: typeof slackConnector;
} {
  return {
    agentDir: join(process.cwd(), "agents", "concierge"),
    connector: slackConnector,
    connectorId: CONCIERGE_SLACK_CONNECTOR_ID,
  };
}

export function getConciergeSlackConnector() {
  return loadCachedConnector(connectorCache, () =>
    loadChatSdkConnector<ConciergeSlackExtraBody>(createConciergeSlackConnectorLoadOptions()),
  );
}
