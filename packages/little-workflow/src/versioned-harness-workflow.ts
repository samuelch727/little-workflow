import type { HarnessWorkflow, HarnessWorkflowRunContext } from "@little-stack/harness";
import type { WorkflowDefinition } from "./authoring.js";
import { defaultWorldForHarness } from "./harness-default-world.js";
import { asHarnessWorkflow, type HarnessWorkflowAdapterOptions } from "./harness-workflow.js";
import { getWorkflowDefinitionHash } from "./workflow-definition-hash.js";
import { readRunPin, writeRunPin } from "./world.js";
import type { World } from "./world-port.js";

/**
 * Where a workflow's versions come from: LittleDB's `db.managedWorkflow(...)` fits it. `prepare`
 * answers which version a session runs and wraps the run's World for tracing.
 */
export type WorkflowVersionSource<C> = {
  readonly bootstrap: C;
  prepare(options: {
    readonly stickyKey?: string | undefined;
    /**
     * Set when a run resumes: the content it started with, and the `version` `prepare` returned
     * then. The run uses this content whatever `prepare` returns, so trace it as this version.
     */
    readonly pinned?: { readonly content: C; readonly version?: unknown } | undefined;
  }): Promise<{
    readonly content: C;
    /** JSON that names this version, kept with the run and handed back in `pinned` if it resumes. */
    readonly version?: unknown;
    world(inner: World): World;
  }>;
};

export type VersionedHarnessWorkflowOptions = Omit<HarnessWorkflowAdapterOptions, "definitionIdentity" | "world"> & {
  /** The identity the harness records. Default: the hash of the workflow built from the bootstrap. */
  readonly definitionIdentity?: HarnessWorkflowAdapterOptions["definitionIdentity"];
  /** Where runs are stored. Default: the harness's virtual or local filesystem store. */
  readonly world?: World | ((ctx: HarnessWorkflowRunContext) => World) | undefined;
};

const MAX_BUILT = 20;

/**
 * A workflow a harness calls as a tool, built per run from the version LittleDB says the
 * session runs, instead of once from code. `build` turns a version's content (step prompts and
 * models) into the workflow; the tool's name, description and input schema come from the
 * bootstrap build, so the agent sees the same tool whichever version runs.
 */
export function versionedHarnessWorkflow<C>(
  source: WorkflowVersionSource<C>,
  build: (content: C) => WorkflowDefinition<any, any>,
  options: VersionedHarnessWorkflowOptions = {},
): HarnessWorkflow {
  const { definitionIdentity: identity, world: worldOption, ...adapterOptions } = options;
  const shape = build(source.bootstrap);
  const definitionIdentity = identity ?? getWorkflowDefinitionHash(shape);
  const built = new Map<string, WorkflowDefinition<any, any>>();
  const workflowFor = (content: C): WorkflowDefinition<any, any> => {
    const key = JSON.stringify(content);
    let found = built.get(key);
    if (found === undefined) {
      found = build(content);
      built.set(key, found);
      while (built.size > MAX_BUILT) {
        const oldest = built.keys().next().value;
        if (oldest === undefined) break;
        built.delete(oldest);
      }
    }
    return found;
  };
  const adapter = asHarnessWorkflow(shape, { ...adapterOptions, definitionIdentity });
  return {
    ...adapter,
    async runForHarness(input, ctx) {
      const inner =
        worldOption === undefined
          ? defaultWorldForHarness(ctx)
          : typeof worldOption === "function"
            ? worldOption(ctx)
            : worldOption;
      let run: PreparedRun<C>;
      try {
        run = await prepareRun(source, inner, ctx);
      } catch (error) {
        // Never fall back to the live version for a run that started on another one.
        return {
          protocolVersion: 1,
          status: "failed",
          runId: ctx.reservedRunId,
          causeCode: "workflow_failed",
          message: `Could not resolve the version run '${ctx.reservedRunId}' runs: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      return asHarnessWorkflow(workflowFor(run.content), {
        ...adapterOptions,
        definitionIdentity,
        world: run.world(inner),
      }).runForHarness(input, ctx);
    },
  };
}

type PreparedRun<C> = { readonly content: C; world(inner: World): World };

/**
 * The session keeps one version of the workflow, as it keeps one version of the agent, and a run
 * keeps the version it started on: it is pinned before its first event, and a resumed run (the
 * same reserved run id) is built from the pin even if the live version changed since.
 */
async function prepareRun<C>(
  source: WorkflowVersionSource<C>,
  inner: World,
  ctx: HarnessWorkflowRunContext,
): Promise<PreparedRun<C>> {
  const runId = ctx.reservedRunId;
  const stickyKey = ctx.parentSessionId;
  const pin = await readRunPin<C>(inner, runId);
  if (pin !== undefined) return resumePinned(source, stickyKey, pin);
  const prepared = await source.prepare({ stickyKey });
  if ((await inner.listEvents(runId)).length > 0) {
    // Another process may have pinned and started this run while this one resolved. Its pin is
    // written before its first event, so seeing the event means its pin can be read.
    const started = await readRunPin<C>(inner, runId);
    if (started !== undefined) return resumePinned(source, stickyKey, started);
    // Started before runs were pinned. The runtime refuses it if the version changed since.
    return prepared;
  }
  const { pin: stored, written } = await writeRunPin(inner, {
    runId,
    content: prepared.content,
    ...(prepared.version === undefined ? {} : { version: prepared.version }),
  });
  // Another process pinned this run first: run and trace its version, not this one.
  return written ? prepared : resumePinned(source, stickyKey, stored);
}

async function resumePinned<C>(
  source: WorkflowVersionSource<C>,
  stickyKey: string | undefined,
  pin: { readonly content: C; readonly version?: unknown },
): Promise<PreparedRun<C>> {
  const prepared = await source.prepare({
    stickyKey,
    pinned: { content: pin.content, ...(pin.version === undefined ? {} : { version: pin.version }) },
  });
  return { content: pin.content, world: (inner) => prepared.world(inner) };
}
