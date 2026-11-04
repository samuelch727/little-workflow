import { HarnessInputError } from "../errors.js";

/**
 * A five-field cron expression (`minute hour day-of-month month day-of-week`), as in crontab:
 * numbers, `*`, ranges (`1-5`), steps (`*\/15`, `9-17/2`), lists (`1,15`), and month and day names
 * (`JAN`, `MON-FRI`). Sunday is 0 or 7. When both day fields are restricted, a day matching either
 * one matches, as crontab does.
 */
export type CronExpression = {
  readonly source: string;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  readonly dayOfMonthRestricted: boolean;
  readonly dayOfWeekRestricted: boolean;
};

const MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

export function parseCron(source: string): CronExpression {
  if (typeof source !== "string") throw new HarnessInputError("cron must be text.");
  const fields = source.trim().split(/\s+/u);
  if (fields.length !== 5) {
    throw new HarnessInputError(`cron '${source}' needs five fields: minute hour day-of-month month day-of-week.`, {
      cron: source,
    });
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
  const daysOfWeek = parseField(source, "day-of-week", dayOfWeek, 0, 7, DAY_NAMES);
  if (daysOfWeek.has(7)) {
    daysOfWeek.delete(7);
    daysOfWeek.add(0);
  }
  return {
    source,
    minutes: parseField(source, "minute", minute, 0, 59),
    hours: parseField(source, "hour", hour, 0, 23),
    daysOfMonth: parseField(source, "day-of-month", dayOfMonth, 1, 31),
    months: parseField(source, "month", month, 1, 12, MONTH_NAMES, 1),
    daysOfWeek,
    dayOfMonthRestricted: !dayOfMonth.startsWith("*"),
    dayOfWeekRestricted: !dayOfWeek.startsWith("*"),
  };
}

/** Throws unless `timeZone` is an IANA time zone this runtime knows. */
export function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new HarnessInputError(`Unknown time zone '${timeZone}'. Use an IANA name such as 'Asia/Hong_Kong'.`, {
      timeZone,
    });
  }
}

/**
 * The first minute strictly after `after` that the expression matches, read as wall-clock time
 * in `timeZone`. A time a daylight-saving change skips does not fire; a repeated hour fires
 * once for each time it occurs. Returns undefined when nothing matches within five years (such
 * as `0 0 30 2 *`).
 */
export function nextCronTime(cron: CronExpression, after: Date, timeZone: string): Date | undefined {
  const format = wallClock(timeZone);
  let time = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const limit = after.getTime() + 5 * 366 * 24 * 60 * 60_000;
  while (time <= limit) {
    const local = format(time);
    if (!cron.months.has(local.month) || !dayMatches(cron, local)) {
      // To 23:00, then to midnight: a day a clock change shortens never skips the next midnight.
      time += ((local.hour < 23 ? (22 - local.hour) * 60 : 0) + (60 - local.minute)) * 60_000;
      continue;
    }
    if (!cron.hours.has(local.hour)) {
      time += (60 - local.minute) * 60_000;
      continue;
    }
    if (!cron.minutes.has(local.minute)) {
      time += 60_000;
      continue;
    }
    return new Date(time);
  }
  return undefined;
}

type WallClock = { readonly month: number; readonly day: number; readonly weekday: number; readonly hour: number; readonly minute: number };

function wallClock(timeZone: string): (time: number) => WallClock {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
  });
  return (time) => {
    const parts = Object.fromEntries(formatter.formatToParts(time).map((part) => [part.type, part.value]));
    return {
      month: Number(parts.month),
      day: Number(parts.day),
      weekday: DAY_NAMES.indexOf(String(parts.weekday).toUpperCase()),
      hour: Number(parts.hour) % 24,
      minute: Number(parts.minute),
    };
  };
}

function dayMatches(cron: CronExpression, local: WallClock): boolean {
  const byMonth = cron.daysOfMonth.has(local.day);
  const byWeek = cron.daysOfWeek.has(local.weekday);
  if (cron.dayOfMonthRestricted && cron.dayOfWeekRestricted) return byMonth || byWeek;
  return byMonth && byWeek;
}

function parseField(
  source: string,
  name: string,
  field: string,
  min: number,
  max: number,
  names: readonly string[] = [],
  nameOffset = 0,
): Set<number> {
  const values = new Set<number>();
  const fail = (): never => {
    throw new HarnessInputError(`cron '${source}' has an invalid ${name} field '${field}'.`, { cron: source, field: name });
  };
  for (const part of field.split(",")) {
    const [range, stepText, extra] = part.split("/");
    if (range === undefined || range === "" || extra !== undefined) fail();
    const step = stepText === undefined ? 1 : integer(stepText);
    if (step === undefined || step < 1) fail();
    let start: number;
    let end: number;
    if (range === "*") {
      start = min;
      end = max;
    } else {
      const [low, high, more] = range!.split("-");
      if (more !== undefined) fail();
      start = value(low!, names, nameOffset) ?? fail();
      end = high === undefined ? (stepText === undefined ? start : max) : value(high, names, nameOffset) ?? fail();
    }
    if (start < min || end > max || start > end) fail();
    for (let current = start; current <= end; current += step!) values.add(current);
  }
  return values;
}

function value(text: string, names: readonly string[], offset: number): number | undefined {
  const named = names.indexOf(text.toUpperCase());
  return named >= 0 ? named + offset : integer(text);
}

function integer(text: string): number | undefined {
  return /^\d+$/u.test(text) ? Number(text) : undefined;
}
