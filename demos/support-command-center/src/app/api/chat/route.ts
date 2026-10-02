import { join } from "node:path";
import { after } from "next/server";
import {
  loadWebRichConnector,
  type LoadWebRichConnectorOptions,
  type LoadedWebRichConnector,
} from "little-harness/connectors/runtime";
import { supportMirrorDelivery } from "../../../../agents/support/connectors/shared/mirror-delivery";
import webRichConnector, {
  type SupportWebExtraBody,
  type SupportWebUser,
} from "../../../../agents/support/connectors/web-rich/connector";
import { loadCachedConnector, type ConnectorCache } from "../connector-cache";

const connectorCache: ConnectorCache<LoadedWebRichConnector<SupportWebUser, SupportWebExtraBody>> = {};
export const SUPPORT_WEB_CONNECTOR_ID = "web-rich";

// Load by the descriptor OBJECT plus `connectorId`, not a bare string id: the object infers the
// typed `TUser`/`TExtraBody` generics (a string reference is `unknown`), while `connectorId` keeps
// connector-scoped tool discovery, session attachment, and mirror delivery active.
export function createWebConnectorLoadOptions(): LoadWebRichConnectorOptions<
  SupportWebUser,
  SupportWebExtraBody
> & { connector: typeof webRichConnector } {
  return {
    agentDir: join(process.cwd(), "agents", "support"),
    connector: webRichConnector,
    connectorId: SUPPORT_WEB_CONNECTOR_ID,
    // `previousActive: "mirror"` keeps the previously-active surface (e.g. a Discord thread sharing
    // this session id) mirrored; each connector's descriptor `deliver` does the actual posting.
    delivery: supportMirrorDelivery<SupportWebExtraBody>(),
  };
}

function getWebConnector(): Promise<LoadedWebRichConnector<SupportWebUser, SupportWebExtraBody>> {
  return loadCachedConnector(connectorCache, () =>
    loadWebRichConnector<SupportWebUser, SupportWebExtraBody>({
      ...createWebConnectorLoadOptions(),
      // Keep fire-and-forget mirror delivery / afterRun alive on serverless (Vercel) after the
      // response stream ends. `after` is invoked inside the request scope of each POST.
      waitUntil: (task) => after(() => task),
    }),
  );
}

export async function POST(request: Request) {
  return (await getWebConnector()).POST(request);
}
