import { HarnessConcurrencyError } from "../errors.js";

export type LocalSessionQueueOptions = {
  sameSession?: "queue" | "reject";
  maxConcurrentSessions?: number;
};

export class LocalSessionQueue {
  private readonly sameSession: "queue" | "reject";
  private readonly maxConcurrentSessions: number | undefined;
  private activeSessions = 0;
  private globalWaiters: Array<() => void> = [];
  private tails = new Map<string, Promise<void>>();

  constructor(options: LocalSessionQueueOptions = {}) {
    this.sameSession = options.sameSession ?? "queue";
    this.maxConcurrentSessions = options.maxConcurrentSessions;
  }

  async run<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    if (this.sameSession === "reject" && this.tails.has(sessionId)) {
      throw new HarnessConcurrencyError("Session already has a running turn", { sessionId });
    }

    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const waitForPrevious = previous.catch(() => undefined);
    let releaseTail!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    const nextTail = waitForPrevious.then(() => gate);
    this.tails.set(sessionId, nextTail);

    await waitForPrevious;
    await this.acquireGlobal();

    try {
      return await fn();
    } finally {
      this.releaseGlobal();
      releaseTail();
      if (this.tails.get(sessionId) === nextTail) {
        this.tails.delete(sessionId);
      }
    }
  }

  private async acquireGlobal(): Promise<void> {
    if (!this.maxConcurrentSessions) {
      return;
    }

    if (this.activeSessions < this.maxConcurrentSessions) {
      this.activeSessions += 1;
      return;
    }

    await new Promise<void>((resolve) => this.globalWaiters.push(resolve));
  }

  private releaseGlobal(): void {
    if (!this.maxConcurrentSessions) {
      return;
    }

    const next = this.globalWaiters.shift();
    if (next) {
      next();
      return;
    }

    this.activeSessions = Math.max(0, this.activeSessions - 1);
  }
}
