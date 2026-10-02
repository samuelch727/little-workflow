import { z } from "zod";
import { HARNESS_EVENT_TYPES, HARNESS_SIDE_CHANNEL_EVENT_TYPES } from "../events/names.js";
import type { HarnessEvent } from "../types.js";

const TRACE_EVENT_TYPES = [
  ...HARNESS_EVENT_TYPES,
  ...HARNESS_SIDE_CHANNEL_EVENT_TYPES,
  "harness.execute_step.started",
  "harness.execute_step.succeeded",
] as const;

export type HarnessTraceEventType = (typeof TRACE_EVENT_TYPES)[number];

const traceEventSchema = z.object({
  schemaVersion: z.literal("lh.trace.v2"),
  eventId: z.string().min(1),
  sequence: z.number().int().positive(),
  type: z.enum(TRACE_EVENT_TYPES),
  sessionId: z.string().min(1),
  occurrenceId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional(),
  stepId: z.string().min(1).optional(),
  parentEventId: z.string().min(1).optional(),
  timestamp: z.string().datetime({ offset: true }),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

const traceContentRefSchema = z
  .object({
    captured: z.boolean(),
    preview: z.string().optional(),
    truncated: z.boolean().optional(),
    contentRef: z.string().startsWith("/artifacts/trace/").optional(),
    bytes: z.number().int().nonnegative().optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    mediaType: z.string().min(1).optional(),
    redacted: z.boolean().optional(),
    redactionReason: z.string().min(1).optional(),
  })
  .strict();

const traceFileDiffSchema = z.discriminatedUnion("available", [
  z
    .object({
      available: z.literal(true),
      format: z.literal("unified"),
      preview: z.string().optional(),
      truncated: z.boolean(),
      contentRef: z.string().startsWith("/artifacts/trace/").optional(),
      bytes: z.number().int().nonnegative().optional(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    })
    .passthrough(),
  z
    .object({
      available: z.literal(false),
      reason: z.enum(["disabled", "non_text", "too_large", "redacted", "content_unavailable"]),
    })
    .passthrough(),
]);

const traceErrorEnvelopeSchema = z
  .object({
    name: z.string().min(1),
    message: z.string().min(1),
    stack: z.string().optional(),
    cause: z
      .union([
        z.record(z.string(), z.unknown()),
        z.string(),
        z.number(),
        z.boolean(),
        z.null(),
      ])
      .optional(),
  })
  .passthrough();

const stringRecordSchema = z.record(z.string(), z.unknown());
const errorValueSchema = z.union([traceErrorEnvelopeSchema, z.string()]);
const managedRootSchema = z.enum(["session", "artifacts", "persistent", "agents"]);
type ManagedRoot = z.infer<typeof managedRootSchema>;
const managedRootHarnessDirs = {
  session: "/session",
  artifacts: "/artifacts",
  persistent: "/persistent",
  agents: "/.agents",
} as const satisfies Record<ManagedRoot, string>;
const modelSchema = z
  .object({
    provider: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
  })
  .passthrough();
const toolDescriptionSchema = z
  .object({
    toolName: z.string().min(1),
    descriptionHash: z.string().min(1).optional(),
    schemaHash: z.string().min(1).optional(),
  })
  .passthrough();
const fileEntrySchema = z
  .object({
    path: z.string().min(1),
    kind: z.enum(["file", "directory"]),
    bytes: z.number().int().nonnegative().optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    mediaType: z.string().min(1).optional(),
  })
  .strict();
const artifactRefSchema = z
  .object({
    id: z.string().min(1),
    path: z.string().min(1),
    bytes: z.number().int().nonnegative().optional(),
    mediaType: z.string().min(1).optional(),
    sha256: z.string().min(1).optional(),
    metadata: stringRecordSchema.optional(),
  })
  .passthrough();
const spooledToolOutputSchema = z
  .object({
    path: z.string().startsWith("/artifacts/"),
    bytes: z.number().int().nonnegative().optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    mediaType: z.string().min(1).optional(),
  })
  .passthrough();

const sessionMetadataSchema = stringRecordSchema;
const modelRequestedMetadataSchema = z
  .object({
    stepNumber: z.number().int().positive(),
    model: modelSchema,
    request: z
      .object({
        promptHash: z.string().min(1),
        system: traceContentRefSchema,
        messages: z.array(
          z
            .object({
              role: z.string().min(1),
              content: traceContentRefSchema,
            })
            .passthrough(),
        ),
        tools: z.array(toolDescriptionSchema),
      })
      .passthrough(),
  })
  .passthrough();
const modelRespondedMetadataSchema = z
  .object({
    stepNumber: z.number().int().positive(),
    model: modelSchema,
    text: traceContentRefSchema,
    finishReason: z.string().min(1).optional(),
    rawFinishReason: z.string().min(1).optional(),
    usage: z.unknown().optional(),
    providerMetadata: z.unknown().optional(),
    warnings: z.array(z.unknown()).optional(),
  })
  .passthrough();
const modelFailedMetadataSchema = z
  .object({
    stepNumber: z.number().int().positive(),
    model: modelSchema,
    durationMs: z.number().nonnegative(),
    error: traceErrorEnvelopeSchema,
    redacted: z.boolean().optional(),
  })
  .passthrough();
const toolBaseMetadataSchema = z
  .object({
    toolName: z.string().min(1),
    toolCallId: z.string().min(1),
    caller: z.enum(["model", "code", "runtime", "host"]),
    input: traceContentRefSchema.optional(),
    output: traceContentRefSchema.optional(),
    contentRef: z.string().startsWith("/artifacts/trace/").optional(),
    spooled: spooledToolOutputSchema.optional(),
    command: z.string().optional(),
    exitCode: z.number().int().optional(),
    durationMs: z.number().nonnegative().optional(),
    error: errorValueSchema.optional(),
  })
  .passthrough();
const toolStartedMetadataSchema = toolBaseMetadataSchema;
const toolSucceededMetadataSchema = toolBaseMetadataSchema;
const toolFailedMetadataSchema = toolBaseMetadataSchema
  .extend({
    error: traceErrorEnvelopeSchema,
  })
  .passthrough();
const runtimeStartedMetadataSchema = z
  .object({
    command: z.string().min(1),
  })
  .passthrough();
const runtimeFinishedMetadataSchema = z
  .object({
    command: z.string().min(1),
    exitCode: z.number().int(),
    durationMs: z.number().nonnegative(),
    stdout: traceContentRefSchema,
    stderr: traceContentRefSchema,
    error: errorValueSchema.optional(),
  })
  .passthrough();
const runtimeErrorMetadataSchema = z
  .object({
    error: errorValueSchema,
  })
  .passthrough();
// Classification reasons are recorded as the classifier produced them, so a reader can meter
// escalation without re-deriving anything; only `kind` is required of each.
const classificationReasonSchema = z
  .object({
    kind: z.string().min(1),
  })
  .passthrough();
const runtimeCommandDeniedMetadataSchema = z
  .object({
    command: z.string().min(1),
    reasons: z.array(classificationReasonSchema),
  })
  .passthrough();
const runtimeTierMetadataSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    trigger: z.enum(["classification", "emulation-gap"]),
    command: z.string().min(1),
    decision: z.enum(["run", "escalate", "deny"]).optional(),
    reasons: z.array(classificationReasonSchema).optional(),
    gap: z
      .object({
        kind: z.literal("emulation-gap"),
        signal: z.string().min(1),
        command: z.string().min(1),
        option: z.string().min(1).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
const runtimeTierUnavailableMetadataSchema = runtimeTierMetadataSchema.extend({
  detail: z.string().min(1),
});
const fileBinaryMetadataSchema = z
  .object({
    bytes: z.number().int().nonnegative(),
    sha256: z.string().min(1),
  })
  .passthrough();
// File events may come from custom workspace mounts (root = mount label, path = /<root>/…),
// not only the four managed roots — pathBelongsToRoot handles both conventions.
const fileRootSchema = z.string().min(1);
const fileMutationObjectSchema = z
  .object({
    path: z.string().startsWith("/"),
    root: fileRootSchema,
    bytes: z.number().int().nonnegative().optional(),
    mediaType: z.string().min(1).optional(),
    sha256: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
    before: fileBinaryMetadataSchema.optional(),
    after: fileBinaryMetadataSchema,
    diff: traceFileDiffSchema,
  })
  .passthrough();
const fileMutationMetadataSchema = fileMutationObjectSchema.refine(
  (metadata) => pathBelongsToRoot(metadata.path, metadata.root),
  { message: "file path must belong to root" },
);
const fileUpdatedMetadataSchema = fileMutationObjectSchema
  .extend({
    before: fileBinaryMetadataSchema,
  })
  .refine((metadata) => pathBelongsToRoot(metadata.path, metadata.root), {
    message: "file path must belong to root",
  });
const fileDeletedMetadataSchema = z
  .object({
    path: z.string().startsWith("/"),
    root: fileRootSchema,
    source: z.string().min(1).optional(),
    before: fileBinaryMetadataSchema,
    diff: traceFileDiffSchema,
  })
  .passthrough()
  .refine((metadata) => pathBelongsToRoot(metadata.path, metadata.root), {
    message: "file path must belong to root",
  });
const fileStagedMetadataSchema = z
  .object({
    path: z.string().startsWith("/"),
    root: managedRootSchema,
    source: z.string().min(1),
    after: fileBinaryMetadataSchema,
  })
  .passthrough()
  .refine((metadata) => pathBelongsToRoot(metadata.path, metadata.root), {
    message: "file path must belong to root",
  });
const filePathMetadataSchema = z
  .object({
    path: z.string().startsWith("/"),
  })
  .passthrough();
const artifactCreatedMetadataSchema = z
  .object({
    path: z.string().startsWith("/artifacts/"),
    artifact: artifactRefSchema,
  })
  .passthrough();
const filesystemMountedMetadataSchema = z
  .object({
    root: managedRootSchema,
    harnessDir: z.string().startsWith("/"),
    source: z.enum(["session", "skill", "persistent_dir", "runtime"]),
    writable: z.boolean(),
    commit: z.enum(["after-turn", "manual", "read-only"]).optional(),
    fileCount: z.number().int().nonnegative(),
    files: z.array(fileEntrySchema),
  })
  .passthrough()
  .refine((metadata) => metadata.harnessDir === managedRootHarnessDirs[metadata.root], {
    message: "harness.filesystem.mounted harnessDir must match root",
  })
  .refine(
    (metadata) =>
      metadata.files.every((entry) => pathBelongsToRoot(entry.path, metadata.root)),
    { message: "harness.filesystem.mounted files must belong to root" },
  );
const persistentDirMetadataSchema = z
  .object({
    harnessDir: z.string().startsWith("/persistent"),
    commit: z.enum(["after-turn", "manual", "read-only"]),
  })
  .passthrough();
const persistentDirChangeCountsSchema = z
  .object({
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    deleted: z.number().int().nonnegative(),
  })
  .strict();
const persistentDirChangesSchema = z
  .object({
    created: z.array(fileEntrySchema),
    updated: z.array(fileEntrySchema),
    deleted: z.array(fileEntrySchema),
  })
  .strict();
const persistentDirLoadedMetadataSchema = persistentDirMetadataSchema
  .extend({
    durationMs: z.number().nonnegative(),
    fileCount: z.number().int().nonnegative(),
    files: z.array(fileEntrySchema),
  })
  .passthrough();
const persistentDirCommitMetadataSchema = persistentDirMetadataSchema
  .extend({
    changeCounts: persistentDirChangeCountsSchema,
    changes: persistentDirChangesSchema,
  })
  .passthrough();
const persistentDirCommitCompletedMetadataSchema = persistentDirCommitMetadataSchema
  .extend({
    durationMs: z.number().nonnegative(),
  })
  .passthrough();
const persistentDirFailedMetadataSchema = persistentDirCommitCompletedMetadataSchema
  .extend({
    error: traceErrorEnvelopeSchema,
  })
  .passthrough();
// `outcome.reported` is a side-channel observation, so only the fields a reader must be able
// to trust are required: the verdict and where it came from. Join keys are OPTIONAL because
// an unresolvable one is omitted rather than written as a placeholder.
const outcomeReportedMetadataSchema = z
  .object({
    status: z.enum(["success", "failure", "partial"]),
    source: z.string().min(1),
    retracted: z.boolean().optional(),
    score: z.number().optional(),
    detail: z.string().optional(),
    reporter: z.string().min(1).optional(),
    reportKey: z.string().min(1).optional(),
    stepPath: z.string().min(1).optional(),
    promptHash: z.string().min(1).optional(),
  })
  .passthrough();

export function validateTraceEvent(event: unknown): HarnessEvent<HarnessTraceEventType> {
  const parsed = traceEventSchema.parse(event);
  const metadata = metadataSchemaFor(parsed.type).parse(parsed.metadata);
  return { ...parsed, metadata } as HarnessEvent<HarnessTraceEventType>;
}

function metadataSchemaFor(type: HarnessTraceEventType): z.ZodTypeAny {
  switch (type) {
    case "harness.session.started":
    case "harness.session.completed":
    case "harness.session.failed":
      return sessionMetadataSchema;
    case "harness.model.called":
      return modelRequestedMetadataSchema;
    case "harness.model.responded":
      return modelRespondedMetadataSchema;
    case "harness.model.failed":
      return modelFailedMetadataSchema;
    case "harness.tool_call.started":
      return toolStartedMetadataSchema;
    case "harness.tool_call.succeeded":
      return toolSucceededMetadataSchema;
    case "harness.tool_call.failed":
      return toolFailedMetadataSchema;
    case "harness.execute_step.started":
    case "harness.execute_step.succeeded":
      return stringRecordSchema;
    case "outcome.reported":
      return outcomeReportedMetadataSchema;
    case "harness.runtime.command.started":
      return runtimeStartedMetadataSchema;
    case "harness.runtime.command.succeeded":
    case "harness.runtime.command.failed":
      return runtimeFinishedMetadataSchema;
    case "harness.runtime.command.denied":
      return runtimeCommandDeniedMetadataSchema;
    case "harness.runtime.tier.escalated":
      return runtimeTierMetadataSchema;
    case "harness.runtime.tier.unavailable":
      return runtimeTierUnavailableMetadataSchema;
    case "harness.runtime.error":
    // Turn teardown reports the same envelope shape as any other runtime error.
    case "harness.runtime.dispose.failed":
      return runtimeErrorMetadataSchema;
    case "harness.file.created":
      return fileMutationMetadataSchema;
    case "harness.file.updated":
      return fileUpdatedMetadataSchema;
    case "harness.file.deleted":
      return fileDeletedMetadataSchema;
    case "harness.file.written_by_tool":
      return fileUpdatedMetadataSchema.or(fileMutationMetadataSchema);
    case "harness.file.staged_from_message":
    case "harness.file.staged_from_host":
      return fileStagedMetadataSchema;
    case "harness.artifact.created":
      return artifactCreatedMetadataSchema;
    case "harness.filesystem.mounted":
      return filesystemMountedMetadataSchema;
    case "harness.persistent_dir.loaded":
      return persistentDirLoadedMetadataSchema;
    case "harness.persistent_dir.commit.started":
      return persistentDirCommitMetadataSchema;
    case "harness.persistent_dir.commit.succeeded":
      return persistentDirCommitCompletedMetadataSchema;
    case "harness.persistent_dir.commit.failed":
      return persistentDirFailedMetadataSchema;
  }
}

function pathBelongsToRoot(pathname: string, root: string): boolean {
  // Managed roots keep their harness-dir mapping (notably "agents" → "/.agents", the
  // historical wire shape); custom mount labels map to `/<label>` directly.
  const candidates = new Set<string>([`/${root}`]);
  if (isManagedRoot(root)) {
    candidates.add(managedRootHarnessDirs[root]);
  }
  for (const harnessDir of candidates) {
    if (pathname === harnessDir || pathname.startsWith(`${harnessDir}/`)) {
      return true;
    }
  }
  return false;
}

function isManagedRoot(root: string): root is ManagedRoot {
  return Object.hasOwn(managedRootHarnessDirs, root);
}
