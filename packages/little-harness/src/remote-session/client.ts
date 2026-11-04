import type {
  DurableHarnessEventInput,
  HarnessPriorEventQuery,
  PersistedDurableHarnessEvent,
} from "../events/occurrence.js";
import {
  RemoteSessionProtocolError,
  createRemoteAppendRequest,
  parseRemoteAppendResponse,
  parseRemoteReplayResponse,
} from "./protocol.js";

export type RemoteSessionLogOptions = {
  /** Base URL of a session-log service (see startSessionLogServer). */
  baseUrl: string;
  /** Bearer token sent with every request. */
  authToken?: string;
  /** Per-attempt deadline in milliseconds; defaults to 30 000. */
  timeoutMs?: number;
  /** Network/timeout/5xx append attempts. Defaults to 3; all reuse the exact same body/key. */
  maxAppendAttempts?: number;
  /** Fetch implementation override (tests, custom agents). */
  fetch?: typeof fetch;
};

export type RemoteSessionLog = {
  append(event: DurableHarnessEventInput): Promise<PersistedDurableHarnessEvent>;
  priorEvents(query?: HarnessPriorEventQuery): Promise<readonly PersistedDurableHarnessEvent[]>;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_APPEND_ATTEMPTS = 3;

/**
 * A strict, versioned Harness Session client. Append identity is supplied by the logical
 * caller; the client never creates or changes it. Automatic retries reuse the serialized
 * request byte-for-byte, so a lost response resolves to the original committed event.
 */
export function remoteSessionLog(options: RemoteSessionLogOptions): RemoteSessionLog {
  const baseUrl = options.baseUrl.replace(/\/+$/u, "");
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs", 300_000);
  const maxAppendAttempts = positiveInteger(
    options.maxAppendAttempts ?? DEFAULT_APPEND_ATTEMPTS,
    "maxAppendAttempts",
    10,
  );
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    ...(options.authToken === undefined ? {} : { authorization: `Bearer ${options.authToken}` }),
  };

  return {
    async append(event: DurableHarnessEventInput): Promise<PersistedDurableHarnessEvent> {
      const request = createRemoteAppendRequest(event);
      const requestBody = JSON.stringify(request);
      let finalError: unknown;
      for (let attempt = 1; attempt <= maxAppendAttempts; attempt += 1) {
        try {
          const response = await fetchImpl(`${baseUrl}/v1/events`, {
            method: "POST",
            headers,
            body: requestBody,
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!response.ok) {
            const detail = await errorDetail(response);
            const failure = new RemoteSessionHttpError(
              response.status,
              `Session log append failed with HTTP ${response.status}${detail}.`,
            );
            if (!isRetryableStatus(response.status) || attempt === maxAppendAttempts) {
              throw failure;
            }
            finalError = failure;
          } else {
            const persisted = parseRemoteAppendResponse(await response.json());
            if (
              persisted.runId !== request.event.runId ||
              persisted.appendIdempotencyKey !== request.event.appendIdempotencyKey ||
              persisted.canonicalRequestDigest !== request.canonicalRequestDigest
            ) {
              throw new Error("Session log append response does not match the submitted request.");
            }
            return persisted;
          }
        } catch (error) {
          finalError = error;
          if (
            attempt === maxAppendAttempts ||
            (error instanceof RemoteSessionHttpError && !isRetryableStatus(error.status)) ||
            !isRetryableTransportError(error)
          ) {
            throw error;
          }
        }
        await retryBackoff(attempt);
      }
      throw finalError ?? new Error("Session log append failed.");
    },
    async priorEvents(
      query: HarnessPriorEventQuery = {},
    ): Promise<readonly PersistedDurableHarnessEvent[]> {
      const url = new URL(`${baseUrl}/v1/events`);
      setOptionalString(url, "runId", query.runId);
      setOptionalString(url, "type", query.type);
      setOptionalString(url, "occurrenceId", query.occurrenceId);
      setOptionalString(url, "operationId", query.operationId);
      setOptionalString(url, "taskId", query.taskId);
      setOptionalString(url, "attemptId", query.attemptId);
      setOptionalInteger(url, "afterSequence", query.afterSequence, 0, Number.MAX_SAFE_INTEGER);
      setOptionalInteger(url, "limit", query.limit, 1, 10_000);
      const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        throw new Error(
          `Session log read failed with HTTP ${response.status}${await errorDetail(response)}.`,
        );
      }
      return parseRemoteReplayResponse(await response.json());
    },
  };
}

function positiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function setOptionalString(url: URL, name: string, value: string | undefined): void {
  if (value === undefined) return;
  if (value.length === 0 || value.length > 2_048 || value.includes("\0")) {
    throw new TypeError(`${name} is invalid`);
  }
  url.searchParams.set(name, value);
}

function setOptionalInteger(
  url: URL,
  name: string,
  value: number | undefined,
  minimum: number,
  maximum: number,
): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  url.searchParams.set(name, String(value));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

class RemoteSessionHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "RemoteSessionHttpError";
    this.status = status;
  }
}

function isRetryableTransportError(error: unknown): boolean {
  // Protocol, validation, and explicit HTTP failures are deterministic. Fetch network and
  // abort errors vary by runtime, so retry every other thrown value with the same bytes.
  return !(error instanceof RemoteSessionProtocolError) &&
    !(error instanceof TypeError && /invalid|must be/iu.test(error.message)) &&
    !(error instanceof SyntaxError) &&
    !(error instanceof Error && /does not match|unsupported|unknown field/iu.test(error.message));
}

function retryBackoff(attempt: number): Promise<void> {
  const delayMs = Math.min(200, 25 * 2 ** (attempt - 1));
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function errorDetail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).slice(0, 200).trim();
    return text.length === 0 ? "" : `: ${text}`;
  } catch {
    return "";
  }
}
