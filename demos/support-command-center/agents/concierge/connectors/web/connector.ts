import { webRichConnector, type WebRichUser } from "little-harness/connectors/runtime";
import { CONCIERGE_SESSION_ID_HEADER, conciergeSessionId } from "../shared/session-id";

export type ConciergeWebUser = WebRichUser;

export type ConciergeWebExtraBody = {
  platform: "web";
  userId: string;
  conversationId: string;
  sessionId?: string;
};

function requestedSessionId(request: Request, body: unknown): string | undefined {
  const bodySessionId =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as { sessionId?: unknown }).sessionId
      : undefined;
  return (
    conciergeSessionId(request.headers.get(CONCIERGE_SESSION_ID_HEADER)) ??
    conciergeSessionId(bodySessionId)
  );
}

/**
 * Web connector for the concierge. Streams Little Harness `UIMessage.parts`
 * (including the typed `render-dashboard` json-render part) to the browser.
 */
export default webRichConnector<ConciergeWebUser, ConciergeWebExtraBody>({
  authenticate: (request) => ({
    id: request.headers.get("x-concierge-user-id") ?? "demo-release-manager",
    name: request.headers.get("x-concierge-user-name") ?? "Demo Release Manager",
  }),
  session: ({ request, body, user }) =>
    requestedSessionId(request, body) ?? `concierge:web:${user.id}:${body.id}`,
  history: { source: "request" },
  extraBody: ({ request, body, user }) => {
    const sessionId = requestedSessionId(request, body);
    return {
      platform: "web",
      userId: user.id,
      conversationId: body.id,
      ...(sessionId === undefined ? {} : { sessionId }),
    };
  },
});
