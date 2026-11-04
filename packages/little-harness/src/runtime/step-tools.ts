import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import type { InferToolInput, Tool, ToolSet } from "ai";
import type { IFileSystem } from "just-bash";
import { HarnessInputError, HarnessPersistenceError } from "../errors.js";
import { filesystemError } from "../files/filesystem-error.js";
import type { HarnessToolExecutionContext } from "../types.js";
import { canonicalJson, sha256Hex } from "../utils/canonical-hash.js";

const ONCE = Symbol.for("little-harness.once");

export type OnceOptions<TInput = unknown> = {
  /**
   * What counts as the same call. By default it is the whole input. Return something narrower,
   * such as an application id, when part of the input is text a model wrote, which differs from
   * one run to the next.
   */
  key?: (input: TInput) => string;
};

/**
 * Marks a tool that writes, so a workflow or plan step that calls it again in the same session,
 * with the same input (or the same `key`), gets the recorded result back instead of a second
 * write. A retried or resubmitted plan then does not repeat the write.
 *
 * Only calls made by workflow and plan steps are recorded. When the agent calls the tool itself,
 * it runs every time: the agent may mean to repeat it. A call whose result cannot be saved (not
 * JSON, or a failed storage write) is not run again either: a repeat throws instead.
 * Records inherit the host filesystem's durability. A restart during a turn can lose an unsaved
 * record and let the call run again; this does not provide recovery of in-flight calls.
 */
export function once<TTool extends Tool<any, any>>(
  tool: TTool,
  options: OnceOptions<InferToolInput<TTool>> = {},
): TTool {
  if (typeof tool.execute !== "function") {
    throw new HarnessInputError("once() needs a tool with an execute function.");
  }
  return { ...tool, [ONCE]: options } as TTool;
}

function onceOptions(tool: unknown): OnceOptions | undefined {
  return isObject(tool) ? (tool as { [ONCE]?: OnceOptions })[ONCE] : undefined;
}

/**
 * The harness context of the tool call that is running, so a workflow it starts can hand the same
 * context to the tools its steps call. Set by `wrapToolsWithHarnessContext`.
 */
const callerContext = new AsyncLocalStorage<HarnessToolExecutionContext<unknown>>();

export function runWithCallerToolContext<T>(ctx: HarnessToolExecutionContext<any>, run: () => T): T {
  return callerContext.run(ctx, run);
}

/**
 * The tools workflows and plans call from their steps. Each call gets the harness context of the
 * tool call that started the run (so `harnessToolContext(options)` works in a step), plus an
 * `idempotencyKey`: the same for the same tool and input (or `once` key) in the same session.
 * Tools marked with `once` return the result recorded under that key.
 */
export function withStepToolContext(
  tools: ToolSet,
  options: { readonly sessionId: string; readonly onceDir: string; readonly fs?: IFileSystem },
): ToolSet {
  const wrapped: Record<string, unknown> = {};
  for (const [name, stepTool] of Object.entries(tools)) {
    const execute = (stepTool as { execute?: unknown }).execute;
    if (typeof execute !== "function") {
      wrapped[name] = stepTool;
      continue;
    }
    const policy = onceOptions(stepTool);
    wrapped[name] = {
      ...stepTool,
      execute: async (input: unknown, stepOptions: unknown) => {
        const idempotencyKey = stepIdempotencyKey(options.sessionId, name, input, policy);
        const { toolReplay: _modelCallReplay, ...caller } = callerContext.getStore() ?? {};
        const executeOptions = {
          ...caller,
          ...(isObject(stepOptions) ? stepOptions : {}),
          idempotencyKey,
        };
        const run = () => (execute as (input: unknown, options: unknown) => unknown)(input, executeOptions);
        if (policy === undefined) return run();
        const path = options.fs === undefined
          ? join(options.onceDir, `${idempotencyKey}.json`)
          : posix.resolve("/", options.onceDir, `${idempotencyKey}.json`);
        return runOnce(path, name, run, options.fs);
      },
    };
  }
  return wrapped as ToolSet;
}

function stepIdempotencyKey(
  sessionId: string,
  toolName: string,
  input: unknown,
  policy: OnceOptions | undefined,
): string {
  let material: string;
  if (policy?.key === undefined) {
    material = `input:${canonicalJson(input)}`;
  } else {
    const key = policy.key(input);
    if (typeof key !== "string" || key.length === 0) {
      throw new HarnessInputError(`once() key for tool '${toolName}' must return non-empty text.`, { toolName });
    }
    material = `key:${key}`;
  }
  return `idem_${sha256Hex(canonicalJson([sessionId, toolName, material])).slice(0, 32)}`;
}

type OnceRecord = {
  readonly toolName: string;
  readonly recordedAt: string;
  readonly result?: unknown;
  readonly resultUndefined?: true;
  /** The tool ran, but its result could not be saved (not JSON, say), so a repeat gets an error. */
  readonly resultUnavailable?: true;
};

/** Calls under way, so two steps that make the same call at once share one execution. */
const running = new Map<string, Promise<unknown>>();

/** Calls that ran but could not be recorded at all, so this process still refuses to repeat them. */
const unrecorded = new Map<string, string>();

type OnceCalls = {
  readonly running: Map<string, Promise<unknown>>;
  readonly unrecorded: Map<string, string>;
};

/** Filesystem wrappers must share the same object when they share storage. */
const filesystemCalls = new WeakMap<IFileSystem, OnceCalls>();

function callsFor(fs: IFileSystem | undefined): OnceCalls {
  if (fs === undefined) return { running, unrecorded };
  let calls = filesystemCalls.get(fs);
  if (calls === undefined) {
    calls = { running: new Map(), unrecorded: new Map() };
    filesystemCalls.set(fs, calls);
  }
  return calls;
}

async function runOnce(path: string, toolName: string, run: () => unknown, fs?: IFileSystem): Promise<unknown> {
  const calls = callsFor(fs);
  const pending = calls.running.get(path);
  if (pending !== undefined) return pending;
  const call = (async () => {
    const ranAt = calls.unrecorded.get(path);
    const recorded = ranAt === undefined
      ? await readRecord(path, fs)
      : { toolName, recordedAt: ranAt, resultUnavailable: true as const };
    if (recorded?.resultUnavailable === true) {
      throw new HarnessPersistenceError(
        `Tool '${toolName}' already ran for this input in this session (once), but its result could not be saved, so it does not run again.`,
        { toolName, ranAt: recorded.recordedAt },
      );
    }
    if (recorded !== undefined) {
      return recorded.resultUndefined === true ? undefined : recorded.result;
    }
    // A failed call is not recorded, so the next attempt runs it again.
    const result = await run();
    // The write already happened, so this call returns its result even when it cannot be
    // recorded; failing the step now would only make the agent retry it. A result that cannot be
    // saved (a BigInt, a cycle) leaves a marker instead, so a repeat is refused rather than rerun.
    const recordedAt = new Date().toISOString();
    try {
      await writeRecord(path, {
        toolName,
        recordedAt,
        ...(result === undefined ? { resultUndefined: true as const } : { result }),
      }, fs);
    } catch {
      try {
        await writeRecord(path, { toolName, recordedAt, resultUnavailable: true }, fs);
      } catch {
        calls.unrecorded.set(path, recordedAt);
      }
    }
    return result;
  })();
  calls.running.set(path, call);
  try {
    return await call;
  } finally {
    calls.running.delete(path);
  }
}

async function readRecord(path: string, fs?: IFileSystem): Promise<OnceRecord | undefined> {
  let text: string;
  try {
    text = fs === undefined ? await readFile(path, "utf8") : await fs.readFile(path);
  } catch (error) {
    const failure = fs === undefined ? error : filesystemError(error);
    if ((failure as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw failure;
  }
  return JSON.parse(text) as OnceRecord;
}

async function writeRecord(path: string, record: OnceRecord, fs?: IFileSystem): Promise<void> {
  if (fs !== undefined) {
    try {
      await fs.mkdir(posix.dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(record));
      await fs.mv(temporary, path);
      return;
    } catch (error) {
      throw filesystemError(error);
    }
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(record), "utf8");
  await rename(temporary, path);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
