import { readdir } from "node:fs/promises";
import { join, parse } from "node:path";
import { HarnessInputError } from "../errors.js";
import { importDefault } from "../workspace/module-loader.js";
import { assertTimeZone, parseCron, type CronExpression } from "./cron.js";

const SCHEDULE = Symbol.for("little-harness.schedule");
const SOURCE_EXTENSIONS = new Set([".ts", ".js", ".mts", ".mjs", ".cts", ".cjs"]);
const SCHEDULE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

export type HarnessScheduleOptions = {
  /** When to run, as a five-field cron expression: `"0 9 * * 1-5"` is 09:00 on weekdays. */
  cron: string;
  /** The IANA time zone the cron is read in. Default: the server's time zone. */
  timezone?: string;
  /** What to ask the agent, as one user message. Give this or `type`. */
  prompt?: string;
  /** An Input Type to run, with `input`, as `generateHarness({ type, input })` does. */
  type?: string;
  input?: unknown;
  /**
   * The session each run uses. `"new"` (the default) starts a new session per run; a fixed id
   * keeps one running conversation.
   */
  session?: string;
  /**
   * Whether a run missed while the server was down runs once when it starts again. Default true.
   * Several missed runs still run once.
   */
  catchUp?: boolean;
  description?: string;
};

export type HarnessSchedule = Readonly<HarnessScheduleOptions> & {
  readonly cron: string;
  readonly timezone: string;
  readonly session: string;
  readonly catchUp: boolean;
  readonly [SCHEDULE]: CronExpression;
};

/**
 * A run of the agent on a timer. Default-export one from `schedules/<id>.ts` in an agent folder;
 * `little-harness dev` and `start` run it.
 */
export function defineSchedule(options: HarnessScheduleOptions): HarnessSchedule {
  if (typeof options !== "object" || options === null) throw new HarnessInputError("defineSchedule needs options.");
  const cron = parseCron(options.cron);
  const timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  assertTimeZone(timezone);
  const hasPrompt = options.prompt !== undefined;
  const hasType = options.type !== undefined;
  if (hasPrompt === hasType) {
    throw new HarnessInputError("A schedule needs `prompt` or `type` (with `input`), not both.");
  }
  if (hasPrompt && (typeof options.prompt !== "string" || options.prompt.trim().length === 0)) {
    throw new HarnessInputError("A schedule's `prompt` must be non-empty text.");
  }
  if (hasType && (typeof options.type !== "string" || options.type.length === 0)) {
    throw new HarnessInputError("A schedule's `type` must be an Input Type name.");
  }
  if (options.input !== undefined && !hasType) {
    throw new HarnessInputError("A schedule's `input` goes with `type`.");
  }
  const session = options.session ?? "new";
  if (typeof session !== "string" || session.length === 0) {
    throw new HarnessInputError("A schedule's `session` must be \"new\" or a session id.");
  }
  return {
    ...options,
    cron: options.cron,
    timezone,
    session,
    catchUp: options.catchUp ?? true,
    [SCHEDULE]: cron,
  };
}

export function isHarnessSchedule(value: unknown): value is HarnessSchedule {
  return typeof value === "object" && value !== null && SCHEDULE in value;
}

/** The parsed cron of a schedule. */
export function scheduleCron(schedule: HarnessSchedule): CronExpression {
  return schedule[SCHEDULE];
}

export type DiscoveredSchedule = {
  /** The file name without its extension. */
  readonly id: string;
  readonly path: string;
  readonly schedule: HarnessSchedule;
};

/** The schedules in `<agentDir>/schedules/*.ts`, one per file, sorted by id. */
export async function discoverSchedules(agentDir: string): Promise<DiscoveredSchedule[]> {
  const dir = join(agentDir, "schedules");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const schedules: DiscoveredSchedule[] = [];
  for (const entry of entries.sort()) {
    const { name, ext } = parse(entry);
    if (!SOURCE_EXTENSIONS.has(ext) || name.endsWith(".d")) continue;
    if (name.endsWith(".test") || name.endsWith(".spec")) continue;
    const path = join(dir, entry);
    if (!SCHEDULE_ID.test(name)) {
      throw new HarnessInputError(`Schedule file name '${name}' must be letters, digits, '-' and '_'.`, { path });
    }
    const schedule = await importDefault<unknown>(path);
    if (!isHarnessSchedule(schedule)) {
      throw new HarnessInputError("A schedule file must default-export defineSchedule({ ... }).", { path });
    }
    schedules.push({ id: name, path, schedule });
  }
  return schedules;
}
