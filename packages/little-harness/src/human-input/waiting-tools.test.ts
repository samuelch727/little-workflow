import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createHarness } from "../create-harness.js";
import { harnessToolContext } from "../connectors/tool-context.js";
import { generateHarness } from "../execution/generate-harness.js";
import { resumeParked } from "../execution/resume-parked.js";
import { streamHarness } from "../execution/stream-harness.js";
import { localHost } from "../local-host/index.js";
import { inMemorySessionLog } from "../remote-session/session-log-store.js";
import { withTempDir } from "../test/temp.js";
import { answerInputRequest, listInputRequests } from "./answers.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

type Prompt = ReadonlyArray<{ role: string; content: unknown }>;
type Step = (prompt: Prompt) => { calls: ReadonlyArray<{ toolName: string; input: unknown }> } | { text: string };

/** A model that plays the given steps in order, one per model call; a step may call several tools. */
function scriptedModel(steps: readonly Step[], prompts: Prompt[] = []) {
  let index = 0;
  const respond = (prompt: Prompt) => {
    prompts.push(prompt);
    const step = steps[index];
    index += 1;
    if (step === undefined) throw new Error(`No scripted step ${index}.`);
    const next = step(prompt);
    return "text" in next
      ? { content: [{ type: "text" as const, text: next.text }], finishReason: { unified: "stop" as const, raw: "stop" } }
      : {
          content: next.calls.map((call, position) => ({
            type: "tool-call" as const,
            toolCallId: `call_${index}_${position + 1}`,
            toolName: call.toolName,
            input: JSON.stringify(call.input),
          })),
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
        };
  };
  return new MockLanguageModelV3({
    doGenerate: async (options) => ({ ...respond(options.prompt as Prompt), usage, warnings: [] }),
    doStream: async (options) => {
      const response = respond(options.prompt as Prompt);
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            for (const part of response.content) {
              if (part.type === "text") {
                controller.enqueue({ type: "text-start", id: "t" });
                controller.enqueue({ type: "text-delta", id: "t", delta: part.text });
                controller.enqueue({ type: "text-end", id: "t" });
              } else {
                controller.enqueue(part);
              }
            }
            controller.enqueue({ type: "finish", finishReason: response.finishReason, usage });
            controller.close();
          },
        }),
      };
    },
  });
}

/** Every tool result the model was sent, by tool call id. */
function toolResults(prompt: Prompt): Record<string, { type: string; value: unknown }> {
  return Object.fromEntries(prompt.flatMap((message) =>
    message.role === "tool" && Array.isArray(message.content)
      ? (message.content as Array<{ type: string; toolCallId: string; output: { type: string; value: unknown } }>)
          .filter((part) => part.type === "tool-result")
          .map((part) => [part.toolCallId, part.output])
      : []
  ));
}

type Run = { readonly toolCallId: string; readonly extraBody: unknown };

/** A tool that changes something only once a person approves it, waiting in its own call. */
function approvalTools(runs: Run[], reads: { count: number }) {
  return {
    change: tool({
      description: "Change the margin.",
      inputSchema: z.object({ to: z.string() }),
      execute: async ({ to }, options) => {
        const context = harnessToolContext(options);
        runs.push({ toolCallId: options.toolCallId, extraBody: context.extraBody });
        const asked = await context.ask!(
          { question: `Change the margin to ${to}?`, options: [{ id: "approve", label: "Approve" }, { id: "decline", label: "Decline" }] },
          { key: `card-${options.toolCallId}`, wait: true },
        );
        if (asked.status === "parked") return asked.output;
        return asked.answer?.option === "approve" ? `changed to ${to}` : "declined";
      },
    }),
    read: tool({
      description: "Read the margin.",
      inputSchema: z.object({}),
      execute: async () => {
        reads.count += 1;
        return "margin .10";
      },
    }),
  };
}

async function answer(harness: Parameters<typeof listInputRequests>[0]["harness"], sessionId: string, question: RegExp, option: string) {
  const waiting = await listInputRequests({ harness, sessionId });
  const request = waiting.find((entry) => question.test(entry.question));
  if (request === undefined) throw new Error(`No waiting question like ${question}.`);
  await answerInputRequest({ harness, sessionId, requestId: request.requestId, answer: { option } });
}

describe("a tool waiting for a person in ask", () => {
  it("parks the turn without await_tasks and, once answered, runs the call again with the new extraBody", async () => {
    await withTempDir(async (dir) => {
      const runs: Run[] = [];
      const reads = { count: 0 };
      const prompts: Prompt[] = [];
      const harness = createHarness({
        host: localHost({ dataDir: dir, sandbox: "in-process" }),
        model: scriptedModel([
          () => ({ calls: [{ toolName: "change", input: { to: ".05" } }, { toolName: "read", input: {} }] }),
          (prompt) => ({ text: JSON.stringify(toolResults(prompt)) }),
        ], prompts),
        tools: approvalTools(runs, reads),
        humanInput: { tool: false },
        runtime: { bash: false },
      });

      const parked = await generateHarness({ harness, session: "s", prompt: "Lower the margin.", extraBody: { key: "first" } });
      expect(parked).toMatchObject({ status: "parked", pending: { taskIds: [expect.stringMatching(/^task_/)], mode: "all" } });
      expect(prompts).toHaveLength(1);
      expect(await resumeParked({ harness })).toEqual({ resumed: [], failed: [] });

      await answer(harness, "s", /\.05/, "approve");
      const { resumed, failed } = await resumeParked({ harness, extraBody: { key: "second" } });
      expect(failed).toEqual([]);
      expect(resumed[0]?.result.status).toBe("completed");
      expect(runs).toEqual([
        { toolCallId: "call_1_1", extraBody: { key: "first" } },
        { toolCallId: "call_1_1", extraBody: { key: "second" } },
      ]);
      expect(reads.count).toBe(1);
      expect(toolResults(prompts[1]!)).toEqual({
        call_1_1: { type: "text", value: "changed to .05" },
        call_1_2: { type: "text", value: "margin .10" },
      });
    });
  });

  it("hands a declined answer to the call the same way", async () => {
    await withTempDir(async (dir) => {
      const prompts: Prompt[] = [];
      const harness = createHarness({
        host: localHost({ dataDir: dir, sandbox: "in-process" }),
        model: scriptedModel([
          () => ({ calls: [{ toolName: "change", input: { to: ".01" } }] }),
          (prompt) => ({ text: String(toolResults(prompt).call_1_1?.value) }),
        ], prompts),
        tools: approvalTools([], { count: 0 }),
        humanInput: { tool: false },
        runtime: { bash: false },
      });
      await generateHarness({ harness, session: "s", prompt: "Lower the margin." });
      await answer(harness, "s", /\.01/, "decline");
      const { resumed } = await resumeParked({ harness });
      expect(resumed[0]?.result).toMatchObject({ status: "completed", text: "declined" });
    });
  });

  it("continues a step with two waiting calls only once both have answers, and runs both again", async () => {
    await withTempDir(async (dir) => {
      const runs: Run[] = [];
      const harness = createHarness({
        host: localHost({ dataDir: dir, sandbox: "in-process" }),
        model: scriptedModel([
          () => ({ calls: [{ toolName: "change", input: { to: ".05" } }, { toolName: "change", input: { to: ".01" } }] }),
          (prompt) => ({ text: Object.values(toolResults(prompt)).map((output) => output.value).join(", ") }),
        ]),
        tools: approvalTools(runs, { count: 0 }),
        humanInput: { tool: false },
        runtime: { bash: false },
      });
      const parked = await generateHarness({ harness, session: "s", prompt: "Lower the margin twice." });
      expect(parked).toMatchObject({ status: "parked", pending: { taskIds: [expect.any(String), expect.any(String)] } });

      await answer(harness, "s", /\.05/, "approve");
      expect(await resumeParked({ harness })).toEqual({ resumed: [], failed: [] });
      await answer(harness, "s", /\.01/, "decline");
      const { resumed } = await resumeParked({ harness });
      expect(resumed[0]?.result).toMatchObject({ status: "completed", text: "changed to .05, declined" });
      expect(runs.map((run) => run.toolCallId).sort()).toEqual(["call_1_1", "call_1_1", "call_1_2", "call_1_2"]);
    });
  });

  it("tries a continued turn again without running again the calls it finished, given a session log", async () => {
    await withTempDir(async (dir) => {
      const runs: Run[] = [];
      const harness = createHarness({
        host: localHost({ dataDir: dir, sandbox: "in-process" }),
        model: scriptedModel([
          () => ({ calls: [{ toolName: "change", input: { to: ".05" } }, { toolName: "change", input: { to: ".01" } }] }),
          () => {
            throw new Error("The model is down.");
          },
          (prompt) => ({ text: Object.values(toolResults(prompt)).map((output) => output.value).join(", ") }),
        ]),
        tools: approvalTools(runs, { count: 0 }),
        humanInput: { tool: false },
        runtime: { bash: false },
      });
      await generateHarness({ harness, session: "s", prompt: "Lower the margin twice." });
      await answer(harness, "s", /\.05/, "approve");
      await answer(harness, "s", /\.01/, "approve");

      const logs = new Map<string, ReturnType<typeof inMemorySessionLog>>();
      const sessionLog = (queued: { resumeId: string }) => {
        const log = logs.get(queued.resumeId) ?? inMemorySessionLog();
        logs.set(queued.resumeId, log);
        return log;
      };
      const first = await resumeParked({ harness, sessionLog, retryDelayMs: 0 });
      expect(first.failed).toMatchObject([{ willRetry: true, attempts: 1 }]);
      const second = await resumeParked({ harness, sessionLog, retryDelayMs: 0 });
      expect(second.resumed[0]?.result).toMatchObject({ status: "completed", text: "changed to .05, changed to .01" });
      // Each call ran when it parked and when its turn first continued; the second try replayed both.
      expect(runs.map((run) => run.toolCallId).sort()).toEqual(["call_1_1", "call_1_1", "call_1_2", "call_1_2"]);
      expect([...logs.keys()]).toHaveLength(1);
    });
  });

  it("keeps every earlier step of a turn that parked after several", async () => {
    await withTempDir(async (dir) => {
      const prompts: Prompt[] = [];
      const harness = createHarness({
        host: localHost({ dataDir: dir, sandbox: "in-process" }),
        model: scriptedModel([
          () => ({ calls: [{ toolName: "read", input: {} }] }),
          () => ({ calls: [{ toolName: "change", input: { to: ".05" } }] }),
          () => ({ text: "done" }),
        ], prompts),
        tools: approvalTools([], { count: 0 }),
        humanInput: { tool: false },
        runtime: { bash: false },
      });
      await generateHarness({ harness, session: "s", prompt: "Read, then lower the margin." });
      await answer(harness, "s", /\.05/, "approve");
      await resumeParked({ harness });
      expect(toolResults(prompts[2]!)).toEqual({
        call_1_1: { type: "text", value: "margin .10" },
        call_2_1: { type: "text", value: "changed to .05" },
      });
    });
  });

  it("fails a call that waits on a new question in its second run, and the agent sees why", async () => {
    await withTempDir(async (dir) => {
      const prompts: Prompt[] = [];
      let run = 0;
      const harness = createHarness({
        host: localHost({ dataDir: dir, sandbox: "in-process" }),
        model: scriptedModel([
          () => ({ calls: [{ toolName: "twice", input: {} }] }),
          (prompt) => ({ text: String(toolResults(prompt).call_1_1?.type) }),
        ], prompts),
        tools: {
          twice: tool({
            description: "Asks a new question each run.",
            inputSchema: z.object({}),
            execute: async (_input, options) => {
              run += 1;
              const asked = await harnessToolContext(options).ask!({ question: `Question ${run}?` }, { key: `q${run}`, wait: true });
              return asked.status === "parked" ? asked.output : asked.status;
            },
          }),
        },
        humanInput: { tool: false },
        runtime: { bash: false },
      });
      await generateHarness({ harness, session: "s", prompt: "Go." });
      const [request] = await listInputRequests({ harness, sessionId: "s" });
      await answerInputRequest({ harness, sessionId: "s", requestId: request!.requestId, answer: { text: "yes" } });
      const { resumed } = await resumeParked({ harness });
      expect(resumed[0]?.result).toMatchObject({ status: "completed", text: "error-text" });
      expect(await listInputRequests({ harness, sessionId: "s" })).toEqual([]);
    });
  });

  it("parks with the waits of an await_tasks call in the same step, and continues once all are over", async () => {
    await withTempDir(async (dir) => {
      const prompts: Prompt[] = [];
      const harness = createHarness({
        host: localHost({ dataDir: dir, sandbox: "in-process" }),
        model: scriptedModel([
          () => ({ calls: [{ toolName: "ask_person", input: { question: "Which customer?" } }] }),
          (prompt) => ({
            calls: [
              { toolName: "await_tasks", input: { taskIds: [(toolResults(prompt).call_1_1?.value as { taskId: string }).taskId], mode: "all" } },
              { toolName: "change", input: { to: ".05" } },
            ],
          }),
          (prompt) => {
            const results = toolResults(prompt);
            return { text: `${(results.call_2_1?.value as { status: string }).status}, ${results.call_2_2?.value}` };
          },
        ], prompts),
        tools: approvalTools([], { count: 0 }),
        humanInput: true,
        runtime: { bash: false },
      });
      const parked = await generateHarness({ harness, session: "s", prompt: "Go." });
      expect(parked).toMatchObject({ status: "parked", pending: { taskIds: [expect.any(String), expect.any(String)] } });

      await answer(harness, "s", /\.05/, "approve");
      expect(await resumeParked({ harness })).toEqual({ resumed: [], failed: [] });
      const [customer] = await listInputRequests({ harness, sessionId: "s" });
      await answerInputRequest({ harness, sessionId: "s", requestId: customer!.requestId, answer: { text: "ACME" } });
      const { resumed, failed } = await resumeParked({ harness });
      expect(failed).toEqual([]);
      expect(resumed).toHaveLength(1);
      expect(resumed[0]?.result).toMatchObject({ status: "completed", text: "satisfied, changed to .05" });
      expect(await resumeParked({ harness })).toEqual({ resumed: [], failed: [] });
    });
  });

  it("parks a streamed turn the same way, and continues it", async () => {
    await withTempDir(async (dir) => {
      const runs: Run[] = [];
      const harness = createHarness({
        host: localHost({ dataDir: dir, sandbox: "in-process" }),
        model: scriptedModel([
          () => ({ calls: [{ toolName: "change", input: { to: ".05" } }] }),
          (prompt) => ({ text: String(toolResults(prompt).call_1_1?.value) }),
        ]),
        tools: approvalTools(runs, { count: 0 }),
        humanInput: { tool: false },
        runtime: { bash: false },
      });
      const streaming = streamHarness({ harness, session: "s", prompt: "Lower the margin." });
      await streaming.text;
      expect(await streaming.finished).toMatchObject({ status: "parked" });
      await answer(harness, "s", /\.05/, "approve");
      const { resumed } = await resumeParked({ harness });
      expect(resumed[0]?.result).toMatchObject({ status: "completed", text: "changed to .05" });
      expect(runs).toHaveLength(2);
    });
  });
});
