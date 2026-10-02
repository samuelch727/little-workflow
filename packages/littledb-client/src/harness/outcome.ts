import type { ReportOutcome } from "../contract.js";

export interface OutcomeReporterOptions {
  controlPlaneUrl: string;
  /** Per-project API key. Omit when targeting a local control plane (local mode). */
  projectKey?: string;
  fetchImpl?: typeof fetch;
}

export interface OutcomeReporter {
  report(outcome: ReportOutcome): Promise<{ ok: boolean }>;
}

/**
 * Reports an app-observed run outcome to littleDB. Best-effort, like the trace
 * reporter: a failed POST never throws into the application's hot path.
 */
export function createOutcomeReporter(options: OutcomeReporterOptions): OutcomeReporter {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async report(outcome) {
      try {
        const res = await fetchImpl(`${options.controlPlaneUrl}/api/outcomes`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(options.projectKey ? { "x-api-key": options.projectKey } : {}),
          },
          body: JSON.stringify(outcome),
        });
        return { ok: res.ok };
      } catch {
        return { ok: false };
      }
    },
  };
}
