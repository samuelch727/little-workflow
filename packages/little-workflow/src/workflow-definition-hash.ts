import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { sha256Digest } from "./canonical.js";
import {
  model,
  resolveModelSlots,
  type ResolvedModelSlot,
} from "./model-slots.js";
import { normalizeOutputMode, normalizeSchema } from "./schema.js";
import type {
  MemoryConfig,
  ModelSlot,
  Skill,
  ToolSelectionPolicy,
} from "./authoring.js";
import {
  normalizeBashCapabilities,
  type BashCapabilities,
  type NormalizedBashCapabilities,
} from "./bash-tool.js";
import {
  remoteSkillIdentityFromValue,
  remoteSkillIdentityKey,
  type RemoteSkillIdentity,
} from "./skills.js";
import type { AiSdkTool, ToolRegistry } from "./tool-registry.js";

type MemoryMode = "rw" | "ro" | "none";

export type WorkflowDefinitionSnapshot = {
  readonly id: string;
  readonly description: string;
  readonly inputSchemaHash: string;
  readonly outputSchemaHash: string;
  readonly modelSlots: readonly WorkflowDefinitionModelSlotSnapshot[];
  readonly plannerConfig: {
    readonly modelSlotId: string;
    readonly modelIdentity: WorkflowDefinitionModelSlotSnapshot;
    readonly harnessId: string;
    readonly systemHash: string;
    readonly skillsHash: string;
  };
  readonly workerConfig: {
    readonly harnessId: string;
    readonly skillsHash: string;
  };
  readonly globalTools: readonly string[];
  readonly globalToolsHash: string;
  readonly toolSelection: ToolSelectionPolicy;
  readonly memoryConfig: {
    readonly workflow: MemoryMode;
    readonly org: MemoryMode;
    readonly attached: readonly { readonly id: string; readonly mode: "ro" }[];
  };
  readonly bashConfig: NormalizedBashCapabilities;
};

export type WorkflowDefinitionModelSlotSnapshot = {
  readonly id: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly description: string;
};

export type PlanningDefinitionSnapshot = {
  readonly id: string;
  readonly description: string;
  readonly inputSchema: {
    readonly hash: string;
    readonly summary: PlanningSchemaSummary;
  };
  readonly suggestedInputSchema?: {
    readonly descriptor: unknown;
    readonly hash: string;
  };
  readonly requestedOutput: unknown;
  readonly requestedOutputHash: string;
  readonly modelSlots: readonly WorkflowDefinitionModelSlotSnapshot[];
  readonly plannerConfig: {
    readonly modelSlotId: string;
    readonly modelIdentity: WorkflowDefinitionModelSlotSnapshot;
    readonly harnessId: string;
    readonly systemHash: string;
    readonly skillsHash: string;
  };
  readonly plannerVisibleTools: readonly PlanningToolSnapshot[];
  readonly plannerVisibleToolsHash: string;
  readonly toolSelection: ToolSelectionPolicy;
};

export type PlanningSchemaSummary =
  | { readonly kind: "boolean"; readonly value: boolean }
  | {
      readonly type: string;
      readonly required: readonly string[];
      readonly properties: readonly string[];
    };

export type PlanningToolSnapshot = {
  readonly name: string;
  readonly registered: boolean;
  readonly descriptionHash?: string;
  readonly inputSchemaHash?: string;
  readonly outputSchemaHash?: string;
  readonly approvalPolicy?: string;
};

export type WorkflowDefinitionSnapshotInput = {
  readonly id: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly suggestedInputSchema?: unknown;
  readonly output?: unknown;
  readonly outputSchema?: unknown;
  readonly models?: readonly ModelSlot[];
  readonly planner?: {
    readonly model?: unknown;
    readonly harness?: unknown;
    readonly system?: string;
    readonly skills?: readonly Skill[];
  };
  readonly worker?: {
    readonly harness?: unknown;
    readonly skills?: readonly Skill[];
  };
  readonly globalTools?: readonly string[];
  readonly toolSelection?: ToolSelectionPolicy;
  readonly memory?: MemoryConfig;
  readonly bash?: BashCapabilities;
};

export function getWorkflowDefinitionSnapshot(
  workflow: WorkflowDefinitionSnapshotInput,
  tools?: ToolRegistry,
): WorkflowDefinitionSnapshot {
  const planner = workflow.planner;
  const worker = workflow.worker;
  const plannerSlot = resolvePrivatePlannerModelSlot(planner?.model);
  const globalTools = sortedStrings(workflow.globalTools ?? []);
  const toolSnapshots = globalToolSnapshots(globalTools, tools);
  const plannerSlotSnapshot = modelSlotSnapshot(plannerSlot);

  return {
    id: workflow.id,
    description: workflow.description ?? "",
    inputSchemaHash: sha256Digest(normalizeSchema(workflow.inputSchema ?? true)),
    outputSchemaHash: sha256Digest(outputContractFor(workflow)),
    modelSlots: modelSlotSnapshots(workflow.models ?? [], plannerSlot),
    plannerConfig: {
      modelSlotId: plannerSlot.slotId,
      modelIdentity: plannerSlotSnapshot,
      harnessId: harnessIdFor(planner?.harness),
      systemHash: sha256Digest(planner?.system ?? ""),
      skillsHash: skillsHash(planner?.skills),
    },
    workerConfig: {
      harnessId: harnessIdFor(worker?.harness),
      skillsHash: skillsHash(worker?.skills),
    },
    globalTools,
    globalToolsHash: sha256Digest(toolSnapshots),
    toolSelection: workflow.toolSelection ?? "planner_selected",
    memoryConfig: memoryConfigSnapshot(workflow.memory),
    bashConfig: normalizeBashCapabilities(workflow.bash),
  };
}

export function getWorkflowDefinitionHash(
  workflow: WorkflowDefinitionSnapshotInput,
  tools?: ToolRegistry,
): string {
  return sha256Digest(getWorkflowDefinitionSnapshot(workflow, tools));
}

export function getPlanningDefinitionSnapshot(
  workflow: WorkflowDefinitionSnapshotInput,
  tools?: ToolRegistry,
): PlanningDefinitionSnapshot {
  const planner = workflow.planner;
  const plannerSlot = resolvePrivatePlannerModelSlot(planner?.model);
  const plannerSlotSnapshot = modelSlotSnapshot(plannerSlot);
  const inputSchema = normalizeSchema(workflow.inputSchema ?? true);
  const suggestedInputSchema = workflow.suggestedInputSchema === undefined
    ? undefined
    : normalizeSchema(workflow.suggestedInputSchema);
  const requestedOutput = outputContractFor(workflow);
  const plannerVisibleTools = globalToolSnapshots(sortedStrings(workflow.globalTools ?? []), tools);

  return {
    id: workflow.id,
    description: workflow.description ?? "",
    inputSchema: {
      hash: sha256Digest(inputSchema),
      summary: schemaSummary(inputSchema),
    },
    ...(suggestedInputSchema === undefined
      ? {}
      : {
          suggestedInputSchema: {
            descriptor: suggestedInputSchema,
            hash: sha256Digest(suggestedInputSchema),
          },
        }),
    requestedOutput,
    requestedOutputHash: sha256Digest(requestedOutput),
    modelSlots: modelSlotSnapshots(workflow.models ?? [], plannerSlot),
    plannerConfig: {
      modelSlotId: plannerSlot.slotId,
      modelIdentity: plannerSlotSnapshot,
      harnessId: harnessIdFor(planner?.harness),
      systemHash: sha256Digest(planner?.system ?? ""),
      skillsHash: skillsHash(planner?.skills),
    },
    plannerVisibleTools,
    plannerVisibleToolsHash: sha256Digest(plannerVisibleTools),
    toolSelection: workflow.toolSelection ?? "planner_selected",
  };
}

export function getPlanningDefinitionHash(
  workflow: WorkflowDefinitionSnapshotInput,
  tools?: ToolRegistry,
): string {
  return sha256Digest(getPlanningDefinitionSnapshot(workflow, tools));
}

function modelSlotSnapshots(
  slots: readonly ModelSlot[],
  plannerSlot: ResolvedModelSlot,
): readonly WorkflowDefinitionModelSlotSnapshot[] {
  const snapshots = [
    ...resolveModelSlots(uniqueModelSlots(slots)).map(modelSlotSnapshot),
    modelSlotSnapshot(plannerSlot),
  ];
  return [...uniqueModelSlotSnapshots(snapshots)]
    .sort(compareModelSlotSnapshots);
}

function modelSlotSnapshot(slot: ResolvedModelSlot): WorkflowDefinitionModelSlotSnapshot {
  return {
    id: slot.slotId,
    providerId: slot.providerId ?? "",
    modelId: slot.modelId ?? "",
    description: slot.metadata.description ?? "",
  };
}

function resolvePrivatePlannerModelSlot(value: unknown): ResolvedModelSlot {
  const [slot] = resolveModelSlots([isModelSlot(value) ? value : model(value ?? {})]);
  if (slot === undefined) {
    throw new Error("workflow definition hash: planner model slot resolution failed.");
  }
  return slot;
}

function outputContractFor(workflow: WorkflowDefinitionSnapshotInput): unknown {
  const output = normalizeOutputMode(workflow.output ?? {
    kind: "object",
    schema: workflow.outputSchema ?? true,
  });
  const metadata = {
    name: output.name ?? "",
    description: output.description ?? "",
  };

  switch (output.kind) {
    case "text":
      return { kind: "text", ...metadata };
    case "object":
      return { kind: "object", schema: output.schema, ...metadata };
    case "array":
      return { kind: "array", element: output.element, ...metadata };
    case "choice":
      return { kind: "choice", values: output.values, ...metadata };
    case "json":
      return {
        kind: "json",
        schema: output.schema ?? null,
        ...metadata,
      };
  }
}

function memoryConfigSnapshot(memory: MemoryConfig | undefined): WorkflowDefinitionSnapshot["memoryConfig"] {
  return {
    workflow: memory?.workflow ?? "rw",
    org: memory?.org ?? "ro",
    attached: [...(memory?.attach ?? [])].sort((left, right) =>
      compareStrings(left.id, right.id) || compareStrings(left.mode, right.mode)
    ),
  };
}

function skillsHash(skills: readonly Skill[] | undefined): string {
  return sha256Digest(
    [...(skills ?? [])]
      .map(skillIdentity)
      .sort((left, right) =>
        compareStrings(left.name, right.name) ||
        compareStrings(left.frontmatterHash, right.frontmatterHash) ||
        compareStrings(remoteSkillIdentityKey(left.remote), remoteSkillIdentityKey(right.remote))
      ),
  );
}

function skillIdentity(
  skill: Skill,
): { readonly name: string; readonly frontmatterHash: string; readonly remote?: RemoteSkillIdentity } {
  const remote = remoteSkillIdentityFromValue(skill.remote);
  if (skill.name !== undefined && skill.frontmatterHash !== undefined) {
    return {
      name: skill.name,
      frontmatterHash: skill.frontmatterHash,
      ...(remote === undefined ? {} : { remote }),
    };
  }

  const identity = readSkillSourceIdentity(skill.source);
  if (identity !== undefined) {
    return { ...identity, ...(remote === undefined ? {} : { remote }) };
  }

  throw new Error(
    `workflow definition hash: skill '${skill.source}' must provide name and frontmatterHash or use an absolute local source with frontmatter.`,
  );
}

function readSkillSourceIdentity(
  source: string,
): { readonly name: string; readonly frontmatterHash: string } | undefined {
  if (isUrl(source) || !isAbsolute(source)) {
    return undefined;
  }

  try {
    const stats = statSync(source);
    const path = stats.isDirectory() ? join(source, "SKILL.md") : source;
    const contents = readFileSync(path, "utf8");
    const frontmatter = leadingFrontmatter(contents);
    if (frontmatter === undefined) {
      return undefined;
    }
    const name = frontmatterName(frontmatter);
    if (name === undefined) {
      throw new Error(
        `workflow definition hash: skill '${source}' frontmatter must include name.`,
      );
    }
    return { name, frontmatterHash: sha256Digest({ frontmatter }) };
  } catch {
    return undefined;
  }
}

function leadingFrontmatter(contents: string): string | undefined {
  if (!contents.startsWith("---\n") && !contents.startsWith("---\r\n")) {
    return undefined;
  }

  const newline = contents.startsWith("---\r\n") ? "\r\n" : "\n";
  const start = 3 + newline.length;
  const endMarker = `${newline}---`;
  const end = contents.indexOf(endMarker, start);
  if (end === -1) {
    return undefined;
  }

  return contents.slice(start, end);
}

function frontmatterName(frontmatter: string): string | undefined {
  for (const line of frontmatter.split(/\r?\n/u)) {
    const match = /^name:\s*(.+?)\s*$/u.exec(line);
    if (match === null) {
      continue;
    }
    const raw = match[1] ?? "";
    const unquoted = raw.replace(/^["']|["']$/gu, "").trim();
    return unquoted.length === 0 ? undefined : unquoted;
  }
  return undefined;
}

function isUrl(source: string): boolean {
  try {
    const url = new URL(source);
    return url.protocol.length > 1;
  } catch {
    return false;
  }
}

function globalToolSnapshots(
  names: readonly string[],
  tools: ToolRegistry | undefined,
): readonly PlanningToolSnapshot[] {
  return names
    .map((name) => globalToolSnapshot(name, tools?.get(name)))
    .sort(compareToolSnapshots);
}

function globalToolSnapshot(
  name: string,
  tool: AiSdkTool | undefined,
): PlanningToolSnapshot {
  if (tool === undefined) {
    return { name, registered: false };
  }

  const description = typeof tool.description === "string" ? tool.description : "";
  return {
    name,
    registered: true,
    descriptionHash: sha256Digest(description),
    ...(tool.inputSchema === undefined
      ? {}
      : { inputSchemaHash: sha256Digest(normalizeSchema(tool.inputSchema)) }),
    ...(tool.outputSchema === undefined
      ? {}
      : { outputSchemaHash: sha256Digest(normalizeSchema(tool.outputSchema)) }),
    approvalPolicy: approvalPolicyFor(tool.needsApproval),
  };
}

function approvalPolicyFor(needsApproval: AiSdkTool["needsApproval"]): string {
  if (needsApproval === undefined) {
    return "none";
  }
  if (typeof needsApproval === "function") {
    throw new Error(
      "workflow definition hash: function-valued tool approval predicates are not hashable; use a boolean approval policy.",
    );
  }
  return needsApproval ? "required" : "not_required";
}

function schemaSummary(schema: unknown): PlanningSchemaSummary {
  if (typeof schema === "boolean") {
    return { kind: "boolean", value: schema };
  }
  if (!isRecord(schema)) {
    return { type: "unknown", required: [], properties: [] };
  }
  const rawType = schema.type;
  const type = typeof rawType === "string" ? rawType : "unknown";
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
  const properties = isRecord(schema.properties)
    ? Object.keys(schema.properties)
    : [];
  return {
    type,
    required: sortedStrings(required),
    properties: sortedStrings(properties),
  };
}

function harnessIdFor(harness: unknown): string {
  const id = propertyValue(harness, "harnessId");
  return typeof id === "string" && id.length > 0 ? id : "customHarness@unknown";
}

function uniqueModelSlots(slots: readonly ModelSlot[]): readonly ModelSlot[] {
  const unique: ModelSlot[] = [];
  for (const slot of slots) {
    if (!unique.includes(slot)) {
      unique.push(slot);
    }
  }
  return unique;
}

function uniqueModelSlotSnapshots(
  snapshots: readonly WorkflowDefinitionModelSlotSnapshot[],
): readonly WorkflowDefinitionModelSlotSnapshot[] {
  const unique: WorkflowDefinitionModelSlotSnapshot[] = [];
  const seen = new Set<string>();
  for (const snapshot of snapshots) {
    const key = `${snapshot.id}\0${snapshot.providerId}\0${snapshot.modelId}\0${snapshot.description}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(snapshot);
  }
  return unique;
}

function compareModelSlotSnapshots(
  left: WorkflowDefinitionModelSlotSnapshot,
  right: WorkflowDefinitionModelSlotSnapshot,
): number {
  return (
    compareStrings(left.id, right.id) ||
    compareStrings(left.providerId, right.providerId) ||
    compareStrings(left.modelId, right.modelId) ||
    compareStrings(left.description, right.description)
  );
}

function compareToolSnapshots(
  left: ReturnType<typeof globalToolSnapshot>,
  right: ReturnType<typeof globalToolSnapshot>,
): number {
  return compareStrings(left.name, right.name);
}

function sortedStrings(values: readonly string[]): readonly string[] {
  return [...values].sort(compareStrings);
}

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  const leftCodePoints = Array.from(left);
  const rightCodePoints = Array.from(right);
  const length = Math.min(leftCodePoints.length, rightCodePoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftCodePoint = leftCodePoints[index]?.codePointAt(0) ?? 0;
    const rightCodePoint = rightCodePoints[index]?.codePointAt(0) ?? 0;
    if (leftCodePoint !== rightCodePoint) {
      return leftCodePoint < rightCodePoint ? -1 : 1;
    }
  }

  return leftCodePoints.length < rightCodePoints.length ? -1 : 1;
}

function isModelSlot(value: unknown): value is ModelSlot {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    propertyValue(value, "metadata") !== undefined &&
    propertyValue(value, "aiSdkModel") !== undefined
  );
}

function propertyValue(value: unknown, key: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }
  return Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
