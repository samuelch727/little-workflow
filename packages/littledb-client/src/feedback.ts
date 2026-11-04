import {
  FeedbackRequestSchema,
  FeedbackResultSchema,
  FeedbackRetractedSchema,
  type FeedbackRequest,
  type FeedbackResult,
  type FeedbackRetracted,
} from "./contract.js";
import type { Exporter, LittleDBErrorHandler } from "./exporter.js";
import { LittleDBError, type Transport } from "./http.js";
import { isRecord, sha256Hex } from "./util.js";

/** One survey answer: yes or no, a number on a 2..10 scale, one of your choices, or free text. */
export type FeedbackAnswer =
  | { readonly question: string; readonly value: boolean }
  | { readonly question: string; readonly value: number; readonly scale: number }
  | { readonly question: string; readonly choice: string }
  | { readonly question: string; readonly text: string };

/** What an end user said about a turn: a thumbs, a rating, a comment, survey answers, or several. */
export type FeedbackInput = {
  /**
   * The turn the user reacted to: the trace the tracer wrote for it (`tracer.traceIdFor(sessionId)`
   * right after the turn, or `tracer.traceIdForTurn(sessionId, turnId)`). It does not have to be
   * sent yet; a click can arrive before the trace does.
   */
  readonly traceId?: string | undefined;
  /** With no `traceId`: the session's latest trace, for an end-of-conversation survey. */
  readonly sessionId?: string | undefined;
  /** Attach the feedback to one span of the trace instead of the whole turn. */
  readonly spanId?: string | undefined;
  /** The end user, pseudonymous: a hash of your own user id, never an email or a name. */
  readonly userId?: string | undefined;
  /**
   * A stable id, such as {@link feedbackId}`(userId, messageId)`. Sending again with the same id
   * replaces the earlier answer (a user changing their mind); `retractFeedback(id)` withdraws it.
   */
  readonly id?: string | undefined;
  /**
   * The order of changes to `id`, when a retry could arrive after a newer change: a whole number
   * that only grows (the time of the change in milliseconds, say), the same on every try.
   * LittleDB keeps the highest revision it has applied, a retraction's included, and answers an
   * older one with `stale: true`, changing nothing.
   */
  readonly revision?: number | undefined;
  /** The score name for `thumbs` or `rating`. Default `thumbs` / `rating`. */
  readonly name?: string | undefined;
  readonly thumbs?: "up" | "down" | undefined;
  /** A rating from 1 to `scale` (2..10, default 5). LittleDB stores it as 0..1. */
  readonly rating?: { readonly value: number; readonly scale?: number | undefined } | undefined;
  /** What the user wrote, up to 4000 characters. LittleDB's reviewer reads it as untrusted data. */
  readonly comment?: string | undefined;
  /** Groups the answers of one survey, e.g. `csat-v1`. */
  readonly survey?: string | undefined;
  /** Up to 20 survey answers; each becomes a score named after its question. */
  readonly answers?: readonly FeedbackAnswer[] | undefined;
  /** A few extra fields to keep with each score. */
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
};

export type { FeedbackResult, FeedbackRetracted };

/**
 * A stable feedback id for one user and one thing they reacted to (a message id, or something
 * like `survey:<sessionId>`). Hashed, so ids from different users can never collide and no id
 * is longer than LittleDB allows.
 */
export function feedbackId(userId: string, messageId: string): string {
  return `fb_${sha256Hex(JSON.stringify([userId, messageId])).slice(0, 32)}`;
}

/** Check feedback before it is sent: the request body, or the first problem as one line. */
export function checkFeedback(input: unknown): { ok: true; value: FeedbackRequest } | { ok: false; error: string } {
  const parsed = FeedbackRequestSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  if (issue === undefined) return { ok: false, error: "Invalid feedback." };
  const path = issue.path.map(String).join(".");
  return { ok: false, error: path.length === 0 ? issue.message : `${path}: ${issue.message}` };
}

/** How a retraction is ordered against the other changes to its id. */
export type RetractFeedbackOptions = {
  /** The retraction's revision (see {@link FeedbackInput.revision}). */
  readonly revision?: number | undefined;
};

export type FeedbackApi = {
  feedback(input: FeedbackInput): Promise<FeedbackResult>;
  retractFeedback(id: string, options?: RetractFeedbackOptions): Promise<FeedbackRetracted>;
};

export function createFeedbackApi(deps: { readonly transport: Transport; readonly exporter: Exporter }): FeedbackApi {
  return {
    async feedback(input) {
      const checked = checkFeedback(input);
      if (!checked.ok) throw new TypeError(`Invalid feedback: ${checked.error}`);
      // With only a session, LittleDB picks the session's latest trace: send the queued traces
      // first, so the turn the user just saw is there. A trace id needs no such wait.
      if (checked.value.traceId === undefined) await deps.exporter.flush();
      const raw = await deps.transport.request("POST", "/feedback", checked.value);
      return FeedbackResultSchema.parse(raw);
    },
    async retractFeedback(id, options = {}) {
      if (typeof id !== "string" || id.length === 0 || id.length > 200) {
        throw new TypeError("retractFeedback needs the feedback id it was sent with.");
      }
      const { revision } = options;
      if (revision !== undefined && !(Number.isSafeInteger(revision) && revision >= 0)) {
        throw new TypeError("A retraction's revision is a whole number from 0.");
      }
      const query = revision === undefined ? "" : `?revision=${revision}`;
      const raw = await deps.transport.request("DELETE", `/feedback/${encodeURIComponent(id)}${query}`);
      return FeedbackRetractedSchema.parse(raw);
    },
  };
}

/** Who sent the feedback, as your app knows them. */
export type FeedbackUser = {
  /** Pseudonymous: a hash of your user id. It is stored with every score. */
  readonly userId: string;
};

/** Where the browser's feedback goes: a trace id, or `{ sessionId }` for the session's latest trace. */
export type FeedbackTarget = string | { readonly traceId: string } | { readonly sessionId: string };

/** What the browser named as the subject of its feedback. */
export type FeedbackReference = {
  /** Your own id for the message, as the browser knows it. */
  readonly messageId?: string | undefined;
  readonly traceId?: string | undefined;
  readonly sessionId?: string | undefined;
};

export type FeedbackHandlerOptions = {
  /**
   * Who is sending: your session check. Return the user, or `null` to refuse with 401. The
   * `userId` it returns is the one stored; a `userId` in the body is ignored.
   */
  readonly authorize: (request: Request) => FeedbackUser | null | undefined | Promise<FeedbackUser | null | undefined>;
  /**
   * Map what the browser sent to the trace to attach to, e.g. your message id to the turn that
   * wrote the message, after checking the message is this user's. Return nothing to refuse with
   * 404. Without it, the body's `traceId` or `sessionId` is used as sent and `messageId` is refused.
   */
  readonly resolveTrace?:
    | ((
        reference: FeedbackReference,
        context: { readonly userId: string; readonly request: Request },
      ) => FeedbackTarget | null | undefined | Promise<FeedbackTarget | null | undefined>)
    | undefined;
  /** The largest body accepted. Default 16 KiB. */
  readonly maxBodyBytes?: number | undefined;
};

const DEFAULT_MAX_BODY_BYTES = 16 * 1024;

/**
 * A Fetch handler (`Request` in, `Response` out) for your own backend, so the browser can send
 * feedback without ever holding the LittleDB key. `POST` sends feedback, `DELETE` withdraws it
 * (`?id=` or `{ id }`). Ids from the browser are scoped to the signed-in user: the handler sends
 * `feedbackId(userId, id)`, so one user can neither replace nor withdraw another's answers.
 */
export function createFeedbackHandler(
  options: FeedbackHandlerOptions,
  deps: FeedbackApi & { readonly onError: LittleDBErrorHandler },
): (request: Request) => Promise<Response> {
  if (typeof options?.authorize !== "function") {
    throw new TypeError("feedbackHandler needs an authorize(request) function.");
  }
  const maxBytes = Math.max(1, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);

  async function send(request: Request, userId: string): Promise<Response> {
    if (!isJsonType(request.headers.get("content-type"))) {
      // Also what keeps a cross-site form from posting feedback with the user's cookies: a JSON
      // content type needs a CORS preflight.
      return reply(415, problem("unsupported_media_type", "Send feedback as application/json."));
    }
    const text = await readBody(request, maxBytes);
    if (text === undefined) return reply(413, problem("too_large", `Feedback is limited to ${maxBytes} bytes.`));
    const body = parseJson(text);
    if (!isRecord(body)) return reply(400, problem("bad_request", "Send feedback as a JSON object."));

    const { messageId, userId: _ignored, traceId, sessionId, ...rest } = body;
    if (messageId !== undefined && !isId(messageId)) {
      return reply(400, problem("bad_request", "messageId: expected a string of at most 200 characters."));
    }
    let target: Record<string, unknown> = { traceId, sessionId };
    if (options.resolveTrace !== undefined) {
      const resolved = await options.resolveTrace(
        {
          ...(messageId === undefined ? {} : { messageId }),
          ...(typeof traceId === "string" ? { traceId } : {}),
          ...(typeof sessionId === "string" ? { sessionId } : {}),
        },
        { userId, request },
      );
      if (resolved === null || resolved === undefined) {
        return reply(404, problem("not_found", "There is no message to attach this feedback to."));
      }
      target = typeof resolved === "string" ? { traceId: resolved } : { ...resolved };
    } else if (messageId !== undefined) {
      return reply(400, problem("bad_request", "Send a traceId or a sessionId; messageId needs resolveTrace on the server."));
    }

    // One answer per user per message: the id defaults to the message id, and either is scoped
    // to this user.
    const ownId = rest.id ?? messageId;
    const candidate = {
      ...rest,
      ...target,
      userId,
      ...(ownId === undefined ? {} : { id: typeof ownId === "string" ? feedbackId(userId, ownId) : ownId }),
    };
    const checked = checkFeedback(candidate);
    if (!checked.ok) return reply(400, problem("bad_request", checked.error));
    const result = await deps.feedback(checked.value);
    return reply(201, { traceId: result.traceId, scores: result.scores });
  }

  async function retract(request: Request, userId: string): Promise<Response> {
    let id: unknown = requestUrl(request)?.searchParams.get("id") ?? undefined;
    if (id === undefined) {
      const text = await readBody(request, maxBytes);
      if (text === undefined) return reply(413, problem("too_large", `The body is limited to ${maxBytes} bytes.`));
      const body = parseJson(text);
      if (isRecord(body)) id = body.id ?? body.messageId;
    }
    if (!isId(id)) return reply(400, problem("bad_request", "Say which feedback to withdraw: ?id= or { \"id\": ... }."));
    const result = await deps.retractFeedback(feedbackId(userId, id));
    return reply(200, { removed: result.removed });
  }

  return async (request) => {
    try {
      if (request.method !== "POST" && request.method !== "DELETE") {
        return reply(405, problem("method_not_allowed", "POST sends feedback; DELETE withdraws it."), { allow: "POST, DELETE" });
      }
      const user = await options.authorize(request);
      const userId = user?.userId;
      if (typeof userId !== "string" || userId.length === 0 || userId.length > 200) {
        return reply(401, problem("unauthorized", "Sign in to send feedback."));
      }
      return request.method === "DELETE" ? await retract(request, userId) : await send(request, userId);
    } catch (error) {
      return failed(error, request.method === "DELETE");
    }
  };

  /** A short answer of our own: never LittleDB's error body, and never anything about the key. */
  function failed(error: unknown, retracting: boolean): Response {
    if (error instanceof LittleDBError) {
      if (error.status === 404) {
        return reply(
          404,
          problem("not_found", retracting ? "There is no such feedback to withdraw." : "There is nothing to attach this feedback to yet."),
        );
      }
      if (error.status === 400 || error.status === 422) return reply(400, problem("bad_request", "LittleDB did not accept this feedback."));
      if (error.status === 429) return reply(429, problem("rate_limited", "Too much feedback at once. Try again shortly."));
      deps.onError(error, { operation: "feedback" });
      return reply(502, problem("unavailable", "Feedback could not be saved right now."));
    }
    deps.onError(error, { operation: "feedback" });
    return reply(500, problem("internal", "Feedback could not be saved."));
  }
}

function problem(code: string, message: string) {
  return { error: { code, message } };
}

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

function isJsonType(contentType: string | null): boolean {
  const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return type === "application/json" || (type.startsWith("application/") && type.endsWith("+json"));
}

function parseJson(text: string): unknown {
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function requestUrl(request: Request): URL | undefined {
  try {
    return new URL(request.url, "http://localhost");
  } catch {
    return undefined;
  }
}

/** The body as text, or `undefined` when it is over `max` bytes (declared or actually sent). */
async function readBody(request: Request, max: number): Promise<string | undefined> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return undefined;
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
