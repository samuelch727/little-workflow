import { MockLanguageModelV3 } from "ai/test";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { createHarness } from "../create-harness.js";
import type {
  DurableHarnessEventInput,
  HarnessPriorEventQuery,
  HarnessSessionLog,
} from "../events/occurrence.js";
import { localHost } from "../local-host/index.js";
import { inMemorySessionLog } from "../remote-session/session-log-store.js";
import { withTempDir } from "../test/temp.js";
import { generateHarness } from "./generate-harness.js";
import { streamHarness } from "./stream-harness.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

type Api = "generateHarness" | "streamHarness";

/**
 * Calls charge({ order: "A" }) until the prompt holds a tool result, then answers "charged".
 * Deciding from the prompt keeps the script the same on a replayed run.
 */
function chargeModel() {
  const toolTurn = (prompt: readonly { role: string }[]) => !prompt.some((message) => message.role === "tool");
  return new MockLanguageModelV3({
    provider: "test",
    modelId: "charge-model",
    doGenerate: async (options) =>
      toolTurn(options.prompt)
        ? {
            content: [
              { type: "tool-call", toolCallId: "call_1", toolName: "charge", input: JSON.stringify({ order: "A" }) },
            ],
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
            usage,
            warnings: [],
          }
        : {
            content: [{ type: "text", text: "charged" }],
            finishReason: { unified: "stop", raw: "stop" },
            usage,
            warnings: [],
          },
    doStream: async (options) => {
      const callTool = toolTurn(options.prompt);
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            if (callTool) {
              controller.enqueue({
                type: "tool-call",
                toolCallId: "call_1",
                toolName: "charge",
                input: JSON.stringify({ order: "A" }),
              });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage,
              });
            } else {
              controller.enqueue({ type: "text-start", id: "0" });
              controller.enqueue({ type: "text-delta", id: "0", delta: "charged" });
              controller.enqueue({ type: "text-end", id: "0" });
              controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
            }
            controller.close();
          },
        }),
      };
    },
  });
}

async function runTurn(
  api: Api,
  options: { harness: ReturnType<typeof createHarness>; session: string; runId: string },
): Promise<{ status: string }> {
  const turn = { ...options, prompt: "Charge order A." };
  if (api === "generateHarness") {
    return generateHarness(turn);
  }
  const run = streamHarness(turn);
  return run.finished;
}

/** The turn's result, or the error it failed with. */
function settle(turn: Promise<{ status: string }>): Promise<{ status: string } | Error> {
  return turn.catch((error: unknown) => error as Error);
}

function chargeHarness(dir: string, sessionLog: HarnessSessionLog) {
  const counter = { writes: 0 };
  const harness = createHarness({
    host: localHost({ dataDir: dir }),
    model: chargeModel(),
    sessionLog,
    tools: {
      charge: tool({
        description: "Charge an order.",
        inputSchema: z.object({ order: z.string() }),
        execute: async () => {
          counter.writes += 1;
        },
      }),
    } as ToolSet,
  });
  return { harness, counter };
}

/**
 * inMemorySessionLog, except that the first `times` appends `rejects` picks throw before
 * anything is committed, as a session log that is down would.
 */
function rejectingSessionLog(
  rejects: (event: DurableHarnessEventInput) => boolean,
  times = Number.POSITIVE_INFINITY,
) {
  const log = inMemorySessionLog();
  let rejected = 0;
  return {
    events: log.events,
    append: async (event: DurableHarnessEventInput) => {
      if (rejected < times && rejects(event)) {
        rejected += 1;
        throw new Error(`session log rejected ${event.type}`);
      }
      return log.append(event);
    },
    priorEvents: (query?: HarnessPriorEventQuery) => log.priorEvents(query),
  };
}

function eventsOfType<TEvent extends { type: string }>(events: readonly TEvent[], type: string): TEvent[] {
  return events.filter((event) => event.type === type);
}

describe.each<Api>(["generateHarness", "streamHarness"])("%s durable tool records", (api) => {
  it("replays a recorded void tool result instead of running the tool again", async () => {
    await withTempDir(async (dir) => {
      const sessionLog = inMemorySessionLog();
      const { harness, counter } = chargeHarness(dir, sessionLog);
      const turn = { harness, session: "charge-session", runId: "run_charge" };

      expect(await runTurn(api, turn)).toMatchObject({ status: "completed" });
      expect(counter.writes).toBe(1);
      expect(await runTurn(api, turn)).toMatchObject({ status: "completed" });
      expect(counter.writes).toBe(1);

      const succeeded = eventsOfType(sessionLog.events, "harness.tool_call.succeeded");
      expect(succeeded).toHaveLength(1);
      expect(succeeded[0]?.payload).toMatchObject({ toolName: "charge", resultUndefined: true });
      expect(succeeded[0]?.payload).not.toHaveProperty("result");
    });
  });

  it("does not run a tool whose start record the session log did not acknowledge", async () => {
    await withTempDir(async (dir) => {
      const sessionLog = rejectingSessionLog((event) => event.type === "harness.tool_call.started", 1);
      const { harness, counter } = chargeHarness(dir, sessionLog);
      const turn = { harness, session: "charge-session", runId: "run_charge" };

      const outcome = await settle(runTurn(api, turn));
      expect(counter.writes).toBe(0);
      expect(eventsOfType(sessionLog.events, "harness.tool_call.started")).toHaveLength(0);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe("session log rejected harness.tool_call.started");

      // Once the log is back, the same run starts the call afresh and runs it once.
      expect(await runTurn(api, turn)).toMatchObject({ status: "completed" });
      expect(counter.writes).toBe(1);
    });
  });

  it("fails the turn when the session log did not acknowledge a tool's success record", async () => {
    await withTempDir(async (dir) => {
      const sessionLog = rejectingSessionLog((event) => event.type === "harness.tool_call.succeeded", 1);
      const { harness, counter } = chargeHarness(dir, sessionLog);

      const outcome = await settle(runTurn(api, { harness, session: "charge-session", runId: "run_charge" }));
      expect(counter.writes).toBe(1);
      expect(eventsOfType(sessionLog.events, "harness.tool_call.succeeded")).toHaveLength(0);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe("session log rejected harness.tool_call.succeeded");
    });
  });

  it("fails the turn when the session log acknowledges no model response", async () => {
    await withTempDir(async (dir) => {
      const sessionLog = rejectingSessionLog((event) => event.type === "harness.model.responded");
      const { harness } = chargeHarness(dir, sessionLog);

      const outcome = await settle(runTurn(api, { harness, session: "charge-session", runId: "run_charge" }));
      expect(eventsOfType(sessionLog.events, "harness.model.responded")).toHaveLength(0);
      expect(outcome).toMatchObject({ name: "HarnessTerminalStageError", stage: "model_responded" });
    });
  });

  it("retries the final model response record once before failing the turn", async () => {
    await withTempDir(async (dir) => {
      const sessionLog = rejectingSessionLog(
        (event) => event.type === "harness.model.responded" && event.payload?.turn === 2,
        1,
      );
      const { harness } = chargeHarness(dir, sessionLog);

      expect(await runTurn(api, { harness, session: "charge-session", runId: "run_charge" }))
        .toMatchObject({ status: "completed" });
      expect(eventsOfType(sessionLog.events, "harness.model.responded")).toHaveLength(2);
    });
  });
});
