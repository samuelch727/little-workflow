import { NextResponse } from "next/server";
import { runWebChatDemoTurn, type ConnectorChatDemoInput } from "../runner";

function connectorChatDemoInput(body: unknown): ConnectorChatDemoInput | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const message = (body as { message?: unknown }).message;
  if (typeof message !== "string" || message.trim().length === 0) return undefined;
  return { message };
}

export async function POST(request: Request) {
  const body = connectorChatDemoInput(await request.json().catch(() => undefined));
  if (body === undefined) {
    return NextResponse.json({ error: "Message is required." }, { status: 400 });
  }
  return NextResponse.json(await runWebChatDemoTurn(body));
}
