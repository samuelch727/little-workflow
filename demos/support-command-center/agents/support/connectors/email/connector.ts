import { createMemoryState } from "@chat-adapter/state-memory";
import { emailConnector } from "@little-stack/harness/connectors/runtime";
import { createResendAdapter } from "@resend/chat-sdk-adapter";

// The address this agent owns. Point its domain's MX records at Resend and add an
// `email.received` webhook for `POST /api/email`.
export const SUPPORT_EMAIL_ADDRESS = process.env.SUPPORT_EMAIL_ADDRESS ?? "support@agents.example.com";
// The id Resend's receiving server writes first in its `Authentication-Results` header. Only that
// header's DMARC verdict is trusted; a sender can plant any other. Whether Resend adds the header,
// and under which id, is unconfirmed in this alpha: until this is set, every email is refused and
// the skip log lists the ids the email carried (see README).
export const SUPPORT_EMAIL_AUTHSERV_ID = process.env.SUPPORT_EMAIL_AUTHSERV_ID ?? "authserv-id-not-configured";

export default emailConnector({
  address: SUPPORT_EMAIL_ADDRESS,
  adapter: {
    name: "resend",
    // Reads RESEND_API_KEY and RESEND_WEBHOOK_SECRET from the environment.
    create: () =>
      createResendAdapter({ fromAddress: SUPPORT_EMAIL_ADDRESS, fromName: "Support Command Center" }),
  },
  // Demo only: in-memory state forgets every thread on restart, so each reply would start a new
  // conversation. Use a durable store such as `createRedisState()` in production.
  state: () => createMemoryState(),
  // A closed inbox: only these senders, and only mail that passes DMARC at the receiving server.
  senders: {
    allow: (process.env.SUPPORT_EMAIL_ALLOW ?? "@example.com").split(",").map((entry) => entry.trim()),
    authServId: SUPPORT_EMAIL_AUTHSERV_ID,
  },
  // Like Discord, email stays away from the heavier refund and escalation tools.
  toolPolicy: { deny: ["evaluate-refund-policy", "create-escalation"] },
});
