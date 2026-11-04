import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HarnessInputError } from "../errors.js";
import { generateHarness } from "../execution/generate-harness.js";
import type { HarnessTurnResult } from "../execution/result.js";
import type { Harness } from "../types.js";
import { nextCronTime } from "./cron.js";
import { scheduleCron, type DiscoveredSchedule, type HarnessSchedule } from "./schedule.js";

/** A schedule's run that started, and how it ended once it has. */
export type ScheduleRun = {
  readonly id: string;
  /** The cron time this run is for, or when it was started by hand. */
  readonly scheduledFor: string;
  readonly sessionId: string;
  /** True when it runs because the server was down at its time (`catchUp`). */
  readonly caughtUp: boolean;
  readonly finished: Promise<ScheduleRunOutcome>;
};

export type ScheduleRunOutcome =
  | { readonly status: "completed" | "parked"; readonly result: HarnessTurnResult<unknown> }
  | { readonly status: "failed"; readonly error: unknown };

export type ScheduleInfo = {
  readonly id: string;
  readonly cron: string;
  readonly timezone: string;
  readonly description?: string;
  /** The next time it runs, in ISO 8601, or undefined when the cron never matches. */
  readonly next?: string;
  readonly lastRunAt?: string;
};

export type ScheduleRunner = {
  /**
   * Starts every schedule that is due and returns those runs. A schedule seen for the first time
   * starts counting from now. A run still going holds its schedule back until it finishes.
   */
  tick(): Promise<ScheduleRun[]>;
  /** Starts a schedule now, whatever its cron says, and waits for it. */
  run(id: string): Promise<ScheduleRun & { readonly outcome: ScheduleRunOutcome }>;
  list(): Promise<ScheduleInfo[]>;
};

type ScheduleState = {
  /** Every cron time up to this one is handled: run, or skipped because catchUp is off. */
  readonly handledThrough: string;
  readonly lastRunAt?: string;
};

/** A run counts as on time when it starts within this long of its cron time. */
const ON_TIME_MS = 90_000;

export function createScheduleRunner(options: {
  readonly harness: Harness<any, any>;
  readonly schedules: readonly DiscoveredSchedule[];
  /** Where each schedule's last run is recorded, so a restart neither repeats nor drops a run. */
  readonly stateDir: string;
  readonly now?: () => Date;
}): ScheduleRunner {
  const now = options.now ?? (() => new Date());
  const running = new Set<string>();

  const start = (entry: DiscoveredSchedule, scheduledFor: Date, sessionId: string, caughtUp: boolean): ScheduleRun => {
    running.add(entry.id);
    const finished = runTurn(options.harness, entry, sessionId)
      .then(async (outcome) => {
        await writeState(options.stateDir, entry.id, (state) => ({
          handledThrough: state?.handledThrough ?? scheduledFor.toISOString(),
          lastRunAt: scheduledFor.toISOString(),
        })).catch(() => {});
        return outcome;
      })
      .finally(() => running.delete(entry.id));
    return { id: entry.id, scheduledFor: scheduledFor.toISOString(), sessionId, caughtUp, finished };
  };

  const dueRuns = async (): Promise<ScheduleRun[]> => {
    const at = now();
    const started: ScheduleRun[] = [];
    for (const entry of options.schedules) {
      if (running.has(entry.id)) continue;
      const state = await readState(options.stateDir, entry.id);
      if (state === undefined) {
        await writeState(options.stateDir, entry.id, () => ({ handledThrough: at.toISOString() }));
        continue;
      }
      const due = latestDue(entry.schedule, new Date(state.handledThrough), at);
      if (due === undefined) continue;
      const caughtUp = at.getTime() - due.getTime() > ON_TIME_MS;
      // Recorded before the run starts: a crash mid-run does not run it again on restart.
      await writeState(options.stateDir, entry.id, (current) => ({
        ...current,
        handledThrough: due.toISOString(),
      }));
      if (caughtUp && !entry.schedule.catchUp) continue;
      started.push(start(entry, due, sessionFor(entry, due), caughtUp));
    }
    return started;
  };

  // Ticks run one at a time, so two overlapping ticks cannot both start the same due run.
  let ticks: Promise<unknown> = Promise.resolve();

  return {
    tick() {
      const next = ticks.then(() => dueRuns());
      ticks = next.catch(() => {});
      return next;
    },
    async run(id) {
      const entry = options.schedules.find((candidate) => candidate.id === id);
      if (entry === undefined) {
        const known = options.schedules.map((candidate) => candidate.id).join(", ") || "(none)";
        throw new HarnessInputError(`No schedule '${id}'. Schedules: ${known}.`, { id });
      }
      const at = now();
      const run = start(entry, at, sessionFor(entry, at), false);
      return { ...run, outcome: await run.finished };
    },
    async list() {
      const at = now();
      return Promise.all(options.schedules.map(async (entry) => {
        const state = await readState(options.stateDir, entry.id);
        const next = nextCronTime(scheduleCron(entry.schedule), at, entry.schedule.timezone);
        return {
          id: entry.id,
          cron: entry.schedule.cron,
          timezone: entry.schedule.timezone,
          ...(entry.schedule.description === undefined ? {} : { description: entry.schedule.description }),
          ...(next === undefined ? {} : { next: next.toISOString() }),
          ...(state?.lastRunAt === undefined ? {} : { lastRunAt: state.lastRunAt }),
        };
      }));
    },
  };
}

async function runTurn(harness: Harness<any, any>, entry: DiscoveredSchedule, session: string): Promise<ScheduleRunOutcome> {
  const { schedule } = entry;
  try {
    const result = await generateHarness({
      harness,
      session,
      ...(schedule.prompt !== undefined ? { prompt: schedule.prompt } : { type: schedule.type!, input: schedule.input }),
      trigger: {
        kind: "schedule",
        source: entry.id,
        ...(schedule.description === undefined ? {} : { label: schedule.description }),
      },
    });
    return { status: result.status, result };
  } catch (error) {
    return { status: "failed", error };
  }
}

/** The latest cron time after `handledThrough` and no later than `at`; several missed run once. */
function latestDue(schedule: HarnessSchedule, handledThrough: Date, at: Date): Date | undefined {
  const cron = scheduleCron(schedule);
  let due = nextCronTime(cron, handledThrough, schedule.timezone);
  if (due === undefined || due > at) return undefined;
  for (let steps = 0; steps < 10_000; steps += 1) {
    const later = nextCronTime(cron, due, schedule.timezone);
    if (later === undefined || later > at) return due;
    due = later;
  }
  return due;
}

function sessionFor(entry: DiscoveredSchedule, at: Date): string {
  if (entry.schedule.session !== "new") return entry.schedule.session;
  return `schedule-${entry.id}-${at.toISOString().slice(0, 16).replace(/[-:]/gu, "")}`;
}

async function readState(dir: string, id: string): Promise<ScheduleState | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, `${id}.json`), "utf8")) as ScheduleState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeState(
  dir: string,
  id: string,
  update: (state: ScheduleState | undefined) => ScheduleState,
): Promise<void> {
  const next = update(await readState(dir, id));
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${id}.json`);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`);
  await rename(temporary, path);
}
