import { AgentWorkflowListSchema, AgentWorkflowRegisteredSchema, type AgentWorkflowList } from "../contract.js";
import { pinFor } from "../eval-context.js";
import type { LittleDBErrorHandler } from "../exporter.js";
import type { Transport } from "../http.js";
import { bucket, isRecord } from "../util.js";
import type { TracingWorldOptions, WorldLike } from "../workflow/tracing-world.js";

/**
 * An agent-defined workflow definition, as `define_workflow` writes it. The harness's
 * `AgentWorkflowDefinition` has this shape; the client restates it so it does not depend on the
 * harness package.
 */
export type AgentWorkflowDefinitionLike = {
  readonly id: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly outputSchema: unknown;
  readonly tools: readonly string[];
  readonly policy?: string;
  readonly models?: readonly string[];
};

/** A stored revision, as the harness hands it to a registry (`AgentWorkflowRecord`). */
export type AgentWorkflowRecordLike = AgentWorkflowDefinitionLike & {
  readonly handle: string;
  readonly revision: number;
  readonly definedAt: string;
  readonly sessionId: string;
};

/**
 * What LittleDB knows about the version a turn offers; handed to the World factory as
 * `metadata.littledb`. `status` is `live`, `trial` (a candidate this session was routed to),
 * `pinned` (an experiment run's version), or the draft's own status for a session's own revision.
 */
export type LittleDBWorkflowVersion = {
  readonly subjectId: string;
  readonly versionId: string;
  readonly number: number;
  readonly status: string;
  readonly proposalId?: string | null;
};

/** What the World factory of `dynamicWorkflows({ world })` is handed for each run. */
export type AgentWorkflowRunLike = {
  readonly kind: "defined" | "ad_hoc";
  readonly handle: string;
  readonly runId: string;
  readonly dataDir: string;
  readonly sessionId?: string | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
};

/**
 * A workflow the registry offers a turn (`AgentWorkflowOffer`). `metadata` is absent only for a
 * definition offered while LittleDB was unreachable.
 */
export type LittleDBAgentWorkflowOffer = AgentWorkflowDefinitionLike & {
  readonly handle: string;
  readonly revision: number;
  readonly metadata?: { readonly littledb: LittleDBWorkflowVersion };
};

export type AgentWorkflowRegistryOptions = {
  /** The harness's slug in LittleDB. Its agent-made workflows are kept under it. */
  readonly harness: string;
  /**
   * Offer a session the revisions it defined itself while they wait for review, so the agent can
   * keep using what it just made. Other sessions only get approved (live) versions. Default `true`.
   */
  readonly ownDrafts?: boolean | undefined;
  /** How long the list of approved workflows is reused before asking LittleDB again. Default 30 s. */
  readonly cacheTtlMs?: number | undefined;
  /**
   * What to offer when LittleDB cannot be reached and nothing was fetched before: `none` (only a
   * session's own definitions, when `ownDrafts` is on) or `stored` (every stored definition, as
   * if there were no registry). Default `none`.
   */
  readonly offline?: "none" | "stored" | undefined;
  /** Give up on LittleDB after this long. Default 5 s. */
  readonly timeoutMs?: number | undefined;
};

/** Context the harness passes to registry hooks. */
export type AgentWorkflowRegistryContextLike = { readonly sessionId: string; readonly turnId: string };

/**
 * A `dynamicWorkflows({ registry })` for LittleDB. Every `define_workflow` becomes a draft
 * version with a proposal in LittleDB; a turn offers the live (approved) versions, plus the
 * session's own drafts.
 */
export type LittleDBAgentWorkflowRegistry = {
  readonly defined: (
    record: AgentWorkflowRecordLike,
    ctx: AgentWorkflowRegistryContextLike,
  ) => Promise<{ readonly note: string; readonly metadata: { readonly littledb: LittleDBWorkflowVersion } }>;
  readonly resolve: (
    records: readonly AgentWorkflowRecordLike[],
    ctx: AgentWorkflowRegistryContextLike,
  ) => Promise<readonly LittleDBAgentWorkflowOffer[]>;
  /** Forget the cached list, so the next turn asks LittleDB. */
  readonly refresh: () => void;
  /**
   * A `dynamicWorkflows({ world })` factory: your World for each run, traced into LittleDB under
   * the harness with the version the turn was offered (a trial candidate traced as `trial`).
   */
  readonly world: <W extends WorldLike>(
    inner: (run: AgentWorkflowRunLike) => W,
    options?: Omit<TracingWorldOptions, "workflow" | "origin" | "harness" | "resolution" | "versionId">,
  ) => (run: AgentWorkflowRunLike) => W;
};

type ListEntry = { readonly fetchedAt: number; readonly list: AgentWorkflowList };

/** The definition fields of a record, without the harness's bookkeeping. */
export function pickDefinition(record: AgentWorkflowDefinitionLike): AgentWorkflowDefinitionLike {
  return {
    id: record.id,
    description: record.description,
    inputSchema: record.inputSchema,
    outputSchema: record.outputSchema,
    tools: [...record.tools],
    ...(record.policy === undefined ? {} : { policy: record.policy }),
    ...(record.models === undefined ? {} : { models: [...record.models] }),
  };
}

/** A version's content, when it is a workflow definition. */
function asDefinition(content: unknown): AgentWorkflowDefinitionLike | undefined {
  if (!isRecord(content)) return undefined;
  const { id, description, inputSchema, outputSchema, tools, policy, models } = content;
  if (typeof id !== "string" || typeof description !== "string") return undefined;
  if (!Array.isArray(tools) || !tools.every((t) => typeof t === "string")) return undefined;
  if (policy !== undefined && typeof policy !== "string") return undefined;
  if (models !== undefined && (!Array.isArray(models) || !models.every((m) => typeof m === "string"))) return undefined;
  return pickDefinition({
    id,
    description,
    inputSchema,
    outputSchema,
    tools: tools as string[],
    ...(policy === undefined ? {} : { policy: policy as string }),
    ...(models === undefined ? {} : { models: models as string[] }),
  });
}

/** The revision in an external id `handle@revision`, when it names this handle. */
function revisionOf(handle: string, externalId: string | null | undefined): number | undefined {
  if (typeof externalId !== "string") return undefined;
  const at = externalId.lastIndexOf("@");
  if (at <= 0 || externalId.slice(0, at) !== handle) return undefined;
  const revision = Number(externalId.slice(at + 1));
  return Number.isInteger(revision) && revision > 0 ? revision : undefined;
}

type ListedWorkflow = AgentWorkflowList["workflows"][number];

const MAX_OFFERS = 10_000;

/**
 * The trial candidate a session gets, the way LittleDB splits traffic: the key's bucket decides
 * whether it is in the trial's share, a second bucket picks an arm by weight. `undefined` keeps
 * the session on the live version.
 */
export function trialArmFor(
  trial: NonNullable<ListedWorkflow["trial"]>,
  key: string,
): NonNullable<NonNullable<ListedWorkflow["trial"]>["arms"]>[number] | undefined {
  const arms = trial.arms ?? [];
  if (arms.length === 0 || trial.id === undefined) return undefined;
  const share = trial.share ?? arms.reduce((sum, arm) => sum + arm.weight, 0);
  if (bucket(`${key}:${trial.id}`) >= share) return undefined;
  // The weights are shares of all sessions; their proportions pick the arm.
  const total = arms.reduce((sum, arm) => sum + arm.weight, 0);
  let u = bucket(`${key}:${trial.id}:arm`) * (total > 0 ? total : arms.length);
  for (const arm of arms) {
    u -= total > 0 ? arm.weight : 1;
    if (u < 0) return arm;
  }
  return arms[arms.length - 1];
}

export function createAgentWorkflowRegistry(
  options: AgentWorkflowRegistryOptions,
  deps: {
    readonly transport: Transport;
    readonly onError: LittleDBErrorHandler;
    readonly tracingWorld?: <W extends WorldLike>(inner: W, options: TracingWorldOptions) => W;
  },
): LittleDBAgentWorkflowRegistry {
  const ownDrafts = options.ownDrafts !== false;
  const cacheTtlMs = options.cacheTtlMs ?? 30_000;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const offline = options.offline ?? "none";
  let cached: ListEntry | undefined;
  let inFlight: Promise<AgentWorkflowList> | undefined;
  // The version each session was offered per handle, so a redefinition is based on what the agent saw.
  const offered = new Map<string, string>();
  const offerKey = (sessionId: string, handle: string) => `${sessionId}\u0000${handle}`;
  const noteOffer = (sessionId: string, handle: string, versionId: string) => {
    const key = offerKey(sessionId, handle);
    offered.delete(key);
    offered.set(key, versionId);
    while (offered.size > MAX_OFFERS) {
      const oldest = offered.keys().next().value;
      if (oldest === undefined) break;
      offered.delete(oldest);
    }
  };

  const fetchList = (): Promise<AgentWorkflowList> => {
    inFlight ??= (async () => {
      try {
        const raw = await deps.transport.request(
          "GET",
          `/agent-workflows?harness=${encodeURIComponent(options.harness)}&includeDrafts=${ownDrafts ? "true" : "false"}`,
          undefined,
          { timeoutMs },
        );
        const list = AgentWorkflowListSchema.parse(raw);
        cached = { fetchedAt: Date.now(), list };
        return list;
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };

  const list = async (): Promise<AgentWorkflowList | undefined> => {
    if (cached !== undefined && Date.now() - cached.fetchedAt < cacheTtlMs) return cached.list;
    try {
      return await fetchList();
    } catch (error) {
      deps.onError(error, { operation: "agent-workflows" });
      // The last answer is better than none: approvals change rarely.
      return cached?.list;
    }
  };

  const ownLatest = (records: readonly AgentWorkflowRecordLike[], sessionId: string) => {
    const own = new Map<string, AgentWorkflowRecordLike>();
    for (const record of records) {
      if (record.sessionId !== sessionId) continue;
      const seen = own.get(record.handle);
      if (seen === undefined || record.revision > seen.revision) own.set(record.handle, record);
    }
    return own;
  };

  const unverified = (record: AgentWorkflowRecordLike): LittleDBAgentWorkflowOffer => ({
    ...pickDefinition(record),
    handle: record.handle,
    revision: record.revision,
  });

  return {
    async defined(record, ctx) {
      const baseVersionId = offered.get(offerKey(ctx.sessionId, record.handle));
      try {
        const raw = await deps.transport.request(
          "POST",
          "/agent-workflows",
          {
            harness: options.harness,
            handle: record.handle,
            definition: pickDefinition(record),
            description: record.description.slice(0, 4000),
            revision: record.revision,
            sessionId: ctx.sessionId,
            ...(baseVersionId === undefined ? {} : { baseVersionId }),
          },
          { timeoutMs },
        );
        const registered = AgentWorkflowRegisteredSchema.parse(raw);
        cached = undefined;
        noteOffer(ctx.sessionId, record.handle, registered.versionId);
        const littledb: LittleDBWorkflowVersion = {
          subjectId: registered.subjectId,
          versionId: registered.versionId,
          number: registered.number,
          status: registered.status,
          proposalId: registered.proposalId,
        };
        const note = registered.live
          ? `This is the approved version. From your next message on, call it as the tool ${record.handle}.`
          : ownDrafts
            ? `Saved as draft version ${registered.number}, waiting for review. Until it is approved only this session can use it: from your next message on, call it as the tool ${record.handle}.`
            : `Saved as draft version ${registered.number}, waiting for review. It becomes the tool ${record.handle} once it is approved.`;
        return { note, metadata: { littledb } };
      } catch (error) {
        deps.onError(error, { operation: "agent-workflows" });
        throw error;
      }
    },

    async resolve(records, ctx) {
      const own = ownDrafts ? ownLatest(records, ctx.sessionId) : new Map<string, AgentWorkflowRecordLike>();
      const fetched = await list();
      if (fetched === undefined) {
        if (offline === "stored") return records.map(unverified);
        return [...own.values()].map(unverified);
      }
      const offers: LittleDBAgentWorkflowOffer[] = [];
      for (const workflow of fetched.workflows) {
        const mine = own.get(workflow.handle);
        const draft =
          mine === undefined
            ? undefined
            : workflow.drafts?.find((d) => revisionOf(workflow.handle, d.externalId) === mine.revision);
        const live = workflow.live;
        const liveDefinition = live === null ? undefined : asDefinition(live.content);
        const liveRevision = live === null ? undefined : (revisionOf(workflow.handle, live.externalId) ?? live.number);
        if (live !== null && liveDefinition === undefined) {
          deps.onError(new Error(`Agent workflow '${workflow.handle}' version ${live.number} is not a workflow definition.`), {
            operation: "agent-workflows",
          });
        }
        // A session's own revision still waiting for review wins over an older live one.
        if (mine !== undefined && draft !== undefined && (liveRevision === undefined || mine.revision > liveRevision)) {
          offers.push({
            ...pickDefinition(mine),
            handle: workflow.handle,
            revision: mine.revision,
            metadata: {
              littledb: { subjectId: workflow.subjectId, versionId: draft.id, number: draft.number, status: draft.status },
            },
          });
          continue;
        }
        const offer = pinnedOffer(workflow) ?? trialOffer(workflow, ctx.sessionId);
        if (offer !== undefined) {
          offers.push(offer);
          noteOffer(ctx.sessionId, workflow.handle, offer.metadata!.littledb.versionId);
          continue;
        }
        if (live !== null && liveDefinition !== undefined && liveRevision !== undefined) {
          offers.push({
            ...liveDefinition,
            handle: workflow.handle,
            revision: liveRevision,
            metadata: {
              littledb: { subjectId: workflow.subjectId, versionId: live.versionId, number: live.number, status: "live" },
            },
          });
          noteOffer(ctx.sessionId, workflow.handle, live.versionId);
        }
      }
      return offers;
    },

    refresh() {
      cached = undefined;
    },

    world(inner, worldOptions = {}) {
      const trace = deps.tracingWorld;
      return (run) => {
        const world = inner(run);
        if (trace === undefined) return world;
        const littledb = isRecord(run.metadata?.littledb) ? run.metadata.littledb : undefined;
        const versionId = typeof littledb?.versionId === "string" ? littledb.versionId : undefined;
        const status = typeof littledb?.status === "string" ? littledb.status : undefined;
        return trace(world, {
          ...worldOptions,
          workflow: run.handle,
          origin: run.kind === "defined" ? "agent" : "planner",
          harness: options.harness,
          ...(versionId === undefined ? {} : { resolution: { versionId, mode: status === "trial" ? "trial" : "live" } }),
        });
      };
    },
  };

  /** Inside an experiment run that pins this workflow: the pinned version. */
  function pinnedOffer(workflow: ListedWorkflow): LittleDBAgentWorkflowOffer | undefined {
    const pin = pinFor("workflow", workflow.handle);
    if (pin === undefined) return undefined;
    const definition = asDefinition(pin.content);
    if (definition === undefined) return undefined;
    return {
      ...definition,
      handle: workflow.handle,
      revision: workflow.live === null ? 1 : (revisionOf(workflow.handle, workflow.live.externalId) ?? workflow.live.number),
      metadata: { littledb: { subjectId: workflow.subjectId, versionId: pin.versionId, number: 0, status: "pinned" } },
    };
  }

  /** The trial candidate this session is routed to, when the workflow has a running trial. */
  function trialOffer(workflow: ListedWorkflow, sessionId: string): LittleDBAgentWorkflowOffer | undefined {
    if (workflow.trial == null) return undefined;
    // A session keeps what it was offered while that version is still an arm or live.
    const before = offered.get(offerKey(sessionId, workflow.handle));
    const arms = workflow.trial.arms ?? [];
    const arm = arms.find((a) => a.versionId === before) ?? (before === workflow.live?.versionId ? undefined : trialArmFor(workflow.trial, sessionId));
    if (arm === undefined || arm.content === undefined) return undefined;
    const definition = asDefinition(arm.content);
    if (definition === undefined) {
      deps.onError(new Error(`Agent workflow '${workflow.handle}' trial version ${arm.versionId} is not a workflow definition.`), {
        operation: "agent-workflows",
      });
      return undefined;
    }
    const liveRevision = workflow.live === null ? 0 : (revisionOf(workflow.handle, workflow.live.externalId) ?? workflow.live.number);
    return {
      ...definition,
      handle: workflow.handle,
      revision: revisionOf(workflow.handle, arm.externalId) ?? liveRevision,
      metadata: {
        littledb: { subjectId: workflow.subjectId, versionId: arm.versionId, number: arm.number ?? 0, status: "trial" },
      },
    };
  }
}
