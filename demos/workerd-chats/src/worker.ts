import { DurableObject } from "cloudflare:workers";
import {
  answerInputRequest, createHarness, generateHarness, HarnessInputError, listInputRequests,
  resumeParked, virtualHost, type HarnessEvent, type HarnessTurnResult, type HumanInputAnswer,
} from "@little-stack/harness";
import { createLittleDB, type HarnessTracer } from "@little-stack/littledb";
import {
  dynamicWorkflows, virtualWorld, type DynamicWorkflowWorldContext, type EventEnvelope, type World,
} from "@little-stack/workflow";
import { jsonSchema, tool, type UIMessage } from "ai";
import { ChatFiles } from "./chat-files.js";
import { ChatStore } from "./chat-store.js";
import { chatModel } from "./model.js";

type Env = {
  CHAT: DurableObjectNamespace<Chat>;
  DEEPSEEK_API_KEY?: string;
  MODEL_BASE_URL?: string;
  MODEL_NAME?: string;
  MODEL_API_KEY?: string;
  LITTLEDB_URL?: string;
  LITTLEDB_API_KEY?: string;
  /** Smaller retention can be used to exercise pruning locally. Default: 5000. */
  TRACE_LIMIT?: string;
};

type MessageRow = { seq: number; role: string; text: string };
type LocalTraceEvent =
  | (HarnessEvent & { source: "harness" })
  | (EventEnvelope & { source: "workflow"; sessionId: string; turnId: string });
const ACTIONS = new Set(["messages", "answers", "files", "trace"]);

// Each chat id gets its own Durable Object, filesystem, ledgers and turn order.
export default {
  async fetch(request, env) {
    const [, route, chatId, action, extra] = new URL(request.url).pathname.split("/");
    if (route !== "chats" || !chatId || !action || !ACTIONS.has(action) || extra !== undefined) {
      return new Response("Not found", { status: 404 });
    }
    return env.CHAT.get(env.CHAT.idFromName(chatId)).fetch(request);
  },
} satisfies ExportedHandler<Env>;

/** One chat. SQLite owns its saved files, history, orchestration ledgers and trace cursor. */
export class Chat extends DurableObject<Env> {
  private readonly files = new ChatFiles(this.ctx.storage);
  private readonly host = virtualHost({ fs: this.files.open(), store: new ChatStore(this.ctx.storage.sql) });
  private readonly harness = createHarness({
    host: this.host,
    model: chatModel(this.env),
    humanInput: true,
    dynamicWorkflows: dynamicWorkflows({ world: (context) => this.workflowWorld(context) }),
    tools: {
      word_count: tool({
        description: "Count whitespace-separated words in text.",
        inputSchema: jsonSchema<{ text: string }>({
          type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false,
        }),
        execute: async ({ text }) => ({ count: text.trim() === "" ? 0 : text.trim().split(/\s+/u).length }),
      }),
    },
    system: "You are working in this chat's files with bash. Keep notes and outputs in /session.",
  });
  private readonly tracer: HarnessTracer | undefined;
  private readonly traceLimit: number;
  private turns: Promise<unknown> = Promise.resolve();
  private exportErrorLogged = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY, role TEXT NOT NULL, text TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS trace_events (id INTEGER PRIMARY KEY AUTOINCREMENT, sequence INTEGER NOT NULL, type TEXT NOT NULL, json TEXT NOT NULL)");
    const limit = Number(env.TRACE_LIMIT || 5000);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("TRACE_LIMIT must be a positive integer");
    this.traceLimit = limit;
    // No default URL and no client construction for a missing or partial setting.
    if (env.LITTLEDB_URL && env.LITTLEDB_API_KEY) {
      try {
        this.tracer = createLittleDB({
          url: env.LITTLEDB_URL,
          apiKey: env.LITTLEDB_API_KEY,
          onError: () => this.logExportError(),
        }).harnessTracer({ harness: "workerd-chats" });
      } catch {
        this.logExportError();
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.split("/")[3];
    if (request.method === "GET" && action === "trace") {
      const raw = url.searchParams.get("after") ?? "0";
      const after = Number(raw);
      if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(after)) return Response.json({ error: "after must be a non-negative integer" }, { status: 400 });
      const events = this.ctx.storage.sql.exec<{ id: number; json: string }>(
        "SELECT id, json FROM trace_events WHERE id > ? ORDER BY id", after,
      ).toArray().map(({ id, json }) => {
        const event = JSON.parse(json) as LocalTraceEvent;
        return { ...event, source: event.source ?? "harness", id };
      });
      return Response.json({ events });
    }
    if (request.method === "GET" && action === "files") {
      const session = await this.host.sessions.getOrCreate({ id: "chat" });
      const entries = await session.files.list("/session", { recursive: true });
      return Response.json({ files: entries.filter((entry) => entry.kind === "file") });
    }
    if (request.method === "GET" && action === "messages") return Response.json({ messages: this.history() });
    if (request.method !== "POST" || (action !== "messages" && action !== "answers")) {
      return new Response("Method not allowed", { status: 405 });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Expected JSON" }, { status: 400 });
    }
    if (!isObject(body)) return Response.json({ error: "Expected an object" }, { status: 400 });
    let run: () => Promise<unknown>;
    if (action === "messages") {
      if (typeof body.text !== "string") return Response.json({ error: "text must be a string" }, { status: 400 });
      const text = body.text;
      run = () => this.reply(text);
    } else {
      if (typeof body.requestId !== "string" || !isObject(body.answer)) return Response.json({ error: "Expected requestId and answer" }, { status: 400 });
      const requestId = body.requestId;
      const answer = body.answer as HumanInputAnswer;
      run = () => this.answer(requestId, answer);
    }
    // Answers use the same queue as messages and persist before HTTP success.
    const turn = this.turns.then(run);
    this.turns = turn.catch(() => undefined);
    try {
      return Response.json(await turn);
    } catch (error) {
      if (error instanceof HarnessInputError) return Response.json({ error: error.message }, { status: 400 });
      throw error;
    }
  }

  private history(): MessageRow[] {
    return this.ctx.storage.sql.exec<MessageRow>("SELECT seq, role, text FROM messages ORDER BY seq").toArray();
  }

  private async reply(text: string) {
    const messages: UIMessage[] = this.history().map((row) => ({
      id: `m${row.seq}`, role: row.role === "user" ? "user" : "assistant", parts: [{ type: "text", text: row.text }],
    }));
    messages.push({ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] });
    const events: HarnessEvent[] = [];
    try {
      const result = await generateHarness({
        harness: this.harness, session: "chat", messages,
        onEvent: (event) => this.recordEvent(event, events),
      });
      this.ctx.storage.sql.exec("INSERT INTO messages (role, text) VALUES ('user', ?)", text);
      if (result.status === "completed") {
        this.ctx.storage.sql.exec("INSERT INTO messages (role, text) VALUES ('assistant', ?)", result.text);
      }
      return await this.response(result, events);
    } finally {
      await this.files.save();
      this.flushTraces();
    }
  }

  private async answer(requestId: string, answer: HumanInputAnswer) {
    const events: HarnessEvent[] = [];
    try {
      await answerInputRequest({ harness: this.harness, sessionId: "chat", requestId, answer });
      const resumed = await resumeParked({
        harness: this.harness, sessionId: "chat",
        onEvent: (event) => this.recordEvent(event, events),
        onResult: async (result) => {
          if (result.status === "completed") this.ctx.storage.sql.exec("INSERT INTO messages (role, text) VALUES ('assistant', ?)", result.text);
        },
      });
      if (resumed.failed.length > 0) throw resumed.failed[0]!.error;
      const result = resumed.resumed.at(-1)?.result;
      return result === undefined
        ? { status: "answered", requests: await listInputRequests({ harness: this.harness, sessionId: "chat" }), events: [] }
        : await this.response(result, events);
    } finally {
      await this.files.save();
      this.flushTraces();
    }
  }

  private async response(result: HarnessTurnResult<unknown>, events: HarnessEvent[]) {
    return {
      status: result.status,
      reply: result.status === "completed" ? result.text : "[parked]",
      ...(result.status === "parked" ? { requests: await listInputRequests({ harness: this.harness, sessionId: "chat" }) } : {}),
      events: events.map(({ type, sequence }) => ({ type, sequence })),
    };
  }

  private async recordEvent(event: HarnessEvent, events: HarnessEvent[]): Promise<void> {
    this.appendLocalTrace({ ...event, source: "harness" });
    events.push(event);
    try {
      await this.tracer?.onEvent(event);
    } catch {
      this.logExportError();
    }
  }

  private appendLocalTrace(event: LocalTraceEvent): void {
    if (!Number.isSafeInteger(event.sequence)) throw new Error("Expected a numbered trace event");
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("INSERT INTO trace_events (sequence, type, json) VALUES (?, ?, ?)", event.sequence!, event.type, JSON.stringify(event));
      this.ctx.storage.sql.exec("DELETE FROM trace_events WHERE id <= (SELECT id FROM trace_events ORDER BY id DESC LIMIT 1 OFFSET ?)", this.traceLimit);
    });
  }

  private workflowWorld(context: DynamicWorkflowWorldContext): World {
    if (context.fs === undefined) throw new Error("The workerd workflow needs its host data filesystem");
    const inner = virtualWorld({ fs: context.fs, dataDir: context.dataDir });
    const appendEvent: World["appendEvent"] = async (runId, event) => {
      const envelope = await inner.appendEvent(runId, event);
      // Observe the real World envelope; its per-run sequence is not a Harness
      // sequence. Only the SQLite id orders the two sources together.
      this.appendLocalTrace({ ...envelope, source: "workflow", sessionId: context.sessionId, turnId: context.turnId });
      return envelope;
    };
    return new Proxy(inner, {
      get(target, property) {
        if (property === "appendEvent") return appendEvent;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  private flushTraces(): void {
    if (this.tracer) this.ctx.waitUntil(this.tracer.flush().catch(() => this.logExportError()));
  }

  private logExportError(): void {
    if (this.exportErrorLogged) return;
    this.exportErrorLogged = true;
    console.warn("LittleDB trace export failed for this chat; local traces are still kept.");
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
