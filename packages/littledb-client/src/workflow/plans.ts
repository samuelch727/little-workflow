import { LittleDBError, type Transport } from "../http.js";
import type { LittleDBErrorHandler } from "../exporter.js";
import { isRecord } from "../util.js";

export type PlanUpload = {
  readonly workflow: string;
  readonly hash: string;
  readonly workflowVersionId: string;
  readonly complete: boolean;
  /** Returns the LWIR document, not its stored-version envelope. */
  readonly read: () => Promise<unknown>;
};
export type PlanUploads = {
  enqueue(input: PlanUpload): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
};

/** Allowlisted structure only. Never copy an arbitrary object from a content-bearing field. */
export function structuralPlan(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !Array.isArray(value.steps)) throw new TypeError("Invalid workflow plan");
  function steps(values: unknown[], depth: number): Record<string, unknown>[] {
    if (depth > 4) throw new LittleDBError("Workflow plan exceeds four step levels", 400, "invalid");
    return values.map((value) => {
      if (!isRecord(value)) throw new TypeError("Invalid workflow step");
      const out: Record<string, unknown> = {};
      for (const key of ["id", "uses"] as const) if (typeof value[key] === "string") out[key] = value[key];
      if (Array.isArray(value.needs)) out.needs = value.needs.filter((v): v is string => typeof v === "string");
      if (typeof value.maxVisits === "number") out.maxVisits = value.maxVisits;
      if (Array.isArray(value.steps)) out.steps = steps(value.steps, depth + 1);
      if (isRecord(value.with)) {
        const source = value.with;
        const w: Record<string, unknown> = {};
        for (const key of ["tool", "model", "default", "failureMode"] as const) if (typeof source[key] === "string") w[key] = source[key];
        if (typeof source.maxConcurrency === "number") w.maxConcurrency = source.maxConcurrency;
        if (Array.isArray(source.cases)) w.cases = source.cases.filter(isRecord).map((c) => typeof c.to === "string" ? { to: c.to } : {});
        if (isRecord(source.fanIn) && typeof source.fanIn.outputStep === "string") w.fanIn = { outputStep: source.fanIn.outputStep };
        if (Object.keys(w).length > 0) out.with = w;
      }
      return out;
    });
  }
  const out: Record<string, unknown> = { steps: steps(value.steps, 1) };
  for (const key of ["apiVersion", "kind"] as const) if (typeof value[key] === "string") out[key] = value[key];
  if (isRecord(value.metadata) && typeof value.metadata.name === "string") out.metadata = { name: value.metadata.name };
  return out;
}

/** One client owns this queue across all its tracing Worlds. No storage IO runs in appendEvent. */
export function createPlanUploads(transport: Transport, onError: LittleDBErrorHandler): PlanUploads {
  const memory = new Map<string, "complete" | "incomplete" | "refused">();
  const pending = new Map<string, { complete: boolean; promise: Promise<void> }>();
  let closed = false;
  const report = (error: unknown) => { try { onError(error, { operation: "plan" }); } catch { /* Observability must not fail a run. */ } };
  const remember = (key: string, value: "complete" | "incomplete" | "refused") => {
    memory.delete(key);
    memory.set(key, value);
    if (memory.size > 500) memory.delete(memory.keys().next().value!);
  };
  const satisfied = (key: string, complete: boolean) => {
    const state = memory.get(key);
    return state === "refused" || state === "complete" || (state === "incomplete" && !complete);
  };
  async function upload(key: string, input: PlanUpload) {
    if (satisfied(key, input.complete)) return;
    let raw: unknown;
    try { raw = await input.read(); } catch { return; }
    if (!isRecord(raw) || !Array.isArray(raw.steps)) return;
    try {
      const plan = input.complete ? raw : structuralPlan(raw);
      await transport.request("PUT", `/workflow-plans/${encodeURIComponent(input.hash)}`, {
        workflow: input.workflow, plan, complete: input.complete, workflowVersionId: input.workflowVersionId,
      });
      remember(key, input.complete ? "complete" : "incomplete");
    } catch (error) {
      if (error instanceof LittleDBError && (error.status === 400 || error.status === 413)) remember(key, "refused");
      report(error);
    }
  }
  async function flush() {
    while (pending.size > 0) await Promise.all([...pending.values()].map((p) => p.promise));
  }
  return {
    enqueue(input) {
      if (closed || !/^sha256:[a-f0-9]{64}$/u.test(input.hash)) return;
      const key = JSON.stringify([input.workflow, input.hash]);
      if (satisfied(key, input.complete)) return;
      const earlier = pending.get(key);
      if (earlier && (earlier.complete || !input.complete)) return;
      if (!earlier && pending.size >= 500) { report(new Error("Workflow plan upload queue is full (500)")); return; }
      // A timer (rather than a microtask) also defers projection until appendEvent has returned.
      const promise = (earlier?.promise ?? new Promise<void>((resolve) => setTimeout(resolve, 0)))
        .then(() => upload(key, input)).catch(report).finally(() => {
          if (pending.get(key)?.promise === promise) pending.delete(key);
        });
      pending.set(key, { complete: input.complete, promise });
    },
    flush,
    async shutdown() { closed = true; await flush(); },
  };
}
