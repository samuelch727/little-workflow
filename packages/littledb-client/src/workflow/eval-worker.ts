import type { WorkflowOrigin } from "../contract.js";
import type { AgentWorkflowDefinitionLike } from "../harness/registry.js";
import type { EvalResult, EvalRun, EvalWorker, EvalWorkerOptions } from "../worker.js";
import type { TracingWorldOptions, WorldLike } from "./tracing-world.js";

/** One experiment run of a workflow: the run, with the version to build and the World to run it in. */
export type WorkflowEvalRun<W extends WorldLike = WorldLike> = EvalRun & {
  /** The version's content: what `resolve` would return for it. Build the workflow from it. */
  readonly content: Readonly<Record<string, unknown>>;
  /** The dataset item's input: the workflow's input. */
  readonly input: unknown;
  /** Your World, wrapped so this run's events land in the run's trace. Run the workflow in it. */
  readonly world: W;
};

/** What `grade` is given: the workflow's output and the dataset item it ran on. */
export type WorkflowEvalGrade = {
  readonly output: unknown;
  readonly input: unknown;
  /** The item's `expected`, if it has one. */
  readonly expected: unknown;
  readonly content: Readonly<Record<string, unknown>>;
  readonly run: EvalRun;
};

export type WorkflowEvalWorkerOptions<W extends WorldLike = WorldLike> = {
  /** The workflow's slug in LittleDB, the same one you resolve. The worker runs its experiments. */
  readonly workflow: string;
  /**
   * The World a run uses, e.g. `() => localWorld({ dataDir })`. Called once per run; the worker
   * wraps it with the tracing World, tagged with the run's trace, experiment, item and version.
   */
  readonly world: (run: EvalRun) => W;
  /**
   * Build the workflow from `run.content`, run it on `run.input` in `run.world`, and return what
   * `runWorkflow` returns. Throw (a failed run throws `RunFailedError`) to fail the run.
   */
  readonly run: (run: WorkflowEvalRun<W>) => Promise<{ readonly output?: unknown } | void>;
  /** Score the output, usually against `expected`. Stored on the run's trace with source `code`. */
  readonly grade?: ((graded: WorkflowEvalGrade) => EvalResult["scores"] | Promise<EvalResult["scores"]>) | undefined;
  /** Who wrote the workflow: `code` (default) or `agent`. */
  readonly origin?: WorkflowOrigin | undefined;
  /** `false` sends structure and numbers only, as in `tracingWorld`. */
  readonly captureContent?: boolean | undefined;
} & Pick<EvalWorkerOptions, "concurrency" | "pollIntervalMs" | "leaseMs" | "workerId">;

/**
 * An eval worker for one workflow: for each experiment run it hands you the version's content,
 * the item's input and a traced World, and turns what you return into the run's output and scores.
 */
export function createWorkflowEvalWorker<W extends WorldLike>(
  options: WorkflowEvalWorkerOptions<W>,
  deps: {
    readonly evalWorker: (options: EvalWorkerOptions) => EvalWorker;
    readonly tracingWorld: <X extends WorldLike>(inner: X, options: TracingWorldOptions) => X;
  },
): EvalWorker {
  if (typeof options.workflow !== "string" || options.workflow.length === 0) {
    throw new TypeError("workflowEvalWorker needs the workflow's slug.");
  }
  return deps.evalWorker({
    subjects: [{ kind: "workflow", slug: options.workflow }],
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
    ...(options.workerId === undefined ? {} : { workerId: options.workerId }),
    run: async (run) => {
      if (run.version === null || run.item === null) throw new Error("LittleDB sent a run without its version or dataset item.");
      const content = run.version.content;
      const input = run.item.input;
      const world = deps.tracingWorld(options.world(run), {
        workflow: options.workflow,
        ...(options.origin === undefined ? {} : { origin: options.origin }),
        ...(options.captureContent === undefined ? {} : { captureContent: options.captureContent }),
        ...run.trace,
      });
      const result = await options.run({ ...run, content, input, world });
      const output = result?.output;
      const scores = options.grade === undefined ? undefined : await options.grade({ output, input, expected: run.item.expected, content, run });
      return { ...(output === undefined ? {} : { output }), ...(scores === undefined ? {} : { scores }) };
    },
  });
}

/** One experiment run of an agent-made workflow: the definition to build, its input and a traced World. */
export type AgentWorkflowEvalRun<W extends WorldLike = WorldLike> = EvalRun & {
  /** The workflow's handle: the tool name the agent calls it by. */
  readonly handle: string;
  /** The version's definition, as `define_workflow` wrote it. Build it with Little Workflow's `agentWorkflow`. */
  readonly definition: AgentWorkflowDefinitionLike;
  readonly input: unknown;
  readonly world: W;
};

export type AgentWorkflowEvalWorkerOptions<W extends WorldLike = WorldLike> = {
  /** The harness the workflows belong to. */
  readonly harness: string;
  /** Which handles to run experiments for. Default: every agent-made workflow of the harness, listed when the worker starts. */
  readonly handles?: readonly string[] | undefined;
  /** The World a run uses. The worker wraps it with the tracing World, tagged with the run. */
  readonly world: (run: EvalRun) => W;
  /**
   * Build the workflow from `run.definition` (Little Workflow's `agentWorkflow(definition, { tools,
   * models })`), run it on `run.input` in `run.world`, and return its output.
   */
  readonly run: (run: AgentWorkflowEvalRun<W>) => Promise<{ readonly output?: unknown } | void>;
  /** Score the output, usually against `expected`. */
  readonly grade?: ((graded: WorkflowEvalGrade) => EvalResult["scores"] | Promise<EvalResult["scores"]>) | undefined;
  readonly captureContent?: boolean | undefined;
} & Pick<EvalWorkerOptions, "concurrency" | "pollIntervalMs" | "leaseMs" | "workerId">;

/**
 * An eval worker for the workflows an agent made in one harness: LittleDB's experiments on a
 * proposed definition run here, where the harness's tools and model keys are.
 */
export function createAgentWorkflowEvalWorker<W extends WorldLike>(
  options: AgentWorkflowEvalWorkerOptions<W>,
  deps: {
    readonly evalWorker: (options: EvalWorkerOptions) => EvalWorker;
    readonly tracingWorld: <X extends WorldLike>(inner: X, options: TracingWorldOptions) => X;
    readonly listHandles: (harness: string) => Promise<readonly string[]>;
  },
): EvalWorker {
  if (typeof options.harness !== "string" || options.harness.length === 0) {
    throw new TypeError("agentWorkflowEvalWorker needs the harness's slug.");
  }
  let worker: EvalWorker | undefined;
  const build = async (): Promise<EvalWorker | undefined> => {
    if (worker !== undefined) return worker;
    const handles = options.handles ?? (await deps.listHandles(options.harness));
    if (handles.length === 0) return undefined;
    worker = deps.evalWorker({
      subjects: handles.map((handle) => ({ kind: "workflow" as const, slug: handle })),
      ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
      ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
      ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
      ...(options.workerId === undefined ? {} : { workerId: options.workerId }),
      run: async (run) => {
        if (run.version === null || run.item === null || run.subject === null) {
          throw new Error("LittleDB sent a run without its version, subject or dataset item.");
        }
        const definition = run.version.content as unknown as AgentWorkflowDefinitionLike;
        if (typeof definition.id !== "string" || !Array.isArray(definition.tools)) {
          throw new Error(`Version ${run.version.number} of ${run.subject.slug} is not a workflow definition.`);
        }
        const content = run.version.content;
        const input = run.item.input;
        const world = deps.tracingWorld(options.world(run), {
          workflow: run.subject.slug,
          origin: "agent",
          harness: options.harness,
          ...(options.captureContent === undefined ? {} : { captureContent: options.captureContent }),
          ...run.trace,
        });
        const result = await options.run({ ...run, handle: run.subject.slug, definition, input, world });
        const output = result?.output;
        const scores = options.grade === undefined ? undefined : await options.grade({ output, input, expected: run.item.expected, content, run });
        return { ...(output === undefined ? {} : { output }), ...(scores === undefined ? {} : { scores }) };
      },
    });
    return worker;
  };
  let stopped = false;
  return {
    async start() {
      stopped = false;
      const built = await build();
      if (built === undefined || stopped) return;
      return built.start();
    },
    async stop(stopOptions) {
      stopped = true;
      await worker?.stop(stopOptions);
    },
    async runOnce() {
      const built = await build();
      return built === undefined ? { claimed: 0, completed: 0, failed: 0 } : built.runOnce();
    },
  };
}
