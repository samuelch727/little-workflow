import type {
  DurableHarnessEventInput,
  HarnessDurabilitySink,
  HarnessPriorEventQuery,
  PersistedDurableHarnessEvent,
} from "../events/occurrence.js";

export type RemoteSessionLogOptions = {
  /** Base URL of a session-log service (see startSessionLogServer). */
  baseUrl: string;
  /** Bearer token sent with every request. */
  authToken?: string;
  /**
   * Per-request deadline in milliseconds; defaults to 30 000. Appends are awaited on the
   * turn's hot path, so without a deadline a stalled socket would hang the turn forever.
   */
  timeoutMs?: number;
  /** Fetch implementation override (tests, custom agents). */
  fetch?: typeof fetch;
};

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * A HarnessDurabilitySink backed by a remote session-log service. Hand it to
 * createHarness/generateHarness as `durability` and the run's source of truth lives outside
 * the process: kill the harness, start a fresh one anywhere with the same runId, and replay
 * fast-forwards from the remote log instead of re-calling models and tools.
 *
 * A failed or timed-out append rejects and fails the turn — durability is acknowledged
 * before execution proceeds, never silently dropped.
 */
export function remoteSessionLog(options: RemoteSessionLogOptions): HarnessDurabilitySink {
  const baseUrl = options.baseUrl.replace(/\/+$/u, "");
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(options.authToken === undefined ? {} : { authorization: `Bearer ${options.authToken}` }),
  };

  return {
    async append(event: DurableHarnessEventInput): Promise<PersistedDurableHarnessEvent> {
      const response = await fetchImpl(`${baseUrl}/v1/events`, {
        method: "POST",
        headers,
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new Error(
          `Session log append failed with HTTP ${response.status}${await errorDetail(response)}.`,
        );
      }
      const body = (await response.json()) as { event: PersistedDurableHarnessEvent };
      return body.event;
    },
    async priorEvents(
      query: HarnessPriorEventQuery = {},
    ): Promise<readonly PersistedDurableHarnessEvent[]> {
      const url = new URL(`${baseUrl}/v1/events`);
      if (query.runId !== undefined) {
        url.searchParams.set("runId", query.runId);
      }
      if (query.type !== undefined) {
        url.searchParams.set("type", query.type);
      }
      if (query.occurrenceId !== undefined) {
        url.searchParams.set("occurrenceId", query.occurrenceId);
      }
      const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        throw new Error(
          `Session log read failed with HTTP ${response.status}${await errorDetail(response)}.`,
        );
      }
      const body = (await response.json()) as { events: PersistedDurableHarnessEvent[] };
      return body.events;
    },
  };
}

async function errorDetail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).slice(0, 200).trim();
    return text.length === 0 ? "" : `: ${text}`;
  } catch {
    return "";
  }
}
