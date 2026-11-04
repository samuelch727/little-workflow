import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createHarness } from "../create-harness.js";
import { localHost } from "../local-host/index.js";
import { withTempDir } from "../test/temp.js";
import { nextCronTime, parseCron } from "./cron.js";
import { createScheduleRunner } from "./runner.js";
import { defineSchedule, discoverSchedules } from "./schedule.js";

const next = (cron: string, after: string, timeZone = "UTC") =>
  nextCronTime(parseCron(cron), new Date(after), timeZone)?.toISOString();

describe("cron", () => {
  it("finds the next matching minute", () => {
    expect(next("* * * * *", "2026-10-14T09:00:30Z")).toBe("2026-10-14T09:01:00.000Z");
    expect(next("0 9 * * *", "2026-10-14T09:00:00Z")).toBe("2026-10-15T09:00:00.000Z");
    expect(next("*/15 9-17 * * *", "2026-10-14T17:50:00Z")).toBe("2026-10-15T09:00:00.000Z");
    expect(next("30 8 1,15 * *", "2026-10-14T00:00:00Z")).toBe("2026-10-15T08:30:00.000Z");
    expect(next("0 0 1 JAN *", "2026-10-14T00:00:00Z")).toBe("2027-01-01T00:00:00.000Z");
  });

  it("reads weekdays, with Sunday as 0 or 7", () => {
    // 2026-10-14 is a Wednesday.
    expect(next("0 9 * * MON-FRI", "2026-10-16T10:00:00Z")).toBe("2026-10-19T09:00:00.000Z");
    expect(next("0 9 * * 7", "2026-10-14T00:00:00Z")).toBe("2026-10-18T09:00:00.000Z");
    expect(next("0 9 * * 0", "2026-10-14T00:00:00Z")).toBe("2026-10-18T09:00:00.000Z");
    // Both day fields restricted: either one matches, as crontab does.
    expect(next("0 9 13 * FRI", "2026-10-14T00:00:00Z")).toBe("2026-10-16T09:00:00.000Z");
  });

  it("reads the cron in the schedule's time zone", () => {
    expect(next("0 9 * * *", "2026-10-14T00:00:00Z", "Asia/Hong_Kong")).toBe("2026-10-14T01:00:00.000Z");
    // New York leaves daylight saving on 2026-11-01: 09:00 is 13:00Z before and 14:00Z after.
    expect(next("0 9 * * *", "2026-10-31T14:00:00Z", "America/New_York")).toBe("2026-11-01T14:00:00.000Z");
    // A midnight right after the spring change still fires.
    expect(next("0 0 * * MON", "2026-03-07T12:00:00Z", "America/New_York")).toBe("2026-03-09T04:00:00.000Z");
  });

  it("refuses expressions it cannot read", () => {
    expect(() => parseCron("0 9 * *")).toThrow(/five fields/);
    expect(() => parseCron("60 * * * *")).toThrow(/minute field/);
    expect(() => parseCron("0 9 * * MON-FUNDAY")).toThrow(/day-of-week field/);
    expect(() => parseCron("*/0 * * * *")).toThrow(/minute field/);
    expect(next("0 0 30 2 *", "2026-10-14T00:00:00Z")).toBeUndefined();
  });
});

describe("defineSchedule", () => {
  it("needs a prompt or a type, and a known time zone", () => {
    expect(() => defineSchedule({ cron: "0 9 * * *" })).toThrow(/prompt.*or.*type/);
    expect(() => defineSchedule({ cron: "0 9 * * *", prompt: "a", type: "b" })).toThrow(/not both/);
    expect(() => defineSchedule({ cron: "0 9 * * *", prompt: "a", timezone: "Mars/Olympus" })).toThrow(/time zone/);
    expect(defineSchedule({ cron: "0 9 * * *", prompt: "Go." })).toMatchObject({ session: "new", catchUp: true });
  });

  it("finds schedules in an agent folder", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "schedules"));
      const harnessEntry = join(process.cwd(), "src/schedules/schedule.ts");
      await writeFile(
        join(dir, "schedules", "morning-backlog.ts"),
        `import { defineSchedule } from ${JSON.stringify(harnessEntry)};\nexport default defineSchedule({ cron: "0 9 * * 1-5", timezone: "Asia/Hong_Kong", prompt: "Work the backlog." });\n`,
      );
      await writeFile(join(dir, "schedules", "notes.md"), "not a schedule");
      const found = await discoverSchedules(dir);
      expect(found.map((entry) => [entry.id, entry.schedule.cron, entry.schedule.timezone])).toEqual([
        ["morning-backlog", "0 9 * * 1-5", "Asia/Hong_Kong"],
      ]);
      expect(await discoverSchedules(join(dir, "missing"))).toEqual([]);
    });
  });
});

describe("schedule runner", () => {
  function setup(dir: string, schedules: Parameters<typeof defineSchedule>[0][], clock: { now: Date }) {
    const prompts: string[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        const user = options.prompt.filter((message) => message.role === "user").at(-1);
        prompts.push(JSON.stringify(user?.content));
        return {
          content: [{ type: "text", text: "done" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
          warnings: [],
        };
      },
    });
    const harness = createHarness({ host: localHost({ dataDir: join(dir, "data"), sandbox: "in-process" }), model, runtime: { bash: false } });
    const runner = createScheduleRunner({
      harness,
      schedules: schedules.map((options, index) => ({ id: `s${index + 1}`, path: "", schedule: defineSchedule(options) })),
      stateDir: join(dir, "state"),
      now: () => clock.now,
    });
    return { runner, prompts };
  }

  it("runs each cron time once, starting from when it first sees the schedule", async () => {
    await withTempDir(async (dir) => {
      const clock = { now: new Date("2026-10-14T08:59:30Z") };
      const { runner, prompts } = setup(dir, [{ cron: "0 9 * * *", timezone: "UTC", prompt: "Morning backlog." }], clock);
      expect(await runner.tick()).toEqual([]);

      clock.now = new Date("2026-10-14T09:00:10Z");
      const [run] = await runner.tick();
      expect(run).toMatchObject({ id: "s1", scheduledFor: "2026-10-14T09:00:00.000Z", sessionId: "schedule-s1-20261014T0900", caughtUp: false });
      expect(await run!.finished).toMatchObject({ status: "completed" });
      expect(prompts).toEqual(['[{"type":"text","text":"Morning backlog."}]']);

      // The same minute again, or a restarted runner, does not run it twice.
      clock.now = new Date("2026-10-14T09:00:40Z");
      expect(await runner.tick()).toEqual([]);
      const restarted = setup(dir, [{ cron: "0 9 * * *", timezone: "UTC", prompt: "Morning backlog." }], clock).runner;
      expect(await restarted.tick()).toEqual([]);
      expect(await restarted.list()).toEqual([
        { id: "s1", cron: "0 9 * * *", timezone: "UTC", next: "2026-10-15T09:00:00.000Z", lastRunAt: "2026-10-14T09:00:00.000Z" },
      ]);
    });
  });

  it("runs missed times once on start, unless catchUp is off", async () => {
    await withTempDir(async (dir) => {
      const clock = { now: new Date("2026-10-14T08:00:00Z") };
      const schedules = [
        { cron: "0 * * * *", timezone: "UTC", prompt: "Hourly." },
        { cron: "0 * * * *", timezone: "UTC", prompt: "Hourly, no catch-up.", catchUp: false },
      ];
      await setup(dir, schedules, clock).runner.tick();

      // Down from 08:00 to 11:30: three missed times run once, as the 11:00 run.
      clock.now = new Date("2026-10-14T11:30:00Z");
      const { runner, prompts } = setup(dir, schedules, clock);
      const runs = await runner.tick();
      expect(runs.map((run) => [run.id, run.scheduledFor, run.caughtUp])).toEqual([["s1", "2026-10-14T11:00:00.000Z", true]]);
      await Promise.all(runs.map((run) => run.finished));
      expect(prompts).toHaveLength(1);

      clock.now = new Date("2026-10-14T12:00:20Z");
      const onTime = await runner.tick();
      expect(onTime.map((run) => run.id)).toEqual(["s1", "s2"]);
      await Promise.all(onTime.map((run) => run.finished));
    });
  });

  it("starts a due run once when ticks overlap", async () => {
    await withTempDir(async (dir) => {
      const clock = { now: new Date("2026-10-14T08:59:30Z") };
      const { runner, prompts } = setup(dir, [{ cron: "0 9 * * *", timezone: "UTC", prompt: "Morning backlog." }], clock);
      await runner.tick();
      clock.now = new Date("2026-10-14T09:00:10Z");
      const runs = (await Promise.all([runner.tick(), runner.tick(), runner.tick()])).flat();
      expect(runs.map((run) => run.scheduledFor)).toEqual(["2026-10-14T09:00:00.000Z"]);
      await runs[0]!.finished;
      expect(prompts).toHaveLength(1);
    });
  });

  it("runs a schedule by hand without moving its cron", async () => {
    await withTempDir(async (dir) => {
      const clock = { now: new Date("2026-10-14T10:00:00Z") };
      const { runner } = setup(dir, [{ cron: "0 9 * * *", timezone: "UTC", prompt: "Go.", session: "backlog" }], clock);
      const run = await runner.run("s1");
      expect(run).toMatchObject({ sessionId: "backlog", outcome: { status: "completed" } });
      await expect(runner.run("nope")).rejects.toThrow(/No schedule 'nope'/);
    });
  });
});
