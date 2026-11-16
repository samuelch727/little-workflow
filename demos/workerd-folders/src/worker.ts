import { scriptedModel } from "./model.js";
import { persistTurn } from "./persist-turn.js";
import { DurableObject } from "cloudflare:workers";
import { generateHarness, virtualHost, type UIMessage } from "@little-stack/harness";
import { agents, loadHarness } from "./agents.generated.js";
import { retryable } from "./retryable.js";
import { ChatFiles } from "./chat-files.js";

type Env = { CHAT: DurableObjectNamespace<Chat> };
export default { async fetch(request, env) {
  const [, a, agent, c, chat, action, extra] = new URL(request.url).pathname.split("/");
  if (a !== "agents" || !agent || !agents.includes(agent) || c !== "chats" || !chat || action !== "messages" || extra !== undefined) return new Response("Not found", { status: 404 });
  // Tuple encoding avoids collisions between agent names and chat IDs.
  return env.CHAT.get(env.CHAT.idFromName(JSON.stringify([agent, chat]))).fetch(request);
} } satisfies ExportedHandler<Env>;

export class Chat extends DurableObject<Env> {
  private readonly files = new ChatFiles(this.ctx.storage);
  private readonly host = virtualHost({ fs: this.files.open() });
  private readonly results: { chatSessionId: string; count: number }[] = [];
  private eventCount = 0;
  private readonly getHarness = retryable((key: string) => {
    const [agent, chatSessionId] = JSON.parse(key) as [string, string];
    return loadHarness(agent, { host: this.host, context: {
      env: { createModel: scriptedModel, privateToken: "synthetic-context-only" },
      chatSessionId,
      onResult: (result: { chatSessionId: string; count: number }) => { this.results.push(result); },
      onEvent: () => { this.eventCount++; },
    } });
  });
  private turns: Promise<unknown> = Promise.resolve();
  async fetch(request: Request): Promise<Response> {
    if (request.method === "GET") return Response.json({ messages: await this.ctx.storage.get("messages") ?? [], results: this.results, eventCount: this.eventCount });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    let body: { text?: unknown };
    try { body = await request.json(); } catch { return new Response("Expected JSON", { status: 400 }); }
    if (!body || typeof body.text !== "string") return new Response("Expected text", { status: 400 });
    const text = body.text;
    const agent = new URL(request.url).pathname.split("/")[2]!;
    const turn = this.turns.then(async () => {
      const chat = new URL(request.url).pathname.split("/")[4]!;
      const harness = await this.getHarness(JSON.stringify([agent, chat]));
      const messages = await this.ctx.storage.get<UIMessage[]>("messages") ?? [];
      messages.push({ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] });
      // Persist the user attempt before execution. Partial writes on failure are saved in
      // persistence cleanup, so they cannot silently appear only on a later successful turn.
      await this.ctx.storage.put("messages", messages);
      return persistTurn(async () => {
        const result = await generateHarness({ harness, session: "chat", messages });
        if (result.status !== "completed") throw new Error("Unexpected parked turn");
        messages.push({ id: crypto.randomUUID(), role: "assistant", parts: [{ type: "text", text: result.text }] });
        await this.ctx.storage.put("messages", messages);
        return Response.json({ reply: result.text });
      }, () => this.files.save());
    });
    this.turns = turn.catch(() => undefined);
    return turn;
  }
}
