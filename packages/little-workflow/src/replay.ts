import type { LocalWorld } from "./authoring.js";
import {
  type ArtifactManifest,
  ArtifactNotFoundError,
  type ArtifactRef,
  type EventEnvelope,
  type MaterializedRunState,
  type MaterializedStepState,
  type RunId,
  RunNotFoundError,
} from "./world.js";
import {
  RunStateEventMismatchError,
  materializeRunStateFromEvents,
  stepPathsInEventOrder,
} from "./run-state.js";

export { RunStateEventMismatchError };

export type ReplayStepStatus = "completed" | "pending" | "running" | "failed";

export type ReplayPlanStep = {
  readonly stepPath: string;
  readonly status: ReplayStepStatus;
  readonly shouldRun: boolean;
  readonly output?: unknown;
  readonly outputRef?: ArtifactRef;
  readonly artifactRefs: readonly ArtifactRef[];
};

export type HydratedArtifact = {
  readonly ref: ArtifactRef;
  readonly manifest: ArtifactManifest;
  readonly payload: unknown;
};

export type ReplayResult = {
  readonly runId: RunId;
  readonly events: readonly EventEnvelope[];
  readonly state: MaterializedRunState;
  readonly steps: readonly ReplayPlanStep[];
  readonly completedStepPaths: readonly string[];
  readonly pendingStepPaths: readonly string[];
  readonly artifacts: readonly HydratedArtifact[];
};

export async function replayRun(
  world: LocalWorld,
  runId: RunId,
): Promise<ReplayResult> {
  const events = await world.listEvents(runId);
  const state = buildRunStateFromEvents(runId, events);
  const steps = orderedStepPaths(state, events).map((stepPath) =>
    replayPlanStep(state.steps[stepPath] as MaterializedStepState)
  );
  const artifacts = await hydrateRunArtifactRefs(world, runId, state.artifacts);
  return deepFreeze({
    runId,
    events,
    state,
    steps,
    completedStepPaths: steps
      .filter((step) => !step.shouldRun)
      .map((step) => step.stepPath),
    pendingStepPaths: steps
      .filter((step) => step.shouldRun)
      .map((step) => step.stepPath),
    artifacts,
  });
}

export function buildRunStateFromEvents(
  runId: RunId,
  events: readonly EventEnvelope[],
): MaterializedRunState {
  if (events.length === 0) {
    throw new RunNotFoundError(runId);
  }
  return materializeRunStateFromEvents(runId, events);
}

export async function hydrateArtifactRefs(
  world: LocalWorld,
  refs: readonly ArtifactRef[],
): Promise<readonly HydratedArtifact[]> {
  const artifacts = await Promise.all(
    refs.map(async (ref) => {
      const artifact = await world.readArtifact(ref);
      return {
        ref,
        manifest: artifact.manifest,
        payload: artifact.payload,
      };
    }),
  );
  return deepFreeze(artifacts);
}

export async function hydrateRunArtifactRefs(
  world: LocalWorld,
  runId: RunId,
  refs: readonly ArtifactRef[],
): Promise<readonly HydratedArtifact[]> {
  const manifests = await Promise.all(
    refs.map(async (ref) => ({
      ref,
      manifest: await world.readArtifactManifest(ref),
    })),
  );
  assertArtifactManifestsBelongToRun(runId, manifests);
  return hydrateArtifactRefs(world, refs);
}

function orderedStepPaths(
  state: MaterializedRunState,
  events: readonly EventEnvelope[],
): readonly string[] {
  const ordered = stepPathsInEventOrder(events).filter((stepPath) =>
    Object.hasOwn(state.steps, stepPath)
  );
  for (const stepPath of Object.keys(state.steps)) {
    if (!ordered.includes(stepPath)) {
      ordered.push(stepPath);
    }
  }
  return ordered;
}

function replayPlanStep(step: MaterializedStepState): ReplayPlanStep {
  return {
    stepPath: step.stepPath,
    status: step.status,
    shouldRun: step.status !== "completed",
    artifactRefs: step.artifactRefs,
    ...("output" in step ? { output: step.output } : {}),
    ...(step.outputRef === undefined ? {} : { outputRef: step.outputRef }),
  };
}

function assertArtifactManifestsBelongToRun(
  runId: RunId,
  artifacts: readonly Pick<HydratedArtifact, "ref" | "manifest">[],
): void {
  for (const artifact of artifacts) {
    if (artifact.manifest.runId !== runId) {
      throw new ArtifactNotFoundError(artifact.ref);
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (ArrayBuffer.isView(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
    return Object.freeze(value) as T;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
    return Object.freeze(value);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
