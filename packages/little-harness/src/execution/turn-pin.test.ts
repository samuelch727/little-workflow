import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { harnessToolContext } from "../connectors/tool-context.js";
import { createHarness } from "../create-harness.js";
import { answerInputRequest, listInputRequests } from "../human-input/answers.js";
import { localHost } from "../local-host/index.js";
import { withTempDir } from "../test/temp.js";
import type { Harness, HarnessTurnContext, HarnessTurnStart } from "../types.js";
import { generateHarness } from "./generate-harness.js";
import { resumeParked } from "./resume-parked.js";
import { streamHarness } from "./stream-harness.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** Asks to change the margin, waiting in its call for a person's approval; then says it's done. */
function marginModel() {
  const respond = (prompt: ReadonlyArray<{ role: string }>) =>
    prompt.some((message) => message.role === "tool")
      ? { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" } }
      : {
          content: [{ type: "tool-call" as const, toolCallId: "call_1", toolName: "change", input: JSON.stringify({ to: ".05" }) }],
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
        };
  return new MockLanguageModelV3({
    doGenerate: async (options) => ({ ...respond(options.prompt), usage, warnings: [] }),
    doStream: async (options) => {
      const response = respond(options.prompt);
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            for (const part of response.content) {
              if (part.type === "text") {
                controller.enqueue({ type: "text-start", id: "t" });
                controller.enqueue({ type: "text-delta", id: "t", delta: part.text });
                controller.enqueue({ type: "text-end", id: "t" });
              } else controller.enqueue(part);
            }
            controller.enqueue({ type: "finish", finishReason: response.finishReason, usage });
            controller.close();
          },
        }),
      };
    },
  });
}

const change = tool({
  description: "Change the margin.",
  inputSchema: z.object({ to: z.string() }),
  execute: async ({ to }, options) => {
    const asked = await harnessToolContext(options).ask!(
      { question: `Change the margin to ${to}?`, options: [{ id: "approve", label: "Approve" }] },
      { key: "card", wait: true },
    );
    return asked.status === "parked" ? asked.output : `changed to ${to}`;
  },
});

async function approve(harness: Harness, sessionId: string): Promise<void> {
  const [request] = await listInputRequests({ harness, sessionId });
  await answerInputRequest({ harness, sessionId, requestId: request!.requestId, answer: { option: "approve" } });
}

describe("a parked turn's turnOptions decision", () => {
  it("is saved when the turn parks, streamed or not, and handed to the hook of the turn that continues it", async () => {
    for (const run of ["generate", "stream"] as const) {
      await withTempDir(async (dir) => {
        const live = { version: "v1" };
        const told: Array<HarnessTurnContext["resumed"]> = [];
        const harness = createHarness({
          host: localHost({ dataDir: dir, sandbox: "in-process" }),
          model: marginModel(),
          tools: { change },
          humanInput: { tool: false },
          runtime: { bash: false },
          turnOptions: (turn) => {
            told.push(turn.resumed);
            const version = (turn.resumed?.pin as { version?: string } | undefined)?.version ?? live.version;
            return { metadata: { version }, pin: { version } };
          },
        });
        const starts: HarnessTurnStart[] = [];
        if (run === "generate") {
          expect(await generateHarness({ harness, session: "s", prompt: "Lower it.", onTurnStart: (start) => void starts.push(start) }))
            .toMatchObject({ status: "parked" });
        } else {
          const streamed = streamHarness({ harness, session: "s", prompt: "Lower it.", onTurnStart: (start) => void starts.push(start) });
          expect(await streamed.finished).toMatchObject({ status: "parked" });
        }
        live.version = "v2";
        await approve(harness, "s");
        const { resumed } = await resumeParked({ harness, onTurnStart: (start) => void starts.push(start) });
        expect(resumed[0]?.result).toMatchObject({ status: "completed", text: "done" });

        expect(told).toEqual([undefined, { continuationId: expect.any(String), pin: { version: "v1" }, metadata: { version: "v1" } }]);
        expect(starts).toEqual([
          { sessionId: "s", turnId: expect.any(String), metadata: { version: "v1" } },
          { sessionId: "s", turnId: expect.any(String), metadata: { version: "v1" } },
        ]);
        expect(starts[1]!.turnId).not.toBe(starts[0]!.turnId);
      });
    }
  });

  it("keeps the parked turn's metadata for a continued turn whose hook returns none", async () => {
    await withTempDir(async (dir) => {
      const harness = createHarness({
        host: localHost({ dataDir: dir, sandbox: "in-process" }),
        model: marginModel(),
        tools: { change },
        humanInput: { tool: false },
        runtime: { bash: false },
        turnOptions: (turn) => (turn.resumed === undefined ? { metadata: { version: "v1" } } : {}),
      });
      const starts: HarnessTurnStart[] = [];
      await generateHarness({ harness, session: "s", prompt: "Lower it.", onTurnStart: (start) => void starts.push(start) });
      await approve(harness, "s");
      await resumeParked({ harness, onTurnStart: (start) => void starts.push(start) });
      expect(starts.map((start) => start.metadata)).toEqual([{ version: "v1" }, { version: "v1" }]);
    });
  });
});
