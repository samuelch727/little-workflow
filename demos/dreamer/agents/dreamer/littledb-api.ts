import {
  controlPlaneUrl,
  defaultHarnessSlug,
  fallbackEngineUrl,
  isDryRun,
  projectKey,
} from "./env";

/**
 * The dreamer's whole view of littleDB: three HTTP calls, no client library.
 *
 * The demo deliberately does NOT import `@little-workflow/littledb`. That package is the
 * *producer* side — the tracing World and the managed-config harness adapter a product
 * harness wires in. The dreamer is a *consumer*: it reads an evidence pack, reads runs, and
 * posts a proposal. Keeping it to `fetch` means the LIT-52 seam is exercised as a wire
 * contract, exactly as an external investigator would see it.
 */

// ── the evidence-pack contract (LIT-52 Track A) ─────────────────────────────────────────

export type EvidencePackOutcome = {
  /** success / failure / partial. */
  readonly status: string;
  /** `"explicit"` — reported by the app or a human. `"inferred"` — read out of user pushback. */
  readonly source: string;
  /** For an inferred outcome, the user turn the verdict was read from. */
  readonly quote?: string;
};

export type EvidencePackRun = {
  readonly runId: string;
  readonly startedAt: string;
  /** The ENGINE's run status (completed/failed) — not the outcome. */
  readonly engineStatus: string | null;
  readonly configVersionId: string;
  readonly outcome: EvidencePackOutcome | null;
  /** The user turn that pushed back, when pushback was detected. */
  readonly pushbackQuote?: string;
  /** The assistant answer that pushback was correcting — i.e. the answer that failed. */
  readonly answerBeforePushback?: string;
};

export type EvidencePackMetrics = {
  readonly configVersionId: string;
  readonly runCount: number;
  readonly withOutcome: number;
  readonly successRate: number | null;
  readonly explicitOutcomes: number;
  readonly inferredOutcomes: number;
  readonly [key: string]: unknown;
};

export type EvidencePack = {
  readonly harness: { readonly slug: string; readonly productionConfigVersionId: string };
  /** The production `ConfigBundle` — prompt, skills, modelSlot, sampling, hyperparams, … */
  readonly baseConfig: Record<string, unknown>;
  readonly metrics: readonly EvidencePackMetrics[];
  readonly runs: readonly EvidencePackRun[];
  readonly engineUrl: string;
};

/**
 * A run worth an incident card. `partial` counts: a half-right answer that drew pushback is
 * exactly the kind of failure a config change can fix.
 */
export function isFailureRun(run: EvidencePackRun): boolean {
  return run.outcome?.status === "failure" || run.outcome?.status === "partial";
}

export type FailureSample = {
  readonly runId: string;
  readonly pushback: string;
  readonly issue: string;
};

export type ProposalBody = {
  readonly rationale: string;
  readonly evidence: {
    readonly failureSamples: readonly FailureSample[];
    readonly configSuccessRates?: unknown;
  };
  readonly proposedConfigPatch: Record<string, unknown>;
  /** Always `"dreamer-agent"`. A constant the tool stamps — never model input. */
  readonly origin: "dreamer-agent";
};

/** The 422 the control plane returns when a quoted `pushback` is not in the cited run. */
export type UnverifiedClaim = { readonly runId: string; readonly pushback: string };

// ── process-wide investigation state ────────────────────────────────────────────────────

/**
 * Held on `globalThis` for the same reason kb-chatbot holds its littleDB handle there:
 * `little-harness`'s `importDefault` constructs a NEW jiti instance per module, so
 * `tools/littledb_evidence_pack.ts` and `tools/littledb_submit_proposal.ts` do NOT share a
 * module registry. A plain module-level `let` would give each tool its own engine URL, its
 * own attempt counter, and its own dry-run log.
 */
const STATE = Symbol.for("dreamer.littledb-state");

export type InvestigationState = {
  /** The evidence pack most recently fetched, if any. */
  pack?: EvidencePack;
  /** POST attempts that actually reached the control plane, keyed by harness slug. */
  readonly submitAttempts: Map<string, number>;
  /** `--dry-run`: the bodies that WOULD have been posted, in order. */
  readonly dryRunSubmissions: ProposalBody[];
  /** Proposals the control plane accepted, in order, so the driver can name them. */
  readonly submittedProposals: Array<{
    readonly harness: string;
    readonly proposalId: string | undefined;
    readonly body: ProposalBody;
  }>;
};

type StateHolder = { [STATE]?: InvestigationState };

export function investigationState(): InvestigationState {
  const holder = globalThis as unknown as StateHolder;
  const existing = holder[STATE];
  if (existing !== undefined) return existing;
  const created: InvestigationState = {
    submitAttempts: new Map(),
    dryRunSubmissions: [],
    submittedProposals: [],
  };
  holder[STATE] = created;
  return created;
}

/** Drop every trace of the previous investigation. Used by the driver and by tests. */
export function resetInvestigationState(): void {
  delete (globalThis as unknown as StateHolder)[STATE];
}

/**
 * At most one initial submission plus two corrections. The control plane verifies every
 * quoted `pushback` mechanically, so an ungrounded claim comes back 422; the agent gets two
 * chances to re-read the run and fix the citation, and then the tool stops accepting
 * submissions for this harness rather than letting the turn spin.
 */
export const MAX_SUBMIT_ATTEMPTS = 3;

// ── HTTP ────────────────────────────────────────────────────────────────────────────────

function headers(): Record<string, string> {
  const key = projectKey();
  return {
    "content-type": "application/json",
    ...(key === undefined ? {} : { "x-api-key": key }),
  };
}

function endpoint(base: string, path: string): string {
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}

export function resolveHarnessSlug(explicit: string | undefined): string {
  const slug = explicit ?? investigationState().pack?.harness.slug ?? defaultHarnessSlug();
  if (slug === undefined) {
    throw new Error(
      "No harness slug. Pass `harness` explicitly, or start the dreamer with --harness <slug>.",
    );
  }
  return slug;
}

/** The engine the evidence pack pointed at, falling back to the configured default. */
export function engineUrl(): string {
  return investigationState().pack?.engineUrl ?? fallbackEngineUrl();
}

export async function fetchEvidencePack(slug: string): Promise<EvidencePack> {
  const url = endpoint(controlPlaneUrl(), `api/harnesses/${encodeURIComponent(slug)}/evidence-pack`);
  const response = await fetch(url, { headers: headers() });
  if (!response.ok) {
    throw new Error(
      `Evidence pack for '${slug}' failed with HTTP ${response.status}: ${await safeText(response)}`,
    );
  }
  const pack = (await response.json()) as EvidencePack;
  investigationState().pack = pack;
  return pack;
}

export async function fetchRun(runId: string): Promise<unknown> {
  const url = endpoint(engineUrl(), `runs/${encodeURIComponent(runId)}`);
  const response = await fetch(url, { headers: headers() });
  if (response.status === 404) {
    throw new Error(`Run '${runId}' is not in the engine.`);
  }
  if (!response.ok) {
    throw new Error(`Run '${runId}' failed with HTTP ${response.status}: ${await safeText(response)}`);
  }
  return await response.json();
}

export type SubmitOutcome =
  | { readonly kind: "submitted"; readonly proposalId: string | undefined; readonly body: unknown }
  | { readonly kind: "dry-run"; readonly body: ProposalBody }
  | { readonly kind: "unverified"; readonly error: string; readonly unverifiedClaim: UnverifiedClaim | undefined; readonly attemptsLeft: number }
  | { readonly kind: "rejected"; readonly status: number; readonly error: string }
  | { readonly kind: "blocked"; readonly attempts: number };

export async function submitProposal(slug: string, body: ProposalBody): Promise<SubmitOutcome> {
  const state = investigationState();

  if (isDryRun()) {
    // Never counted against MAX_SUBMIT_ATTEMPTS: nothing reached the control plane, so
    // there is no verification verdict to retry against.
    state.dryRunSubmissions.push(body);
    return { kind: "dry-run", body };
  }

  const attempts = state.submitAttempts.get(slug) ?? 0;
  if (attempts >= MAX_SUBMIT_ATTEMPTS) {
    return { kind: "blocked", attempts };
  }
  state.submitAttempts.set(slug, attempts + 1);

  const url = endpoint(controlPlaneUrl(), `api/harnesses/${encodeURIComponent(slug)}/proposals`);
  const response = await fetch(url, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });

  if (response.status === 422) {
    const payload = (await safeJson(response)) as
      | { error?: unknown; unverifiedClaim?: unknown }
      | undefined;
    return {
      kind: "unverified",
      error: typeof payload?.error === "string" ? payload.error : "A quoted claim could not be verified.",
      unverifiedClaim: asUnverifiedClaim(payload?.unverifiedClaim),
      attemptsLeft: MAX_SUBMIT_ATTEMPTS - (attempts + 1),
    };
  }

  if (!response.ok) {
    return { kind: "rejected", status: response.status, error: await safeText(response) };
  }

  const payload = (await safeJson(response)) as Record<string, unknown> | undefined;
  const proposalId = proposalIdFrom(payload);
  state.submittedProposals.push({ harness: slug, proposalId, body });
  return { kind: "submitted", proposalId, body: payload };
}

/**
 * The POST response shape is Track A's to define. Read the id tolerantly rather than
 * failing a genuinely-accepted proposal over a field name.
 */
export function proposalIdFrom(payload: Record<string, unknown> | undefined): string | undefined {
  if (payload === undefined) return undefined;
  for (const key of ["proposalId", "id", "proposal_id"]) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  const nested = payload.proposal;
  if (nested !== null && typeof nested === "object") {
    return proposalIdFrom(nested as Record<string, unknown>);
  }
  return undefined;
}

function asUnverifiedClaim(value: unknown): UnverifiedClaim | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const claim = value as Record<string, unknown>;
  if (typeof claim.runId !== "string" || typeof claim.pushback !== "string") return undefined;
  return { runId: claim.runId, pushback: claim.pushback };
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "(no body)";
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
