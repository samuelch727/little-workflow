import { after } from "next/server";
import { getEmailConnector } from "./connector";

// Resend's `email.received` webhook. The adapter verifies the signature, fetches the email, and
// answers 200 at once; the agent runs and replies after the response through `waitUntil`.
export async function POST(request: Request) {
  const connector = await getEmailConnector();
  return connector.webhook(request, {
    waitUntil: (task) => after(() => task),
  });
}
