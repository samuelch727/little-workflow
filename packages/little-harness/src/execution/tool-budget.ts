import { AsyncLocalStorage } from "node:async_hooks";
import type { HarnessWarning, HarnessWorkflowBudgets } from "../types.js";

const TOOL_BUDGET = Symbol("Harness turn tool budget");
type Frame = { gate: ToolBudget; children: Semaphore; signal: AbortSignal };
const execution = new AsyncLocalStorage<Frame>();

class Semaphore {
  private active = 0;
  private waiting: Array<() => void> = [];
  private idleWaiters: Array<() => void> = [];
  idle(): Promise<void> {
    return this.active === 0 ? Promise.resolve() : new Promise((resolve) => this.idleWaiters.push(resolve));
  }
  constructor(private readonly limit: number) {}
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const ready = () => { signal.removeEventListener("abort", abort); resolve(); };
        const abort = () => {
          this.waiting = this.waiting.filter((item) => item !== ready);
          reject(signal.reason);
        };
        this.waiting.push(ready);
        signal.addEventListener("abort", abort, { once: true });
      });
    } else this.active++;
    if (signal.aborted) { this.release(); signal.throwIfAborted(); }
    return () => this.release();
  }
  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else {
      this.active--;
      if (this.active === 0) this.idleWaiters.splice(0).forEach((resolve) => resolve());
    }
  }
}

class ToolBudget {
  private calls = 0;
  private readonly warned = new Set<string>();
  private readonly slots: Semaphore;
  constructor(private readonly budgets: HarnessWorkflowBudgets, private readonly warnings: HarnessWarning[]) {
    this.slots = new Semaphore(budgets.maxConcurrentToolCalls);
  }
  async run<T>(name: string, signal: AbortSignal | undefined, invoke: (signal: AbortSignal) => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    if (++this.calls > this.budgets.maxToolCallsPerTurn) {
      const error = new Error("The turn's tool-call budget is spent.");
      this.warn(name, error.message, "maxToolCallsPerTurn");
      throw error;
    }
    const controller = new AbortController();
    const parent = execution.getStore();
    const parents = [...new Set([signal, parent?.gate === this ? parent.signal : undefined].filter((s): s is AbortSignal => !!s))];
    const abort = () => controller.abort(parents.find((s) => s.aborted)?.reason);
    for (const source of parents) source.addEventListener("abort", abort, { once: true });
    if (parents.some((s) => s.aborted)) abort();
    // Include queue time so a non-cooperative timed-out call cannot strand later calls.
    const timer = this.budgets.toolDeadlineMs === undefined ? undefined : setTimeout(() => {
      const error = new Error(`Tool ${name} exceeded toolDeadlineMs (${this.budgets.toolDeadlineMs} ms).`);
      this.warn(name, error.message, "toolDeadlineMs");
      controller.abort(error);
    }, this.budgets.toolDeadlineMs);
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      for (const source of parents) source.removeEventListener("abort", abort);
    };
    let release: (() => void) | undefined;
    try {
      // A bash/bridge or workflow child belongs to its caller's execution chain. Serializing
      // sibling children avoids both max=1 deadlock and a nested fan-out bypass.
      release = await (parent?.gate === this ? parent.children : this.slots).acquire(controller.signal);
      controller.signal.throwIfAborted();
      const frame = { gate: this, children: new Semaphore(1), signal: controller.signal };
      const running = execution.run(frame, () =>
        Promise.resolve().then(() => { controller.signal.throwIfAborted(); return invoke(controller.signal); }));
      const held = release;
      release = undefined;
      // Retain the physical slot until the underlying promise settles. Timeout only abandons
      // its result; it cannot terminate arbitrary JavaScript or undo external effects.
      const releaseChain = async () => { await frame.children.idle(); held(); };
      void running.then(releaseChain, releaseChain);
      return await new Promise<T>((resolve, reject) => {
        const stopped = () => reject(controller.signal.reason);
        if (controller.signal.aborted) { stopped(); return; }
        controller.signal.addEventListener("abort", stopped, { once: true });
        void running.then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", stopped));
      });
    } finally { release?.(); cleanup(); }
  }
  private warn(toolName: string, message: string, policy: string): void {
    if (this.warned.has(policy)) return;
    this.warned.add(policy);
    this.warnings.push({ code: "policy_warning", message, metadata: { toolName, policy } });
  }
}

export function turnToolBudget(budgets: HarnessWorkflowBudgets, warnings: HarnessWarning[]) {
  return { [TOOL_BUDGET]: new ToolBudget(budgets, warnings) };
}

export function executeWithToolBudget<T>(context: object, name: string, signal: AbortSignal | undefined, invoke: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> {
  const gate = (context as { [TOOL_BUDGET]?: ToolBudget })[TOOL_BUDGET];
  return gate ? gate.run(name, signal, invoke) : invoke(signal);
}

/** Preserve the execution signal as well as the turn signal, even without a budget gate. */
export function combineToolSignals(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const parents = [...new Set(signals.filter((signal): signal is AbortSignal => signal !== undefined))];
  return parents.length === 0 ? undefined : parents.length === 1 ? parents[0] : AbortSignal.any(parents);
}
