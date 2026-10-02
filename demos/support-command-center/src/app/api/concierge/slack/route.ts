import { after } from "next/server";
import { getConciergeSlackConnector } from "./connector";

/**
 * Real Slack Events webhook for the concierge. Point your Slack app's request URL
 * (or socket-mode forwarder) here. See agents/concierge/SLACK_SETUP.md.
 */
export async function POST(request: Request) {
  const connector = await getConciergeSlackConnector();
  return connector.webhook(request, {
    waitUntil: (task) => after(() => task),
  });
}
