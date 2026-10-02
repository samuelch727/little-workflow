import { join } from "node:path";
import {
  loadWebRichConnector,
  type LoadWebRichConnectorOptions,
  type LoadedWebRichConnector,
} from "little-harness/connectors/runtime";
import conciergeWebConnector, {
  type ConciergeWebExtraBody,
  type ConciergeWebUser,
} from "../../../../../agents/concierge/connectors/web/connector";
import { loadCachedConnector, type ConnectorCache } from "../../connector-cache";

const connectorCache: ConnectorCache<
  LoadedWebRichConnector<ConciergeWebUser, ConciergeWebExtraBody>
> = {};

export const CONCIERGE_WEB_CONNECTOR_ID = "web";

// Load by the descriptor OBJECT plus `connectorId` (the object infers the typed generics; a string
// reference is `unknown`). No tool-policy wiring needed: availability is derived from structure. The
// web connector gets the global tools (get-release-status, list-releases) plus its own
// render-dashboard tool, automatically.
export function createConciergeWebConnectorLoadOptions(): LoadWebRichConnectorOptions<
  ConciergeWebUser,
  ConciergeWebExtraBody
> & { connector: typeof conciergeWebConnector } {
  return {
    agentDir: join(process.cwd(), "agents", "concierge"),
    connector: conciergeWebConnector,
    connectorId: CONCIERGE_WEB_CONNECTOR_ID,
  };
}

function getConciergeWebConnector(): Promise<
  LoadedWebRichConnector<ConciergeWebUser, ConciergeWebExtraBody>
> {
  return loadCachedConnector(connectorCache, () =>
    loadWebRichConnector<ConciergeWebUser, ConciergeWebExtraBody>(
      createConciergeWebConnectorLoadOptions(),
    ),
  );
}

export async function POST(request: Request) {
  return (await getConciergeWebConnector()).POST(request);
}
