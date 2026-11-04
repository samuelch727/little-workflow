/** A LittleDB request that failed: an HTTP error status, a timeout, or no connection at all. */
export class LittleDBError extends Error {
  /** The HTTP status, or 0 when no response arrived (connection refused, DNS, timeout). */
  readonly status: number;
  /** LittleDB's error code (`not_found`, `bad_request`, ...), `network` or `timeout`. */
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, status: number, code: string, details?: unknown) {
    super(message);
    this.name = "LittleDBError";
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }

  /** Worth trying again: no response, a timeout, 408, 429 or a 5xx. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

export type RequestOptions = {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
};

export type Transport = {
  /** The API base, ending in `/v1`. */
  readonly baseUrl: string;
  request<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown, options?: RequestOptions): Promise<T>;
};

/** `http://host:7340`, `http://host:7340/` and `http://host:7340/v1` all mean the same API. */
export function apiBase(url: string): string {
  const trimmed = url.trim().replace(/\/+$/u, "");
  if (trimmed.length === 0) throw new TypeError("LittleDB url is empty.");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

export function createTransport(options: {
  readonly url: string;
  readonly apiKey: string;
  readonly fetch?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
}): Transport {
  const baseUrl = apiBase(options.url);
  const doFetch = options.fetch ?? globalThis.fetch;
  const defaultTimeout = options.timeoutMs ?? 10_000;
  // Kept in a closure, never on the returned object, so it cannot end up in a log line.
  const authorization = `Bearer ${options.apiKey}`;

  return {
    baseUrl,
    async request<T>(
      method: "GET" | "POST" | "PATCH" | "DELETE",
      path: string,
      body?: unknown,
      requestOptions: RequestOptions = {},
    ): Promise<T> {
      const timeout = AbortSignal.timeout(requestOptions.timeoutMs ?? defaultTimeout);
      const signal = requestOptions.signal === undefined ? timeout : AbortSignal.any([timeout, requestOptions.signal]);
      let response: Response;
      try {
        response = await doFetch(`${baseUrl}${path}`, {
          method,
          headers: {
            authorization,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal,
        });
      } catch (error) {
        const timedOut = timeout.aborted || (error instanceof Error && error.name === "TimeoutError");
        throw new LittleDBError(
          timedOut
            ? `LittleDB ${method} ${path} timed out`
            : `LittleDB ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
          0,
          timedOut ? "timeout" : "network",
        );
      }
      const text = await response.text().catch(() => "");
      let json: unknown = undefined;
      if (text.length > 0) {
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
      }
      if (!response.ok) {
        const error = (json as { error?: { code?: unknown; message?: unknown; details?: unknown } } | undefined)?.error;
        const message = typeof error?.message === "string" ? error.message : text.slice(0, 300) || response.statusText;
        throw new LittleDBError(
          `LittleDB ${method} ${path} → HTTP ${response.status}: ${message}`,
          response.status,
          typeof error?.code === "string" ? error.code : `http_${response.status}`,
          error?.details,
        );
      }
      return json as T;
    },
  };
}
