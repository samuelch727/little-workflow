import { after } from "next/server";
import { getDiscordConnector } from "./connector";

export async function POST(request: Request) {
  const connector = await getDiscordConnector();
  return connector.webhook(request, {
    waitUntil: (task) => after(() => task),
  });
}
