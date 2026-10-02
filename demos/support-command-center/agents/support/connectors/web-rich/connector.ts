import { webRichConnector, type WebRichUser } from "little-harness/connectors/runtime";
import { recordSupportMirrorDelivery } from "../shared/mirror-delivery";
import { SUPPORT_SESSION_ID_HEADER, supportSessionId } from "../shared/session-id";

export type SupportWebUser = WebRichUser & {
  email: string;
};

export type SupportWebExtraBody = {
  platform: "web";
  userId: string;
  conversationId: string;
  channel: "support-command-center";
  sessionId?: string;
};

function requestedSessionId(request: Request, body: unknown): string | undefined {
  const bodySessionId = typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as { sessionId?: unknown }).sessionId
    : undefined;
  return supportSessionId(request.headers.get(SUPPORT_SESSION_ID_HEADER)) ??
    supportSessionId(bodySessionId);
}

export default webRichConnector<SupportWebUser, SupportWebExtraBody>({
  authenticate: (request) => ({
    id: request.headers.get("x-support-user-id") ?? "demo-support-manager",
    name: request.headers.get("x-support-user-name") ?? "Demo Support Manager",
    email: request.headers.get("x-support-user-email") ?? "support.manager@example.com",
  }),
  session: ({ request, body, user }) =>
    requestedSessionId(request, body) ?? `support:web:${user.id}:${body.id}`,
  history: { source: "request" },
  // No `toolPolicy`: the web console gets the full structure-derived toolset (every global support
  // `tools/*`). It carries no connector-only tools of its own, and `send-channel-update` lives under
  // `connectors/discord/tools/`, so it is Discord-only by structure — nothing to whitelist or deny.
  // Descriptor-owned mirror posting for when another surface mirrors a reply into the web console.
  deliver: recordSupportMirrorDelivery,
  extraBody: ({ request, body, user }) => {
    const sessionId = requestedSessionId(request, body);
    return {
      platform: "web",
      userId: user.id,
      conversationId: body.id,
      channel: "support-command-center",
      ...(sessionId === undefined ? {} : { sessionId }),
    };
  },
});
