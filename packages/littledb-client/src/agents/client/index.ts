/**
 * Connect a website to a LittleDB agent with its connection URL.
 *
 * ```ts
 * const patient = littleAgent("https://agents.example.com/c/lc_...");
 *
 * // React and AI SDK: the URL is the whole backend.
 * const chat = useChat({ id, transport: patient.transport({ tools, context: { caseId } }) });
 *
 * // No framework:
 * const chat = patient.chat({ tools, onChange: render });
 * await chat.send("Hello doctor");
 * ```
 *
 * Tools that change the page are defined here, next to the UI they change: `uiTool` gives the
 * model a description and an input schema, and `run` does the work in the browser. The agent's
 * turn waits for the result, so the model knows what happened.
 *
 * No dependencies (AI SDK's types only, nothing at runtime); also served by the service as
 * `/client.js` for pages without a bundler.
 */
import type { ChatTransport, UIMessage, UIMessageChunk as AIUIMessageChunk } from "ai";
import type { ChatRequestBody, ChatSummary, ConnectionInfo, JsonSchema, PageToolSpec, WireUIMessage } from "../protocol.js";

export type { AgentLimitError, AgentLimitErrorCode, ChatSummary, ConnectionInfo, GitHubPullRequestContext } from "../protocol.js";

/** An HTTP error from the service, including limit details a page can use to offer a retry. */
export class LittleAgentError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(message: string, status: number, details: { code?: string | undefined; retryAfterSeconds?: number | undefined } = {}) {
    super(message);
    this.name = "LittleAgentError";
    this.status = status;
    this.code = details.code;
    this.retryAfterSeconds = details.retryAfterSeconds;
  }
}

/** A Standard Schema with JSON Schema output (Zod 4, Valibot, ArkType), or plain JSON Schema. */
export type ToolInputSchema<T> =
  | {
      readonly "~standard": {
        readonly validate: (value: unknown) => { value: T; issues?: undefined } | { issues: readonly { message: string }[] } | Promise<{ value: T; issues?: undefined } | { issues: readonly { message: string }[] }>;
        readonly jsonSchema?: { readonly input: (options: { target: string }) => JsonSchema };
      };
    }
  | JsonSchema;

export type ToolRunContext = {
  readonly toolCallId: string;
  readonly chatId: string;
  readonly signal: AbortSignal | undefined;
};

/** A tool the page defines: the model sees `description` and `input`, the browser runs `run`. */
export type UITool<TInput = any, TOutput = unknown> = {
  readonly kind: "ui-tool";
  readonly description: string;
  readonly input: ToolInputSchema<TInput> | undefined;
  readonly run: (input: TInput, context: ToolRunContext) => TOutput | Promise<TOutput>;
};

/** What `tools` takes: page-defined `uiTool`s, and plain functions that run the agent's own client tools. */
export type PageTools = Readonly<Record<string, UITool | ((input: any, context: ToolRunContext) => unknown)>>;

export function uiTool<TInput = any, TOutput = unknown>(definition: {
  description: string;
  input?: ToolInputSchema<TInput>;
  run: (input: TInput, context: ToolRunContext) => TOutput | Promise<TOutput>;
}): UITool<TInput, TOutput> {
  return { kind: "ui-tool", description: definition.description, input: definition.input, run: definition.run };
}

export type LittleAgentOptions = {
  /**
   * Who the user is. A signed token from your backend (`lut1....`), or a function returning one.
   * Omit it for anonymous visitors: a random id kept in this browser.
   */
  readonly user?: string | (() => string | Promise<string>) | undefined;
  readonly fetch?: typeof fetch | undefined;
};

export type ChatOptions = {
  /** Tools this page runs. */
  readonly tools?: PageTools | undefined;
  /** Sent with every message; the agent's code reads it as `extraBody` (a case id, the current page). */
  readonly context?: Readonly<Record<string, unknown>> | (() => Readonly<Record<string, unknown>>) | undefined;
};

/** The parts of an AI SDK `UIMessageChunk` this client reads. */
export type UIMessageChunk = { readonly type: string; readonly [key: string]: unknown };

/** AI SDK's `ChatTransport`, what `useChat({ transport })` takes. */
export type LittleChatTransport = ChatTransport<UIMessage>;

export type LittleAgent = {
  readonly url: string;
  /** Which agent, branch and version the URL serves, and the client tools it declares. */
  info(): Promise<ConnectionInfo>;
  /** For AI SDK's `useChat({ transport })` (React, Vue, Svelte). */
  transport(options?: ChatOptions): LittleChatTransport;
  /** A chat without a framework. */
  chat(options?: ChatOptions & { id?: string; onChange?: (messages: WireUIMessage[], status: ChatStatus) => void }): LittleChat;
  /** The user's chats with this agent, newest first. */
  chats(): Promise<ChatSummary[]>;
  /** A chat's messages, to show it again (`useChat({ messages })`). Traced replies carry `metadata.littledb.traceId`. */
  history(chatId: string): Promise<UIMessage[]>;
  deleteChat(chatId: string): Promise<void>;
};

export type ChatStatus = "ready" | "streaming" | "error";

export type LittleChat = {
  readonly id: string;
  /** Traced assistant replies carry `metadata.littledb.traceId`, including partial stopped replies. */
  readonly messages: readonly WireUIMessage[];
  readonly status: ChatStatus;
  readonly error: string | undefined;
  /** The original error; an HTTP refusal is a LittleAgentError with code and retryAfterSeconds. */
  readonly errorDetails: Error | undefined;
  /** Sends a user message and resolves when the agent's turn ends. */
  send(text: string): Promise<void>;
  /** Loads the chat's earlier messages from the service. */
  load(): Promise<void>;
  stop(): void;
};

export function littleAgent(url: string, options: LittleAgentOptions = {}): LittleAgent {
  const base = url.replace(/\/+$/, "");
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  const userHeader = async (): Promise<string> => {
    const user = typeof options.user === "function" ? await options.user() : options.user;
    return user ?? anonymousId(base);
  };
  const request = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const response = await doFetch(`${base}${path}`, {
      ...init,
      headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), "x-little-user": await userHeader(), ...(init.headers as Record<string, string> | undefined) },
    });
    if (!response.ok) {
      const value: unknown = await response.json().catch(() => ({}));
      const body = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
      throw new LittleAgentError(typeof body.error === "string" ? body.error : `${response.status} ${response.statusText}`, response.status, {
        code: typeof body.code === "string" ? body.code : undefined,
        retryAfterSeconds: typeof body.retryAfterSeconds === "number" && Number.isFinite(body.retryAfterSeconds) && body.retryAfterSeconds >= 0 ? body.retryAfterSeconds : undefined,
      });
    }
    return response;
  };

  /** Posts one turn and returns its chunks, running the page's tools as their calls arrive. */
  const turn = async (chatId: string, message: WireUIMessage, chatOptions: ChatOptions, signal: AbortSignal | undefined): Promise<ReadableStream<UIMessageChunk>> => {
    const tools = chatOptions.tools ?? {};
    const context = typeof chatOptions.context === "function" ? chatOptions.context() : chatOptions.context;
    const body: ChatRequestBody = {
      chatId,
      message,
      tools: pageToolSpecs(tools),
      implements: Object.entries(tools)
        .filter(([, value]) => typeof value === "function")
        .map(([name]) => name),
      ...(context === undefined ? {} : { context }),
    };
    const response = await request("/chat", { method: "POST", body: JSON.stringify(body), ...(signal === undefined ? {} : { signal }) });
    const runTool = async (chunk: UIMessageChunk) => {
      const toolName = String(chunk.toolName);
      const toolCallId = String(chunk.toolCallId);
      const entry = tools[toolName];
      if (entry === undefined) return;
      let result: { output?: unknown; error?: string };
      try {
        const run = typeof entry === "function" ? entry : entry.run;
        const input = typeof entry === "function" ? chunk.input : await validate(entry.input, chunk.input);
        result = { output: (await run(input, { toolCallId, chatId, signal })) ?? null };
      } catch (error) {
        result = { error: error instanceof Error ? error.message : String(error) };
      }
      await request(`/chats/${encodeURIComponent(chatId)}/tool-results`, { method: "POST", body: JSON.stringify({ toolCallId, ...result }) }).catch(() => undefined);
    };
    return sseChunks(response.body!).pipeThrough(
      new TransformStream<UIMessageChunk, UIMessageChunk>({
        transform(chunk, controller) {
          controller.enqueue(chunk);
          if (chunk.type === "tool-input-available" && typeof chunk.toolName === "string" && tools[chunk.toolName] !== undefined) {
            void runTool(chunk);
          }
        },
      }),
    );
  };

  const agent: LittleAgent = {
    url: base,
    info: async () => (await (await request("")).json()) as ConnectionInfo,
    chats: async () => ((await (await request("/chats")).json()) as { chats: ChatSummary[] }).chats,
    history: async (chatId) => uiMessages(((await (await request(`/chats/${encodeURIComponent(chatId)}`)).json()) as { messages?: unknown }).messages),
    deleteChat: async (chatId) => {
      await request(`/chats/${encodeURIComponent(chatId)}`, { method: "DELETE" });
    },
    transport: (chatOptions = {}) => ({
      sendMessages: async ({ chatId, messages, abortSignal }) => {
        const last = messages[messages.length - 1];
        if (last === undefined || last.role !== "user") throw new Error("The last message must be the user's.");
        // The service streams AI SDK's own chunks (createUIMessageStreamResponse).
        return (await turn(chatId, last, chatOptions, abortSignal)) as ReadableStream<AIUIMessageChunk>;
      },
      reconnectToStream: async () => null,
    }),
    chat: (chatOptions = {}) => {
      const id = chatOptions.id ?? randomId("chat");
      let messages: WireUIMessage[] = [];
      let status: ChatStatus = "ready";
      let error: string | undefined;
      let errorDetails: Error | undefined;
      let controller: AbortController | undefined;
      let sent = 0;
      const changed = () => chatOptions.onChange?.(messages, status);
      const chat: LittleChat = {
        id,
        get messages() {
          return messages;
        },
        get status() {
          return status;
        },
        get error() {
          return error;
        },
        get errorDetails() {
          return errorDetails;
        },
        load: async () => {
          const at = sent;
          const loaded = await agent.history(id);
          // A message sent while the history loaded wins: the history is older.
          if (at !== sent) return;
          messages = loaded;
          changed();
        },
        stop: () => controller?.abort(),
        send: async (text) => {
          const user: WireUIMessage = { id: randomId("msg"), role: "user", parts: [{ type: "text", text }] };
          sent += 1;
          const before = messages;
          messages = [...before, user];
          status = "streaming";
          error = undefined;
          errorDetails = undefined;
          changed();
          controller = new AbortController();
          const assistant = new MessageBuilder(randomId("msg"));
          try {
            const chunks = await turn(id, user, chatOptions, controller.signal);
            const reader = chunks.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value.type === "error") {
                error = String(value.errorText ?? "The agent failed.");
                errorDetails = new Error(error);
              }
              assistant.apply(value);
              messages = [...before, user, assistant.message];
              changed();
            }
            status = error === undefined ? "ready" : "error";
          } catch (caught) {
            status = "error";
            errorDetails = caught instanceof Error ? caught : new Error(String(caught));
            error = errorDetails.message;
          }
          changed();
        },
      };
      return chat;
    },
  };
  return agent;
}

/**
 * A chat's history as AI SDK messages. The service keeps them as the turns sent and streamed
 * them, without looking inside; a message or part that is not one (a client sent it malformed)
 * is left out rather than handed to the page.
 */
function uiMessages(value: unknown): UIMessage[] {
  if (!Array.isArray(value)) throw new Error("The service sent no messages.");
  const record = (item: unknown): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item);
  return value.flatMap((message: unknown) => {
    if (!record(message) || typeof message.id !== "string" || !Array.isArray(message.parts)) return [];
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "system") return [];
    const parts = message.parts.filter((part: unknown) => record(part) && typeof part.type === "string");
    return [{ ...message, parts } as UIMessage];
  });
}

/** The page tools a request declares: only `uiTool`s; plain functions implement the agent's own. */
function pageToolSpecs(tools: PageTools): PageToolSpec[] {
  const specs: PageToolSpec[] = [];
  for (const [name, entry] of Object.entries(tools)) {
    if (typeof entry === "function") continue;
    specs.push({ name, description: entry.description, inputSchema: toJsonSchema(entry.input) });
  }
  return specs;
}

function toJsonSchema(schema: ToolInputSchema<unknown> | undefined): JsonSchema {
  if (schema === undefined) return { type: "object", properties: {} };
  const standard = (schema as { "~standard"?: { jsonSchema?: { input: (o: { target: string }) => JsonSchema } } })["~standard"];
  if (standard !== undefined) {
    if (standard.jsonSchema === undefined) throw new Error("This schema library does not produce JSON Schema; pass a JSON Schema object instead.");
    return standard.jsonSchema.input({ target: "draft-07" });
  }
  return schema as JsonSchema;
}

async function validate<T>(schema: ToolInputSchema<T> | undefined, input: unknown): Promise<T> {
  const standard = (schema as { "~standard"?: { validate: (v: unknown) => unknown } } | undefined)?.["~standard"];
  if (standard === undefined) return input as T;
  const result = (await standard.validate(input)) as { value?: T; issues?: readonly { message: string }[] };
  if (result.issues !== undefined) throw new Error(`Invalid input: ${result.issues.map((issue) => issue.message).join("; ")}`);
  return result.value as T;
}

/** Parses an SSE body of `data: <json>` events into chunks. */
export function sseChunks(body: ReadableStream<Uint8Array>): ReadableStream<UIMessageChunk> {
  const decoder = new TextDecoder();
  let buffer = "";
  return body.pipeThrough(
    new TransformStream<Uint8Array, UIMessageChunk>({
      transform(bytes, controller) {
        buffer += decoder.decode(bytes, { stream: true });
        let index: number;
        while ((index = buffer.indexOf("\n\n")) !== -1) {
          const event = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const data = event
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data === "" || data === "[DONE]") continue;
          try {
            controller.enqueue(JSON.parse(data) as UIMessageChunk);
          } catch {
            // A malformed event: skip it rather than end the turn.
          }
        }
      },
    }),
  );
}

/** Builds an assistant `UIMessage` from its stream of chunks, the way AI SDK's `useChat` does. */
export class MessageBuilder {
  #id: string;
  #metadata: unknown;
  readonly #parts: Record<string, unknown>[] = [];
  readonly #open = new Map<string, Record<string, unknown>>();
  readonly #tools = new Map<string, Record<string, unknown>>();

  constructor(id: string) {
    this.#id = id;
  }

  get message(): WireUIMessage {
    return { id: this.#id, role: "assistant", parts: this.#parts.map((part) => ({ ...part })), ...(this.#metadata === undefined ? {} : { metadata: this.#metadata }) };
  }

  apply(chunk: UIMessageChunk): void {
    switch (chunk.type) {
      case "start":
        if (typeof chunk.messageId === "string") this.#id = chunk.messageId;
        if (chunk.messageMetadata !== undefined) this.#metadata = chunk.messageMetadata;
        return;
      case "finish":
      case "message-metadata":
        if (chunk.messageMetadata !== undefined) this.#metadata = chunk.messageMetadata;
        return;
      case "start-step":
        this.#parts.push({ type: "step-start" });
        return;
      case "text-start":
      case "reasoning-start": {
        const part = { type: chunk.type === "text-start" ? "text" : "reasoning", text: "", state: "streaming" };
        this.#open.set(`${part.type}:${String(chunk.id)}`, part);
        this.#parts.push(part);
        return;
      }
      case "text-delta":
      case "reasoning-delta": {
        const part = this.#open.get(`${chunk.type === "text-delta" ? "text" : "reasoning"}:${String(chunk.id)}`);
        if (part !== undefined) part.text = String(part.text) + String(chunk.delta ?? "");
        return;
      }
      case "text-end":
      case "reasoning-end": {
        const part = this.#open.get(`${chunk.type === "text-end" ? "text" : "reasoning"}:${String(chunk.id)}`);
        if (part !== undefined) part.state = "done";
        return;
      }
      case "tool-input-start":
        this.#tool(chunk, { state: "input-streaming", input: undefined });
        return;
      case "tool-input-available":
        this.#tool(chunk, { state: "input-available", input: chunk.input });
        return;
      case "tool-input-error":
        this.#tool(chunk, { state: "output-error", input: chunk.input, errorText: chunk.errorText });
        return;
      case "tool-output-available":
        this.#tool(chunk, { state: "output-available", output: chunk.output });
        return;
      case "tool-output-error":
        this.#tool(chunk, { state: "output-error", errorText: chunk.errorText });
        return;
      default:
        if (chunk.type.startsWith("data-") || chunk.type === "source-url" || chunk.type === "source-document" || chunk.type === "file") {
          const { type, ...rest } = chunk;
          this.#parts.push({ type, ...rest });
        }
    }
  }

  #tool(chunk: UIMessageChunk, update: Record<string, unknown>): void {
    const id = String(chunk.toolCallId);
    let part = this.#tools.get(id);
    if (part === undefined) {
      const dynamic = chunk.dynamic === true;
      part = dynamic ? { type: "dynamic-tool", toolName: chunk.toolName, toolCallId: id } : { type: `tool-${String(chunk.toolName)}`, toolCallId: id };
      this.#tools.set(id, part);
      this.#parts.push(part);
    }
    Object.assign(part, update);
  }
}

/** An anonymous visitor's id, kept in this browser per agent URL. */
function anonymousId(base: string): string {
  const key = `little-agent-user:${base}`;
  try {
    const existing = globalThis.localStorage?.getItem(key);
    if (existing !== null && existing !== undefined) return existing;
    const created = `anon:${randomId("v").slice(2)}`;
    globalThis.localStorage?.setItem(key, created);
    return created;
  } catch {
    return (memoryIds[key] ??= `anon:${randomId("v").slice(2)}`);
  }
}

const memoryIds: Record<string, string> = {};

function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}_${[...bytes].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 20)}`;
}
