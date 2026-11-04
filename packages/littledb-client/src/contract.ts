// The LittleDB `/v1` wire contract this client speaks, as Zod schemas. They mirror the server's
// ingest schema (`server/src/ingest/schema.ts`) and the JSON its routes return, so a test (or an
// app) can check a payload before it is sent and a response before it is trusted.
import { z } from "zod";

const Id = z.string().min(1).max(200);
const Slug = z.string().min(1).max(200);
/** An ISO 8601 timestamp with an offset, or epoch milliseconds. */
const Time = z.union([z.string().datetime({ offset: true }), z.number()]);

/**
 * Where a trace came from: real traffic, a trial of a candidate version, the project holdout
 * (real traffic kept on an older version to measure what the changes added up to), an
 * experiment run, or a developer.
 */
export const EnvironmentSchema = z.enum(["production", "trial", "holdout", "experiment", "development"]);
/** Who wrote a workflow: a developer in code, an agent with `define_workflow`, or a planner for one run. */
export const WorkflowOriginSchema = z.enum(["code", "agent", "planner"]);
/** `wait`: time spent waiting, not working (a queue, a rate limit, a person to approve). LittleDB draws it hatched. */
export const SpanTypeSchema = z.enum(["agent", "llm", "tool", "step", "workflow", "retrieval", "event", "wait", "custom"]);
export const StatusSchema = z.enum(["running", "ok", "error"]);
export const SubjectKindSchema = z.enum(["harness", "workflow"]);

/**
 * Token counts for one model call. `inputTokens` EXCLUDES cache reads and writes (the Anthropic
 * convention), so the four numbers add up to everything the provider billed for input and output.
 */
export const UsageSchema = z
  .object({
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    cacheReadTokens: z.number().int().min(0),
    cacheWriteTokens: z.number().int().min(0),
  })
  .partial();

/**
 * How a trace started: a message, a schedule, an API call, a harness tool call (`harness`, with
 * the session, turn and tool call) or a workflow step (`workflow`, with the parent run). A trace
 * without one started from the app's own code.
 */
export const TriggerSchema = z.object({
  kind: z.string().min(1).max(40),
  /** Where: a connector (`whatsapp`, `email`), a schedule id, a route (`POST /loans`), a harness slug. */
  source: z.string().min(1).max(200).optional(),
  /** Who, as the channel names them: a phone number, an email address, a chat handle. */
  from: z.string().min(1).max(200).optional(),
  /** A short label for people: the schedule's description, the email's subject. */
  label: z.string().min(1).max(500).optional(),
  sessionId: z.string().min(1).max(200).optional(),
  turnId: z.string().min(1).max(200).optional(),
  toolCallId: z.string().min(1).max(200).optional(),
  runId: z.string().min(1).max(200).optional(),
});

/**
 * What a turn ran on and what that cost: the harness's `harness.runtime.usage` event, which
 * LittleDB indexes per trace to measure the Tier 0 share and the infrastructure cost per turn.
 * `activeMs` is the time commands were running, which managed compute is priced on; `awakeMs`
 * and `costUsd` are what the vendor billed, to check the margin.
 */
export const ComputeUsageSchema = z.object({
  /** `tier-0`: the emulated shell over the session folder; `next-tier`: a real execution environment. */
  tier: z.enum(["tier-0", "next-tier"]),
  /** Where the commands ran: `just-bash`, `cloudflare-sandbox`, `little-compute`, or `unknown`. */
  provider: z.string().min(1).max(200),
  instanceType: z.string().min(1).max(200).optional(),
  vcpu: z.number().min(0).optional(),
  memoryGiB: z.number().min(0).optional(),
  activeMs: z.number().min(0),
  awakeMs: z.number().min(0).optional(),
  /** vcpu × activeMs / 1000, when the vCPU count is known. */
  vcpuSeconds: z.number().min(0).optional(),
  /** The provider's estimate of the vendor bill at list price, when it knows the rates. */
  costUsd: z.number().min(0).optional(),
});

export const TraceSchema = z.object({
  id: Id,
  name: z.string().max(500).optional(),
  kind: z.enum(["turn", "workflow", "experiment", "review", "otel", "custom"]).optional(),
  /** Leave it out to let LittleDB derive the status from the root span. */
  status: StatusSchema.optional(),
  harness: Slug.optional(),
  workflow: Slug.optional(),
  workflowOrigin: WorkflowOriginSchema.optional(),
  /** The LittleDB version (`ver_...`) this run used, from `resolve`. */
  versionId: z.string().max(200).optional(),
  sessionId: z.string().max(200).optional(),
  userId: z.string().max(200).optional(),
  environment: EnvironmentSchema.optional(),
  experimentId: z.string().max(200).optional(),
  datasetItemId: z.string().max(200).optional(),
  startTime: Time,
  endTime: Time.optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string().max(100)).max(50).optional(),
  trigger: TriggerSchema.optional(),
  /** What the turn ran on and what that cost (a harness turn with a shell sandbox). */
  compute: ComputeUsageSchema.optional(),
  /** The trace that started this one: the harness turn whose tool call ran this workflow. */
  parentTraceId: Id.optional(),
  /** The span in that trace that started it (the harness `tool` span). */
  parentSpanId: Id.optional(),
});

export const SpanSchema = z.object({
  traceId: Id,
  id: Id,
  parentId: Id.nullable().optional(),
  name: z.string().min(1).max(500),
  type: SpanTypeSchema.optional(),
  status: StatusSchema.optional(),
  startTime: Time,
  endTime: Time.optional(),
  model: z.string().max(200).optional(),
  provider: z.string().max(200).optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ message: z.string(), type: z.string().optional() }).optional(),
  usage: UsageSchema.optional(),
  /** Leave it out to let LittleDB price the usage from its model price table. */
  costUsd: z.number().min(0).optional(),
});

export const ScoreSourceSchema = z.enum(["app", "human", "judge", "code", "workflow", "pushback"]);

export const ScoreSchema = z
  .object({
    /** Scores are upserted by id; the client derives a stable one when you leave it out. */
    id: z.string().max(200).optional(),
    traceId: Id,
    spanId: Id.optional(),
    name: z.string().min(1).max(200),
    value: z.number().finite().optional(),
    label: z.string().max(200).optional(),
    comment: z.string().max(10_000).optional(),
    source: ScoreSourceSchema.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((score) => score.value !== undefined || score.label !== undefined, {
    message: "A score needs a value or a label.",
  });

/** `POST /v1/ingest`: everything is an upsert, so a batch can be retried safely. */
export const IngestBatchSchema = z.object({
  traces: z.array(TraceSchema).max(5000).optional(),
  spans: z.array(SpanSchema).max(20_000).optional(),
  scores: z.array(ScoreSchema).max(5000).optional(),
});

/** The workflow (and its step) that is about to run a harness or workflow, so LittleDB learns who calls whom. */
export const CallerSchema = z.object({
  kind: SubjectKindSchema,
  slug: Slug,
  step: z.string().max(200).optional(),
});

/** `POST /v1/resolve`. */
export const ResolveRequestSchema = z.object({
  kind: SubjectKindSchema,
  slug: Slug,
  channel: z.string().max(50).optional(),
  /** A session or user id: the same key always lands on the same side of a trial. */
  stickyKey: z.string().max(200).optional(),
  /**
   * The config in code. It becomes version 1 when nothing is live yet; after that, a change to
   * it becomes a "Changed in code" proposal that LittleDB carries onto the live version.
   */
  bootstrap: z.record(z.string(), z.unknown()).optional(),
  /** A JSON Schema of the content your app can run. LittleDB checks every candidate against it. */
  schema: z.record(z.string(), z.unknown()).optional(),
  /** The version this sticky key runs now. The answer then says whether it was rolled back. */
  currentVersionId: z.string().max(200).optional(),
  caller: CallerSchema.optional(),
});

/** How the resolve mode reads: live, a trial candidate, the project holdout, or nothing live. */
export const ResolveModeSchema = z.enum(["live", "trial", "holdout", "none"]);

/** What LittleDB did with the bootstrap you sent: matches the code version, a new edit, an older deploy, or switched off. */
export const CodeStateSchema = z.enum(["in_sync", "changed", "stale", "ignored"]);

/**
 * The model a harness run uses, held in LittleDB: the version's `model` (a `provider/model` id),
 * else the agent's model setting, else the project's default; and who pays for its calls, the
 * app's own provider key or LittleDB credits.
 */
export const ResolvedModelSchema = z.object({
  id: z.string(),
  paidBy: z.enum(["key", "credits"]),
  source: z.enum(["version", "agent", "project"]),
});

export const ResolveResponseSchema = z.object({
  subjectId: z.string(),
  versionId: z.string().nullable(),
  number: z.number().nullable(),
  status: z.string().nullable(),
  mode: ResolveModeSchema,
  content: z.record(z.string(), z.unknown()).nullable(),
  channel: z.string(),
  /** With `currentVersionId`: that version's state. `revoked` is true when it was rolled back or pulled from a trial. */
  current: z
    .object({ versionId: z.string(), status: z.string().nullable(), revoked: z.boolean() })
    .nullable()
    .optional(),
  /** With a `bootstrap` once something is live: whether your code's config changed. */
  code: z
    .object({ state: CodeStateSchema, versionId: z.string().nullable().optional(), proposalId: z.string().nullable().optional() })
    .nullable()
    .optional(),
  /** A harness's model for this run. */
  model: ResolvedModelSchema.optional(),
});

/** `POST /v1/agent-workflows`. */
export const AgentWorkflowRegistrationSchema = z.object({
  harness: Slug,
  handle: Slug,
  definition: z.record(z.string(), z.unknown()),
  description: z.string().max(4000).optional(),
  revision: z.union([z.string(), z.number()]).optional(),
  sessionId: z.string().max(200).optional(),
  title: z.string().max(300).optional(),
  rationale: z.string().max(20_000).optional(),
  /**
   * The version the agent was offered when it redefined the workflow. LittleDB carries the new
   * definition onto the live version when that one has moved on since.
   */
  baseVersionId: z.string().max(200).optional(),
});

export const AgentWorkflowRegisteredSchema = z.object({
  subjectId: z.string(),
  versionId: z.string(),
  number: z.number(),
  status: z.string(),
  /** True when the definition is identical to the live one; nothing new was proposed. */
  live: z.boolean(),
  proposalId: z.string().nullable(),
});

const AgentWorkflowVersionSchema = z.object({
  versionId: z.string(),
  number: z.number(),
  content: z.unknown(),
  externalId: z.string().nullable().optional(),
});

/** `GET /v1/agent-workflows?harness=<slug>[&includeDrafts=true]`. */
export const AgentWorkflowListSchema = z.object({
  workflows: z.array(
    z.object({
      handle: z.string(),
      subjectId: z.string(),
      description: z.string().nullable().optional(),
      live: AgentWorkflowVersionSchema.nullable(),
      /**
       * The running trial: its id, the share of sessions in it, and its arms (each candidate's
       * share of all sessions, with its content), so a client routes a session to one locally.
       */
      trial: z
        .object({
          id: z.string().optional(),
          share: z.number().optional(),
          versionId: z.string(),
          weight: z.number(),
          arms: z
            .array(
              z.object({
                versionId: z.string(),
                weight: z.number(),
                number: z.number().optional(),
                content: z.unknown().optional(),
                externalId: z.string().nullable().optional(),
              }),
            )
            .optional(),
        })
        .nullable()
        .optional(),
      drafts: z
        .array(
          z.object({
            id: z.string(),
            subjectId: z.string(),
            number: z.number(),
            status: z.string(),
            content: z.unknown(),
            externalId: z.string().nullable().optional(),
          }),
        )
        .optional(),
    }),
  ),
});

/**
 * An agent or workflow version an experiment run must use instead of the live one: the fix
 * being tested inside a workflow that calls it. `resolve` of that subject returns it during the run.
 */
export const ClaimedPinSchema = z.object({
  kind: SubjectKindSchema,
  slug: z.string(),
  versionId: z.string(),
  content: z.record(z.string(), z.unknown()),
  /** A harness version's model (the run's own subject; LittleDB sends none for other pins yet). */
  model: ResolvedModelSchema.optional(),
});

/** One experiment run handed to an eval worker by `POST /v1/worker/claim`. */
export const ClaimedRunSchema = z.object({
  runId: z.string(),
  experimentId: z.string(),
  traceId: z.string(),
  subjectId: z.string().optional(),
  itemId: z.string().optional(),
  versionId: z.string().optional(),
  repetition: z.number(),
  /** Which claim of the run this is; heartbeats and the completion send it back. Older servers leave it out. */
  attempt: z.number().int().optional(),
  leaseUntil: z.string(),
  subject: z.object({ kind: SubjectKindSchema, slug: z.string() }).nullable(),
  version: z
    .object({
      id: z.string(),
      number: z.number(),
      content: z.record(z.string(), z.unknown()),
      externalId: z.string().nullable().optional(),
      /** A harness version's model, as resolve would answer it. */
      model: ResolvedModelSchema.optional(),
    })
    .nullable(),
  item: z
    .object({
      id: z.string(),
      input: z.unknown(),
      expected: z.unknown().optional(),
      metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    })
    .nullable(),
  pins: z.array(ClaimedPinSchema).optional(),
});

export const ClaimResponseSchema = z.object({ runs: z.array(ClaimedRunSchema) });

/** `POST /v1/worker/runs/:runId/complete`. `workerId` and `attempt` name the claim it reports for. */
export const CompleteRunSchema = z.object({
  workerId: z.string().optional(),
  attempt: z.number().int().optional(),
  traceId: z.string().optional(),
  output: z.unknown().optional(),
  error: z.string().max(10_000).optional(),
  scores: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        value: z.number().finite().optional(),
        label: z.string().max(200).optional(),
        comment: z.string().max(10_000).optional(),
      }),
    )
    .max(50)
    .optional(),
});

/** A rating or numeric answer's scale: answers run from 1 to `scale`. */
const FeedbackScale = z.number().int().min(2).max(10);
const FeedbackQuestion = z.string().min(1).max(200);
const onScale = (answer: { value: number; scale?: number | undefined }) => answer.value >= 1 && answer.value <= (answer.scale ?? 5);

/** One survey answer: yes or no, a number on a scale, one of your choices, or free text. */
export const FeedbackAnswerSchema = z.union([
  z.strictObject({ question: FeedbackQuestion, value: z.boolean() }),
  z
    .strictObject({ question: FeedbackQuestion, value: z.number().finite(), scale: FeedbackScale })
    .refine(onScale, { message: "A numeric answer runs from 1 to its scale.", path: ["value"] }),
  z.strictObject({ question: FeedbackQuestion, choice: z.string().min(1).max(200) }),
  z.strictObject({ question: FeedbackQuestion, text: z.string().min(1).max(4000) }),
]);

export const FeedbackRatingSchema = z
  .strictObject({ value: z.number().finite(), scale: FeedbackScale.optional() })
  .refine(onScale, { message: "A rating runs from 1 to its scale (default 5).", path: ["value"] });

/** `POST /v1/feedback`: what an end user said about a turn, stored as scores with source `user`. */
export const FeedbackRequestSchema = z
  .object({
    /** The turn the user reacted to. It does not have to be ingested yet. */
    traceId: Id.optional(),
    /** With no `traceId`: the session's latest trace. */
    sessionId: z.string().min(1).max(200).optional(),
    spanId: Id.optional(),
    /** The end user, pseudonymous. */
    userId: z.string().min(1).max(200).optional(),
    /** A stable id: sending it again replaces the earlier answer. */
    id: Id.optional(),
    /**
     * The order of changes under `id`: LittleDB keeps the highest revision it has applied (a
     * retraction's included) and answers an older one with `stale: true`, changing nothing.
     */
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    /** The score name for `thumbs` and `rating`. Default `thumbs` / `rating`. */
    name: z.string().min(1).max(200).optional(),
    thumbs: z.enum(["up", "down"]).optional(),
    rating: FeedbackRatingSchema.optional(),
    comment: z.string().min(1).max(4000).optional(),
    survey: z.string().min(1).max(200).optional(),
    answers: z.array(FeedbackAnswerSchema).min(1).max(20).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((feedback) => feedback.traceId !== undefined || feedback.sessionId !== undefined, {
    message: "Feedback needs a traceId or a sessionId.",
  })
  .refine((feedback) => feedback.revision === undefined || feedback.id !== undefined, {
    message: "A revision orders the changes to one feedback id: send the id too.",
    path: ["revision"],
  })
  .refine(
    (feedback) =>
      feedback.thumbs !== undefined || feedback.rating !== undefined || feedback.comment !== undefined || feedback.answers !== undefined,
    { message: "Feedback needs thumbs, a rating, a comment or answers." },
  );

/**
 * The `201` answer to `POST /v1/feedback`: one score per answer. With `stale: true` (a `200`),
 * LittleDB holds this id at a higher revision, or at this one with a retraction, and nothing
 * changed; `revision` is the one it holds. The same report again at the revision applied is
 * answered as the first time, and a different one there is a `409` (`revision_conflict`).
 */
export const FeedbackResultSchema = z.object({
  traceId: z.string(),
  stale: z.boolean().optional(),
  revision: z.number().optional(),
  scores: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      value: z.number().nullable().optional(),
      label: z.string().nullable().optional(),
    }),
  ),
});

/**
 * `DELETE /v1/feedback/:id`. `stale: true` when LittleDB holds the id at a higher revision (or,
 * without a revision, at any), with the `revision` it holds.
 */
export const FeedbackRetractedSchema = z.object({ removed: z.number(), stale: z.boolean().optional(), revision: z.number().optional() });

export type Environment = z.infer<typeof EnvironmentSchema>;
export type WorkflowOrigin = z.infer<typeof WorkflowOriginSchema>;
export type SpanType = z.infer<typeof SpanTypeSchema>;
export type SpanStatus = z.infer<typeof StatusSchema>;
export type SubjectKind = z.infer<typeof SubjectKindSchema>;
export type Usage = z.infer<typeof UsageSchema>;
export type Trigger = z.infer<typeof TriggerSchema>;
export type TraceInput = z.infer<typeof TraceSchema>;
export type ComputeUsage = z.infer<typeof ComputeUsageSchema>;
export type SpanInput = z.infer<typeof SpanSchema>;
export type ScoreInput = z.infer<typeof ScoreSchema>;
export type ScoreSource = z.infer<typeof ScoreSourceSchema>;
export type IngestBatch = z.infer<typeof IngestBatchSchema>;
export type ResolveRequest = z.infer<typeof ResolveRequestSchema>;
export type ResolvedModel = z.infer<typeof ResolvedModelSchema>;
export type ResolveResponse = z.infer<typeof ResolveResponseSchema>;
export type ResolveMode = z.infer<typeof ResolveModeSchema>;
export type CodeState = z.infer<typeof CodeStateSchema>;
export type Caller = z.infer<typeof CallerSchema>;
export type ClaimedPin = z.infer<typeof ClaimedPinSchema>;
export type AgentWorkflowRegistration = z.infer<typeof AgentWorkflowRegistrationSchema>;
export type AgentWorkflowRegistered = z.infer<typeof AgentWorkflowRegisteredSchema>;
export type AgentWorkflowList = z.infer<typeof AgentWorkflowListSchema>;
export type ClaimedRun = z.infer<typeof ClaimedRunSchema>;
export type CompleteRun = z.infer<typeof CompleteRunSchema>;
export type FeedbackRequest = z.infer<typeof FeedbackRequestSchema>;
export type FeedbackResult = z.infer<typeof FeedbackResultSchema>;
export type FeedbackRetracted = z.infer<typeof FeedbackRetractedSchema>;
