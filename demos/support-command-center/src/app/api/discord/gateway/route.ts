import { after } from "next/server";
import { getDiscordConnector } from "../connector";
import {
  authorizeDiscordGatewayRequest,
  discordGatewayDurationMs,
  discordGatewayWebhookUrl,
  isDiscordGatewayAdapter,
} from "./gateway-policy";

export const maxDuration = 800;

export async function GET(request: Request): Promise<Response> {
  const authFailure = authorizeDiscordGatewayRequest(request);
  if (authFailure !== null) {
    return authFailure;
  }

  const connector = await getDiscordConnector();
  if (!isDiscordGatewayAdapter(connector.adapter)) {
    return new Response("Loaded Discord adapter does not support Gateway listener", { status: 500 });
  }

  return connector.adapter.startGatewayListener(
    { waitUntil: (task) => after(() => task) },
    discordGatewayDurationMs(),
    request.signal,
    discordGatewayWebhookUrl(request),
  );
}
