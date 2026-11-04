import { AsyncLocalStorage } from "node:async_hooks";
import type { ClaimedPin, SubjectKind } from "./contract.js";

/**
 * What the code inside one experiment run can read without being handed it: the run, and the
 * agent and workflow versions it must use instead of the live ones. The eval worker sets it
 * around `run`, so a harness or workflow the run calls resolves to its pinned version and
 * traces as experiment traffic rather than production.
 */
export type EvalContext = {
  readonly runId: string;
  readonly experimentId: string;
  /** The run's own trace. Traces of agents it calls nest under it. */
  readonly traceId: string;
  /** The harness or workflow the experiment runs. Its version is in `pins` too. */
  readonly subject: { readonly kind: SubjectKind; readonly slug: string } | null;
  /** The run's trace tags, as `EvalRun.trace` has them, for the subject's own tracer. */
  readonly trace: {
    readonly traceId: string;
    readonly versionId?: string;
    readonly environment: "experiment";
    readonly experimentId: string;
    readonly datasetItemId?: string;
  };
  readonly pins: readonly ClaimedPin[];
};

const storage = new AsyncLocalStorage<EvalContext>();

/** The experiment run this code is running inside, if any. */
export function currentEvalContext(): EvalContext | undefined {
  return storage.getStore();
}

export function runInEvalContext<T>(context: EvalContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The experiment run, when it runs this subject itself (not an agent its workflow calls). */
export function evalRunOf(kind: string, slug: string): EvalContext | undefined {
  const context = storage.getStore();
  return context?.subject?.kind === kind && context.subject.slug === slug ? context : undefined;
}

/** The version an experiment run pinned for this subject, if it pinned one. */
export function pinFor(kind: string, slug: string): ClaimedPin | undefined {
  return storage.getStore()?.pins.find((pin) => pin.kind === kind && pin.slug === slug);
}
