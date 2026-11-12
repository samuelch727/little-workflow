import { DurableObject } from "cloudflare:workers";
import {
  answerInputRequest, createHarness, generateHarness, HarnessInputError, listInputRequests,
  resumeParked, streamHarness, virtualHost, type HarnessEvent, type HarnessTurnResult, type HumanInputAnswer,
} from "@little-stack/harness";
import { createLittleDB, type HarnessTracer } from "@little-stack/littledb";
import { remoteTools } from "@little-stack/harness/remote-tools";
import {
  dynamicWorkflows, virtualWorld, type DynamicWorkflowWorldContext, type EventEnvelope, type World,
} from "@little-stack/workflow";
import { createUIMessageStreamResponse, jsonSchema, tool, type UIMessage, type UIMessageChunk } from "ai";
import { ChatFiles } from "./chat-files.js";
import { ChatStore } from "./chat-store.js";
import { chatModel } from "./model.js";
import { ordersLookup } from "./remote-contracts.js";

type Env = {
  CHAT: DurableObjectNamespace<Chat>;
  DEEPSEEK_API_KEY?: string;
  MODEL_BASE_URL?: string;
  MODEL_NAME?: string;
  MODEL_API_KEY?: string;
  LITTLEDB_URL?: string;
  LITTLEDB_API_KEY?: string;
  DATA_API: Fetcher;
  DATA_API_TOKEN?: string;
  /** Smaller retention can be used to exercise pruning locally. Default: 5000. */
  TRACE_LIMIT?: string;
  /** Test fixtures only; deliberately absent from the shipped workerd.capnp. */
  TEST_FAULTS?: string;
};

type TestFaults = { failAfterDrainFor?: string; saveDelayMs?: number };

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
      ...(this.env.DATA_API_TOKEN ? remoteTools([ordersLookup], {
        endpoint: this.env.DATA_API,
        scope: this.ctx.id.toString(),
        headers: { authorization: `Bearer ${this.env.DATA_API_TOKEN}` },
      }) : {}),
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
      if (request.headers.get("accept")?.split(",").some((type) => type.split(";")[0]?.trim() === "text/event-stream") || url.searchParams.get("stream") === "1") {
        return this.streamReply(text);
      }
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

  private messages(text: string): UIMessage[] {
    const messages: UIMessage[] = this.history().map((row) => ({
      id: `m${row.seq}`, role: row.role === "user" ? "user" : "assistant", parts: [{ type: "text", text: row.text }],
    }));
    messages.push({ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] });
    return messages;
  }

  private async reply(text: string) {
    const events: HarnessEvent[] = [];
    try {
      const result = await generateHarness({
        harness: this.harness, session: "chat", messages: this.messages(text),
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

  private streamReply(text: string): Response {
    let connected = true;
    let controller: ReadableStreamDefaultController<UIMessageChunk>;
    const stream = new ReadableStream<UIMessageChunk>({
      start(value) { controller = value; },
      // Leaving the page stops delivery, not the server-owned turn or its save.
      cancel() { connected = false; },
    });
    // Deliberately buffer chat-sized turns for slow readers so delivery cannot
    // stall execution or persistence; this is not a bounded transport queue.
    const forward = (chunk: UIMessageChunk) => {
      if (!connected) return;
      try { controller.enqueue(chunk); } catch { connected = false; }
    };
    // This one completion owns the queue slot and the Durable Object lifetime,
    // including after a canceled response. Consumer backpressure never drives it.
    const completion = this.turns.then(async () => {
      try {
        forward(await this.runStreamedReply(text, forward));
      } catch {
        forward({ type: "error", errorText: "The turn failed." });
      } finally {
        if (connected) {
          try { controller.close(); } catch { connected = false; }
        }
      }
    });
    this.turns = completion.catch(() => undefined);
    this.ctx.waitUntil(this.turns);
    return createUIMessageStreamResponse({ stream });
  }

  private async runStreamedReply(text: string, forward: (chunk: UIMessageChunk) => void): Promise<UIMessageChunk> {
    const faults: TestFaults = this.env.TEST_FAULTS ? JSON.parse(this.env.TEST_FAULTS) as TestFaults : {};
    const events: HarnessEvent[] = [];
    let finish: Extract<UIMessageChunk, { type: "finish" }> | undefined;
    let parked = false;
    let streamFailed = false;
    try {
      const turn = streamHarness({
        harness: this.harness, session: "chat", messages: this.messages(text),
        onEvent: (event) => this.recordEvent(event, events),
        uiMessageStream: { onError: () => "The turn failed." },
      });
      const reader = (turn.toUIMessageStream() as ReadableStream<UIMessageChunk>).getReader();
      const drain = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value.type === "finish") finish = value;
            else if (value.type === "error") streamFailed = true;
            else forward(value);
          }
        } finally {
          reader.releaseLock();
        }
      };
      // A read failure must still await the harness's failure bookkeeping before
      // releasing the chat. Neither branch is allowed to short-circuit the other.
      const [drained, finished] = await Promise.allSettled([drain(), turn.finished]);
      if (drained.status === "rejected") throw drained.reason;
      if (finished.status === "rejected") throw finished.reason;
      if (streamFailed || finish === undefined) throw new Error("The UI stream did not finish successfully");
      if (faults.failAfterDrainFor === text) throw new Error("Injected after-drain failure");
      parked = finished.value.status === "parked";
      const reply = finished.value.status === "completed" ? await turn.text : undefined;
      this.ctx.storage.sql.exec("INSERT INTO messages (role, text) VALUES ('user', ?)", text);
      if (reply !== undefined) this.ctx.storage.sql.exec("INSERT INTO messages (role, text) VALUES ('assistant', ?)", reply);
    } finally {
      try {
        if (faults.saveDelayMs) await new Promise((resolve) => setTimeout(resolve, faults.saveDelayMs));
        await this.files.save();
      } finally {
        this.flushTraces();
      }
    }
    // The upstream finish preceded harness finalization; only now is it safe to
    // expose success. The SDK response helper appends [DONE] when we close.
    if (parked) {
      return {
        ...finish,
        messageMetadata: {
          ...(isObject(finish.messageMetadata) ? finish.messageMetadata : {}),
          status: "parked",
          requests: await listInputRequests({ harness: this.harness, sessionId: "chat" }),
        },
      };
    }
    return finish;
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
      events: events.map(({ type, sequence, sessionId, turnId, metadata }) => ({
        type, sequence,
        // Explicit ID-only projection. Never forward command text, output or raw metadata.
        ...((type.startsWith("harness.runtime.command.") || type.startsWith("harness.runtime.tier.")) ? {
          sessionId,
          ...(turnId === undefined ? {} : { turnId }),
          ...(typeof metadata?.executionId === "string" ? { executionId: metadata.executionId } : {}),
          ...(typeof metadata?.toolCallId === "string" ? { toolCallId: metadata.toolCallId } : {}),
        } : {}),
      })),
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
