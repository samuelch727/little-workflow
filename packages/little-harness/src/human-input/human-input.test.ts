import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createHarness } from "../create-harness.js";
import { harnessToolContext } from "../connectors/tool-context.js";
import { generateHarness } from "../execution/generate-harness.js";
import { resumeParked } from "../execution/resume-parked.js";
import { streamHarness } from "../execution/stream-harness.js";
import { localHost } from "../local-host/index.js";
import { withTempDir } from "../test/temp.js";
import { answerInputRequest, listInputRequests } from "./answers.js";
import type { HumanInputRequest } from "./types.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

type Prompt = ReadonlyArray<{ role: string; content: unknown }>;
type Step = (prompt: Prompt) => { call: { toolName: string; input: unknown } } | { text: string };

/** A model that plays the given steps in order, one per model call, whatever turn it is in. */
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
          content: [{
            type: "tool-call" as const,
            toolCallId: `call_${index}`,
            toolName: next.call.toolName,
            input: JSON.stringify(next.call.input),
          }],
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

/** The latest result of a tool, read from the prompt the model was sent. */
function lastToolResult(prompt: Prompt, toolName: string): any {
  const results = prompt.flatMap((message) =>
    message.role === "tool" && Array.isArray(message.content)
      ? (message.content as Array<{ type: string; toolName: string; output: { value: unknown } }>)
          .filter((part) => part.type === "tool-result" && part.toolName === toolName)
          .map((part) => part.output.value)
      : []
  );
  return results.at(-1);
}

const question = {
  question: "Approve a $5,000 overdraft for APP-1?",
  options: [{ id: "approve", label: "Approve" }, { id: "decline", label: "Decline" }],
  to: "underwriter",
};
const askThenWait: Step[] = [
  () => ({ call: { toolName: "ask_person", input: question } }),
  (prompt) => ({ call: { toolName: "await_tasks", input: { taskIds: [lastToolResult(prompt, "ask_person").taskId], mode: "all" } } }),
];

describe("asking a person", () => {
  it("asks without waiting, parks on await_tasks, and continues with the answer", async () => {
    await withTempDir(async (dir) => {
      const delivered: HumanInputRequest[] = [];
      const prompts: Prompt[] = [];
      const harness = createHarness({
        host: localHost({ dataDir: dir, sandbox: "in-process" }),
        model: scriptedModel([
          ...askThenWait,
          (prompt) => {
            const waited = lastToolResult(prompt, "await_tasks");
            return { text: `${waited.status}: ${waited.tasks[0].answer.option} by ${waited.tasks[0].answeredBy}` };
          },
        ], prompts),
        humanInput: { deliver: (request) => { delivered.push(request); } },
        runtime: { bash: false },
      });

      const parked = await generateHarness({ harness, session: "loan_APP-1", prompt: "Review APP-1." });
      expect(parked.status).toBe("parked");
      expect(lastToolResult(prompts[1]!, "ask_person")).toEqual({ status: "asked", taskId: expect.stringMatching(/^task_/) });
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({ ...question, sessionId: "loan_APP-1" });

      const waiting = await listInputRequests({ harness });
      expect(waiting).toHaveLength(1);
      expect(waiting[0]).toMatchObject({ ...question, status: "waiting", requestId: delivered[0]!.requestId });

      // Nothing to continue until the person answers.
      expect(await resumeParked({ harness })).toEqual({ resumed: [], failed: [] });

      const answer = { harness, sessionId: "loan_APP-1", requestId: delivered[0]!.requestId };
      await expect(answerInputRequest({ ...answer, answer: { option: "maybe" } })).rejects.toThrow(/option must be one of approve, decline/);
      await expect(answerInputRequest({ ...answer, answer: { text: "fine" } })).rejects.toThrow(/pick one of/);
      const answered = await answerInputRequest({ ...answer, answer: { option: "approve" }, answeredBy: "Dana" });
      expect(answered).toMatchObject({ status: "answered", answer: { option: "approve" }, answeredBy: "Dana" });
      await expect(answerInputRequest({ ...answer, answer: { option: "decline" } })).rejects.toThrow(/already has an answer/);
      expect(await listInputRequests({ harness })).toEqual([]);

      const continued = await resumeParked({ harness });
      expect(continued.failed).toEqual([]);
      expect(continued.resumed).toHaveLength(1);
      expect(continued.resumed[0]).toMatchObject({
        sessionId: "loan_APP-1",
        reason: "predicate_satisfied",
        result: { status: "completed", text: "satisfied: approve by Dana" },
      });
      // The continued turn picks up where the first one stopped: same conversation, one model call.
      expect(prompts).toHaveLength(3);
      expect(prompts[2]!.filter((message) => message.role === "user")).toHaveLength(1);

      expect(await resumeParked({ harness })).toEqual({ resumed: [], failed: [] });
      expect(delivered).toHaveLength(1);
    });
  });

  it("continues a turn that parked while streaming", async () => {
    await withTempDir(async (dir) => {
      const harness = createHarness({
        host: localHost({ dataDir: dir, sandbox: "in-process" }),
        model: scriptedModel([
          ...askThenWait,
          (prompt) => ({ text: lastToolResult(prompt, "await_tasks").tasks[0].answer.option }),
        ]),
        humanInput: true,
        runtime: { bash: false },
      });
      const streaming = streamHarness({ harness, session: "s", prompt: "Review APP-1." });
      await streaming.text;
      expect(await streaming.finished).toMatchObject({ status: "parked" });

      const [request] = await listInputRequests({ harness, sessionId: "s" });
      await answerInputRequest({ harness, sessionId: "s", requestId: request!.requestId, answer: { option: "decline" } });
      const { resumed } = await resumeParked({ harness, sessionId: "s" });
      expect(resumed[0]?.result).toMatchObject({ status: "completed", text: "decline" });
    });
  });

  it("continues with timed_out when the answer does not come in time", async () => {
    await withTempDir(async (dir) => {
      const harness = createHarness({
        host: localHost({ dataDir: dir, sandbox: "in-process" }),
        model: scriptedModel([
          askThenWait[0]!,
          (prompt) => ({
            call: {
              toolName: "await_tasks",
              input: { taskIds: [lastToolResult(prompt, "ask_person").taskId], mode: "all", maxWaitMs: 1 },
            },
          }),
          (prompt) => {
            const waited = lastToolResult(prompt, "await_tasks");
            return { text: `${waited.status}, still pending: ${waited.pending.taskIds.length}` };
          },
        ]),
        humanInput: true,
        runtime: { bash: false },
      });
      await generateHarness({ harness, session: "s", prompt: "Review APP-1." });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const { resumed } = await resumeParked({ harness });
      expect(resumed[0]).toMatchObject({ reason: "timeout", result: { status: "completed", text: "timed_out, still pending: 1" } });
      // The question still stands; a late answer is recorded for the next time the agent looks.
      expect(await listInputRequests({ harness })).toHaveLength(1);
    });
  });

  it("finishes recording an answer when the process stopped before the question's task closed", async () => {
    await withTempDir(async (dir) => {
      const harness = createHarness({
        host: localHost({ dataDir: dir, sandbox: "in-process" }),
        model: scriptedModel([
          ...askThenWait,
          (prompt) => {
            const waited = lastToolResult(prompt, "await_tasks");
            return { text: `${waited.tasks[0].answer.option} by ${waited.tasks[0].answeredBy}` };
          },
        ]),
        humanInput: true,
        runtime: { bash: false },
      });
      await generateHarness({ harness, session: "s", prompt: "Review APP-1." });
      const [request] = await listInputRequests({ harness });
      const answer = { harness, sessionId: "s", requestId: request!.requestId };

      // The answer is stored, then the process stops before the task is completed.
      vi.spyOn(harness.config.host.durable!.tasks, "updateTaskTerminal").mockRejectedValueOnce(new Error("process stopped"));
      await expect(answerInputRequest({ ...answer, answer: { option: "approve" }, answeredBy: "Dana" })).rejects.toThrow(/process stopped/);
      expect(await listInputRequests({ harness })).toHaveLength(1);

      await expect(answerInputRequest({ ...answer, answer: { option: "decline" } })).rejects.toThrow(/already has an answer/);
      expect(await answerInputRequest({ ...answer, answer: { option: "approve" }, answeredBy: "Dana" })).toMatchObject({
        status: "answered",
        answer: { option: "approve" },
        answeredBy: "Dana",
      });
      expect(await listInputRequests({ harness })).toEqual([]);
      const { resumed } = await resumeParked({ harness });
      expect(resumed[0]?.result).toMatchObject({ status: "completed", text: "approve by Dana" });
    });
  });

  it("tries a turn that keeps failing a few times, waiting longer each time, then drops it", async () => {
    await withTempDir(async (dir) => {
      let notes = 0;
      const writeNote = tool({
        description: "Write a note.",
        inputSchema: z.object({}),
        execute: async () => { notes += 1; return { ok: true }; },
      });
      // Each try of the continued turn writes a note, then its next model call fails.
      const failingTry: Step[] = [
        () => ({ call: { toolName: "write_note", input: {} } }),
        () => { throw new Error("The model is down."); },
      ];
      const harness = createHarness({
        host: localHost({ dataDir: dir, sandbox: "in-process" }),
        model: scriptedModel([...askThenWait, ...failingTry, ...failingTry, ...failingTry]),
        tools: { write_note: writeNote },
        humanInput: true,
        runtime: { bash: false },
      });
      await generateHarness({ harness, session: "s", prompt: "Review APP-1." });
      const [request] = await listInputRequests({ harness });
      await answerInputRequest({ harness, sessionId: "s", requestId: request!.requestId, answer: { option: "approve" } });

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const resume = () => resumeParked({ harness, maxAttempts: 3 });
        expect((await resume()).failed).toMatchObject([{ willRetry: true, attempts: 1, error: { message: expect.stringMatching(/model is down/) } }]);
        expect(notes).toBe(1);
        // Not tried again until the retry delay passes.
        expect(await resume()).toEqual({ resumed: [], failed: [] });
        vi.setSystemTime(Date.now() + 15_000);
        expect((await resume()).failed).toMatchObject([{ willRetry: true, attempts: 2 }]);
        expect(notes).toBe(2);
        // The delay doubles.
        vi.setSystemTime(Date.now() + 29_000);
        expect(await resume()).toEqual({ resumed: [], failed: [] });
        vi.setSystemTime(Date.now() + 1_000);
        expect((await resume()).failed).toMatchObject([{ willRetry: false, attempts: 3 }]);
        expect(notes).toBe(3);
        // Dropped: never tried again.
        vi.setSystemTime(Date.now() + 3_600_000);
        expect(await resume()).toEqual({ resumed: [], failed: [] });
        expect(await harness.config.host.durable!.resumeQueue.listOpen()).toEqual([]);
        expect(notes).toBe(3);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("tells the agent when sending the question failed", async () => {
    await withTempDir(async (dir) => {
      const prompts: Prompt[] = [];
      const harness = createHarness({
        host: localHost({ dataDir: dir, sandbox: "in-process" }),
        model: scriptedModel([askThenWait[0]!, () => ({ text: "noted" })], prompts),
        humanInput: { deliver: () => { throw new Error("Slack is down"); } },
        runtime: { bash: false },
      });
      await generateHarness({ harness, session: "s", prompt: "Review APP-1." });
      expect(lastToolResult(prompts[1]!, "ask_person")).toMatchObject({
        status: "asked",
        delivery: "failed",
        message: "The question is recorded, but sending it failed: Slack is down",
      });
      expect(await listInputRequests({ harness })).toHaveLength(1);
    });
  });

  it("lets a tool ask through its context and read the answer when it runs again", async () => {
    await withTempDir(async (dir) => {
      const sent: string[] = [];
      const sendEmail = tool({
        description: "Send an email to the applicant.",
        inputSchema: z.object({ to: z.string(), subject: z.string() }),
        execute: async (input, options) => {
          const approval = await harnessToolContext(options).ask!({
            question: `Send "${input.subject}" to ${input.to}?`,
            options: [{ id: "send", label: "Send" }, { id: "hold", label: "Hold" }],
          });
          if (approval.status === "waiting") return { status: "waiting_for_approval", taskId: approval.taskId };
          if (approval.answer?.option !== "send") return { status: "held" };
          sent.push(input.subject);
          return { status: "sent" };
        },
      });
      const email = { toolName: "send_email", input: { to: "ana@example.com", subject: "Your pre-approval" } };
      const prompts: Prompt[] = [];
      const harness = createHarness({
        host: localHost({ dataDir: dir, sandbox: "in-process" }),
        model: scriptedModel([
          () => ({ call: email }),
          (prompt) => ({ call: { toolName: "await_tasks", input: { taskIds: [lastToolResult(prompt, "send_email").taskId], mode: "all" } } }),
          () => ({ call: email }),
          (prompt) => ({ text: lastToolResult(prompt, "send_email").status }),
        ], prompts),
        tools: { send_email: sendEmail },
        humanInput: { tool: false },
        runtime: { bash: false },
      });

      await generateHarness({ harness, session: "s", prompt: "Email APP-1's applicant." });
      expect(prompts[0]).toBeDefined();
      const [request] = await listInputRequests({ harness });
      expect(request).toMatchObject({ question: 'Send "Your pre-approval" to ana@example.com?', status: "waiting" });
      await answerInputRequest({ harness, sessionId: "s", requestId: request!.requestId, answer: { option: "send" } });

      const { resumed } = await resumeParked({ harness });
      expect(resumed[0]?.result).toMatchObject({ status: "completed", text: "sent" });
      expect(sent).toEqual(["Your pre-approval"]);
    });
  });

  it("checks a structured answer against the question's schema", async () => {
    await withTempDir(async (dir) => {
      const harness = createHarness({
        host: localHost({ dataDir: dir, sandbox: "in-process" }),
        model: scriptedModel([
          () => ({
            call: {
              toolName: "ask_person",
              input: {
                question: "What limit should APP-1 get?",
                answerSchema: { type: "object", properties: { limit: { type: "number", minimum: 0 } }, required: ["limit"] },
              },
            },
          }),
          () => ({ text: "asked" }),
        ]),
        humanInput: true,
        runtime: { bash: false },
      });
      await generateHarness({ harness, session: "s", prompt: "Set a limit." });
      const [request] = await listInputRequests({ harness });
      const answer = { harness, sessionId: "s", requestId: request!.requestId };
      await expect(answerInputRequest({ ...answer, answer: { text: "5000" } })).rejects.toThrow(/value is required/);
      await expect(answerInputRequest({ ...answer, answer: { value: { limit: -1 } } })).rejects.toThrow(/limit/);
      expect(await answerInputRequest({ ...answer, answer: { value: { limit: 5000 } } })).toMatchObject({
        status: "answered",
        answer: { value: { limit: 5000 } },
      });
    });
  });

  it("refuses a tool name that is already taken", () => {
    expect(() => createHarness({
      host: localHost({ dataDir: "/tmp/unused", sandbox: "in-process" }),
      model: scriptedModel([]),
      tools: { ask_person: tool({ description: "x", inputSchema: z.object({}), execute: async () => ({}) }) },
      humanInput: true,
    })).toThrow(/humanInput toolName/);
  });
});
