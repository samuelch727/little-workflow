import { canonicalJson, sha256Digest } from "./canonical.js";
import type { LocalWorld } from "./authoring.js";
import {
  normalizeBashCapabilities,
  type BashCapabilities,
} from "./bash-tool.js";
import { normalizeHarnessEventType } from "./harness/event-names.js";
import { remoteSkillIdentityKey, type RemoteSkillIdentity } from "./skills.js";
import type { ToolRegistry } from "./tool-registry.js";
import { type RunId } from "./world.js";

type JsonRecord = Record<string, unknown>;

export type HarnessManifest =
  | PlannerManifest
  | WorkerManifest
  | OrchestratorManifest
  | FixerManifest;

export type SkillManifestIdentity = {
  readonly name: string;
  readonly frontmatterHash: string;
  readonly remote?: RemoteSkillIdentity;
};

export type PlannerManifest = {
  readonly harnessId: string;
  readonly plannerModelSlotId: string;
  readonly systemPromptHash: string;
  readonly skillsHash: string;
  readonly workflowDefinitionHash: string;
  readonly globalToolsHash: string;
  readonly memoryStoreIds: readonly string[];
  readonly bashCapabilitiesHash: string;
  readonly outerLoopContextHash?: string;
};

export type WorkerManifest = {
  readonly harnessId: string;
  readonly workflowDefinitionHash: string;
  readonly workflowVersionId: string;
  readonly stepPath: string;
  readonly stepConfigHash: string;
  readonly skillsHash: string;
  readonly allowedToolsHash: string;
  readonly memoryStoreIds: readonly string[];
  readonly bashCapabilitiesHash: string;
  readonly modelSlotId?: string;
  readonly systemPromptHash?: string;
};

export type OrchestratorManifest = {
  readonly harnessId: string;
  readonly orchestratorModelSlotId: string;
  readonly systemPromptHash: string;
  readonly skillsHash: string;
  readonly availableWorkflows: ReadonlyArray<{
    readonly id: string;
    readonly definitionHash: string;
  }>;
  readonly globalToolsHash: string;
  readonly memoryStoreIds: readonly string[];
  readonly bashCapabilitiesHash: string;
  readonly maxConcurrentSubRuns: number;
};

export type FixerManifest = WorkerManifest & {
  readonly fixerModelSlotId: string;
  readonly fixerSystemHash: string;
  readonly fixerMaxAttempts: number;
};

export type PlannerManifestInput = {
  readonly harnessId: string;
  readonly plannerModelSlotId: string;
  readonly systemPrompt?: string;
  readonly skills?: ReadonlyArray<SkillManifestIdentity>;
  readonly workflowDefinitionHash: string;
  readonly toolRegistry?: ToolRegistry;
  readonly memoryStoreIds?: readonly string[];
  readonly bashCapabilities?: BashCapabilities;
  readonly outerLoopContext?: unknown;
};

export type WorkerManifestInput = {
  readonly harnessId: string;
  readonly workflowDefinitionHash: string;
  readonly workflowVersionId: string;
  readonly stepPath: string;
  readonly stepConfig: unknown;
  readonly skills?: ReadonlyArray<SkillManifestIdentity>;
  readonly allowedTools: readonly string[];
  readonly memoryStoreIds?: readonly string[];
  readonly bashCapabilities?: BashCapabilities;
  readonly modelSlotId?: string;
  readonly systemPrompt?: string;
};

export type OrchestratorManifestInput = {
  readonly harnessId: string;
  readonly orchestratorModelSlotId: string;
  readonly systemPrompt?: string;
  readonly skills?: ReadonlyArray<SkillManifestIdentity>;
  readonly availableWorkflows: ReadonlyArray<{
    readonly id: string;
    readonly definitionHash: string;
  }>;
  readonly toolRegistry?: ToolRegistry;
  readonly memoryStoreIds?: readonly string[];
  readonly bashCapabilities?: BashCapabilities;
  readonly maxConcurrentSubRuns: number;
};

export type FixerManifestInput = WorkerManifestInput & {
  readonly fixerModelSlotId: string;
  readonly fixerSystem: string;
  readonly fixerMaxAttempts: number;
};

export class CapabilityDriftError extends Error {
  readonly causeCode = "capability_drift";
  readonly runId: RunId;
  readonly storedManifest: unknown;
  readonly currentManifest: HarnessManifest;
  readonly diff: readonly string[];

  constructor(options: {
    readonly runId: RunId;
    readonly storedManifest: unknown;
    readonly currentManifest: HarnessManifest;
    readonly diff: readonly string[];
  }) {
    super(
      `CapabilityDriftError: run '${options.runId}' manifest changed:\n${options.diff.map((line) => `- ${line}`).join("\n")}`,
    );
    this.name = "CapabilityDriftError";
    this.runId = options.runId;
    this.storedManifest = options.storedManifest;
    this.currentManifest = options.currentManifest;
    this.diff = options.diff;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function plannerManifest(input: PlannerManifestInput): PlannerManifest {
  return stripUndefined({
    harnessId: input.harnessId,
    plannerModelSlotId: input.plannerModelSlotId,
    systemPromptHash: sha256Digest(input.systemPrompt ?? ""),
    skillsHash: skillsHash(input.skills),
    workflowDefinitionHash: input.workflowDefinitionHash,
    globalToolsHash: hashToolRegistry(input.toolRegistry),
    memoryStoreIds: sortedStrings(input.memoryStoreIds ?? []),
    bashCapabilitiesHash: hashBashCapabilities(input.bashCapabilities),
    ...(input.outerLoopContext === undefined
      ? {}
      : { outerLoopContextHash: sha256Digest(input.outerLoopContext) }),
  }) as PlannerManifest;
}

export function workerManifest(input: WorkerManifestInput): WorkerManifest {
  return stripUndefined({
    harnessId: input.harnessId,
    workflowDefinitionHash: input.workflowDefinitionHash,
    workflowVersionId: input.workflowVersionId,
    stepPath: input.stepPath,
    stepConfigHash: sha256Digest(input.stepConfig),
    ...(input.modelSlotId === undefined ? {} : { modelSlotId: input.modelSlotId }),
    ...(input.systemPrompt === undefined
      ? {}
      : { systemPromptHash: sha256Digest(input.systemPrompt) }),
    skillsHash: skillsHash(input.skills),
    allowedToolsHash: sha256Digest(sortedStrings(input.allowedTools)),
    memoryStoreIds: sortedStrings(input.memoryStoreIds ?? []),
    bashCapabilitiesHash: hashBashCapabilities(input.bashCapabilities),
  }) as WorkerManifest;
}

export function orchestratorManifest(input: OrchestratorManifestInput): OrchestratorManifest {
  return {
    harnessId: input.harnessId,
    orchestratorModelSlotId: input.orchestratorModelSlotId,
    systemPromptHash: sha256Digest(input.systemPrompt ?? ""),
    skillsHash: skillsHash(input.skills),
    availableWorkflows: [...input.availableWorkflows]
      .sort((left, right) => compareStrings(left.id, right.id)),
    globalToolsHash: hashToolRegistry(input.toolRegistry),
    memoryStoreIds: sortedStrings(input.memoryStoreIds ?? []),
    bashCapabilitiesHash: hashBashCapabilities(input.bashCapabilities),
    maxConcurrentSubRuns: input.maxConcurrentSubRuns,
  };
}

export function fixerManifest(input: FixerManifestInput): FixerManifest {
  return {
    ...workerManifest(input),
    fixerModelSlotId: input.fixerModelSlotId,
    fixerSystemHash: sha256Digest(input.fixerSystem),
    fixerMaxAttempts: input.fixerMaxAttempts,
  };
}

export function hashHarnessManifest(manifest: HarnessManifest): string {
  return sha256Digest(manifest);
}

export async function checkHarnessManifestDrift(
  world: LocalWorld,
  runId: RunId,
  currentManifest: HarnessManifest,
): Promise<void> {
  const events = await world.listEvents(runId);
  const currentScope = harnessManifestScope(currentManifest);
  const started = events.find((event) => {
    if (normalizeHarnessEventType(event.type) !== "harness.session.started") {
      return false;
    }
    const storedManifest = event.payload.manifest;
    const storedScope = harnessManifestScope(storedManifest);
    return storedScope.kind === currentScope.kind && storedScope.scopeKey === currentScope.scopeKey;
  });
  if (started === undefined) {
    return;
  }
  const payload = started.payload;
  const storedHash = typeof payload.manifestHash === "string" ? payload.manifestHash : undefined;
  const storedManifest = payload.manifest;
  if (storedHash === undefined || storedManifest === undefined) {
    return;
  }
  const currentHash = hashHarnessManifest(currentManifest);
  if (storedHash === currentHash) {
    return;
  }
  const diff = manifestDiff(storedManifest, currentManifest);
  throw new CapabilityDriftError({
    runId,
    storedManifest,
    currentManifest,
    diff,
  });
}

function hashToolRegistry(registry: ToolRegistry | undefined): string {
  return sha256Digest(registry?.snapshotForManifest() ?? []);
}

function hashBashCapabilities(capabilities: BashCapabilities | undefined): string {
  return sha256Digest(normalizeBashCapabilities(capabilities));
}

function skillsHash(
  skills: ReadonlyArray<SkillManifestIdentity> | undefined,
): string {
  return sha256Digest(
    [...(skills ?? [])]
      .sort((left, right) =>
        compareStrings(left.name, right.name) ||
        compareStrings(left.frontmatterHash, right.frontmatterHash) ||
        compareStrings(remoteSkillIdentityKey(left.remote), remoteSkillIdentityKey(right.remote))
      ),
  );
}

function sortedStrings(values: readonly string[]): readonly string[] {
  return [...values].sort(compareStrings);
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function harnessManifestKind(manifest: unknown): "planner" | "orchestrator" | "worker" | "fixer" | "unknown" {
  if (!isRecord(manifest)) {
    return "unknown";
  }
  if (typeof manifest.fixerModelSlotId === "string") {
    return "fixer";
  }
  if (typeof manifest.plannerModelSlotId === "string") {
    return "planner";
  }
  if (typeof manifest.orchestratorModelSlotId === "string") {
    return "orchestrator";
  }
  if (typeof manifest.workflowVersionId === "string" && typeof manifest.stepPath === "string") {
    return "worker";
  }
  return "unknown";
}

function harnessManifestScope(manifest: unknown): { kind: ReturnType<typeof harnessManifestKind>; scopeKey: string } {
  const kind = harnessManifestKind(manifest);
  if (!isRecord(manifest)) {
    return { kind, scopeKey: "__global__" };
  }

  if (kind === "worker" || kind === "fixer") {
    const stepPath = typeof manifest.stepPath === "string" ? manifest.stepPath : "__global__";
    return { kind, scopeKey: stepPath };
  }

  return { kind, scopeKey: "__global__" };
}

function manifestDiff(stored: unknown, current: unknown): readonly string[] {
  const storedFlat = flatten(stored);
  const currentFlat = flatten(current);
  const keys = [...new Set([...Object.keys(storedFlat), ...Object.keys(currentFlat)])]
    .sort(compareStrings);
  const diff: string[] = [];
  for (const key of keys) {
    const left = storedFlat[key];
    const right = currentFlat[key];
    if (left === right) {
      continue;
    }
    diff.push(`${key}: ${left} -> ${right}`);
  }
  return diff;
}

function flatten(value: unknown, path = "$", out: Record<string, string> = {}): Record<string, string> {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out[path] = "[]";
      return out;
    }
    value.forEach((entry, index) => flatten(entry, `${path}[${index}]`, out));
    return out;
  }

  if (isRecord(value)) {
    const keys = Object.keys(value).sort(compareStrings);
    if (keys.length === 0) {
      out[path] = "{}";
      return out;
    }
    for (const key of keys) {
      flatten(value[key], `${path}.${key}`, out);
    }
    return out;
  }

  out[path] = stableString(value);
  return out;
}

function stableString(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (value === undefined) {
    return "undefined";
  }
  try {
    return canonicalJson(value);
  } catch {
    return String(value);
  }
}

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => stripUndefined(entry)) as T;
  }
  if (!isRecord(value)) {
    return value;
  }
  const record: JsonRecord = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      record[key] = stripUndefined(entry);
    }
  }
  return record as T;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
