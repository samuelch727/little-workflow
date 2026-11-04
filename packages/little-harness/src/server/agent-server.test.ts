import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { harnessToolContext } from "../connectors/tool-context.js";
import { createHarness } from "../create-harness.js";
import { answerInputRequest, listInputRequests } from "../human-input/answers.js";
import { localHost } from "../local-host/index.js";
import type { HarnessToolExecutionContext } from "../types.js";
import { withTempDir } from "../test/temp.js";
import type { Harness, HarnessTurnContext } from "../types.js";
import type { HarnessOutcomeEvent } from "../outcomes/types.js";
import { startAgentServer, type AgentServerOptions } from "./agent-server.js";
import { callerResumes } from "./caller-resumes.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const descriptorPath = resolve("src/connectors/descriptors.ts");
const schedulePath = resolve("src/schedules/schedule.ts");

type Reply =
  | { call: { toolName: string; input: unknown } }
  | { calls: ReadonlyArray<{ toolName: string; input: unknown }> }
  | { text: string };

/** A model that answers from the conversation so far; streams too, for the web connector. */
function model(reply: (prompt: ReadonlyArray<{ role: string; content: unknown }>) => Reply) {
  let calls = 0;
  const respond = (prompt: unknown) => {
    calls += 1;
    const next = reply(prompt as ReadonlyArray<{ role: string; content: unknown }>);
    if ("text" in next) {
      return { content: [{ type: "text" as const, text: next.text }], finishReason: { unified: "stop" as const, raw: "stop" } };
    }
    const toolCalls = "call" in next
      ? [{ id: `call_${calls}`, ...next.call }]
      : next.calls.map((call, position) => ({ id: `call_${calls}_${position + 1}`, ...call }));
    return {
      content: toolCalls.map((call) => ({
        type: "tool-call" as const,
        toolCallId: call.id,
        toolName: call.toolName,
        input: JSON.stringify(call.input),
      })),
      finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
    };
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

function toolResult(prompt: ReadonlyArray<{ role: string; content: unknown }>, toolName: string): any {
  return prompt
    .flatMap((message) => (message.role === "tool" ? (message.content as Array<{ toolName: string; output: { value: unknown } }>) : []))
    .filter((part) => part.toolName === toolName)
    .map((part) => part.output.value)
    .at(-1);
}

async function withServer(
  setup: { harness: (dataDir: string) => Harness; files?: Record<string, string> } & Partial<AgentServerOptions>,
  run: (server: Awaited<ReturnType<typeof startAgentServer>>, logs: string[]) => Promise<void>,
): Promise<void> {
  await withTempDir(async (dir) => {
    const agentDir = join(dir, "agents", "loan-officer");
    await mkdir(agentDir, { recursive: true });
    for (const [path, content] of Object.entries(setup.files ?? {})) {
      await mkdir(join(agentDir, path, ".."), { recursive: true });
      await writeFile(join(agentDir, path), content);
    }
    const logs: string[] = [];
    const harness = setup.harness(join(dir, "data"));
    const server = await startAgentServer({
      agentDir,
      agentName: "loan-officer",
      port: 0,
      dataDir: join(dir, "cli-data"),
      log: (line) => logs.push(line),
      loadHarness: async () => harness,
      ...(setup.hostname === undefined ? {} : { hostname: setup.hostname }),
      ...(setup.token === undefined ? {} : { token: setup.token }),
      ...(setup.parseExtraBody === undefined ? {} : { parseExtraBody: setup.parseExtraBody }),
      ...(setup.resume === undefined ? {} : { resume: setup.resume }),
      ...(setup.outcomes === undefined ? {} : { outcomes: setup.outcomes }),
    });
    try {
      await run(server, logs);
    } finally {
      await server.close();
    }
  });
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

/** A request with any headers, Host included, as a browser or a DNS-rebound page would send. */
function rawRequest(url: string, options: { method?: string; headers?: Record<string, string>; body?: string }): Promise<number> {
  return new Promise((resolve, reject) => {
    const sent = request(url, { method: options.method ?? "GET", headers: options.headers ?? {} }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    sent.on("error", reject);
    sent.end(options.body);
  });
}

describe("agent server", () => {
  it("serves messages, Input Type jobs, and lists what it runs", async () => {
    const triggers: unknown[] = [];
    await withServer({
      harness: (dataDir) => createHarness({
        host: localHost({ dataDir, sandbox: "in-process" }),
        model: model((prompt) => ({ text: `got ${JSON.stringify(prompt.at(-1)?.content)}` })),
        inputTypes: { preapproval: { description: "Pre-approve an application." } },
        runtime: { bash: false },
        onEvent: (event) => {
          if (event.type === "harness.session.started") triggers.push(event.metadata);
        },
      }),
      files: {
        "schedules/morning.ts": `import { defineSchedule } from ${JSON.stringify(schedulePath)};\nexport default defineSchedule({ cron: "0 9 * * *", timezone: "UTC", description: "Morning backlog", prompt: "Work the backlog." });\n`,
      },
    }, async (server) => {
      const info = await (await fetch(server.url)).json();
      expect(info).toMatchObject({
        connectors: [],
        inputTypes: ["preapproval"],
        schedules: [{ id: "morning", cron: "0 9 * * *", timezone: "UTC" }],
        humanInput: false,
      });

      const message = await post(`${server.url}/sessions/s1/messages`, { prompt: "Hello." });
      expect(await message.json()).toEqual({ status: "completed", sessionId: "s1", text: 'got [{"type":"text","text":"Hello."}]', turnId: expect.stringMatching(/^turn_/) });

      const job = await post(`${server.url}/jobs/preapproval`, { input: { applicationId: "APP-1" }, session: "job-1" });
      expect(await job.json()).toMatchObject({ status: "completed", sessionId: "job-1" });

      const run = await post(`${server.url}/schedules/morning/run`, {});
      expect(await run.json()).toMatchObject({ id: "morning", status: "completed", text: 'got [{"type":"text","text":"Work the backlog."}]' });

      expect((await post(`${server.url}/sessions/s1/messages`, {})).status).toBe(400);
      expect((await post(`${server.url}/sessions/%E0%A4%A/messages`, { prompt: "Hi." })).status).toBe(400);
      expect((await fetch(`${server.url}/nowhere`)).status).toBe(404);

      // Each turn says how it started.
      expect(triggers).toEqual([
        { triggerKind: "api", triggerSource: "POST /sessions/<session>/messages" },
        { triggerKind: "api", triggerSource: "POST /jobs/preapproval" },
        { triggerKind: "schedule", triggerSource: "morning", triggerLabel: "Morning backlog" },
      ]);
    });
  });

  it("takes a person's answer and continues the turn that waited for it", async () => {
    await withServer({
      harness: (dataDir) => createHarness({
        host: localHost({ dataDir, sandbox: "in-process" }),
        model: model((prompt) => {
          const asked = toolResult(prompt, "ask_person");
          const waited = toolResult(prompt, "await_tasks");
          if (waited?.status === "satisfied") return { text: `underwriter said ${waited.tasks[0].answer.option}` };
          if (asked !== undefined) return { call: { toolName: "await_tasks", input: { taskIds: [asked.taskId], mode: "all" } } };
          return { call: { toolName: "ask_person", input: { question: "Approve APP-1?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] } } };
        }),
        humanInput: true,
        runtime: { bash: false },
      }),
    }, async (server, logs) => {
      expect(await (await post(`${server.url}/sessions/app-1/messages`, { prompt: "Review APP-1." })).json()).toMatchObject({ status: "parked" });
      const [question] = await (await fetch(`${server.url}/questions`)).json();
      expect(question).toMatchObject({ question: "Approve APP-1?", sessionId: "app-1", status: "waiting" });

      const bad = await post(`${server.url}/sessions/app-1/questions/${question.requestId}/answer`, { option: "maybe" });
      expect(bad.status).toBe(400);
      const answered = await post(`${server.url}/sessions/app-1/questions/${question.requestId}/answer`, { option: "yes", answeredBy: "Dana" });
      expect(await answered.json()).toMatchObject({ status: "answered", answer: { option: "yes" }, answeredBy: "Dana" });

      await server.tick();
      expect(logs).toContain("[resume] session app-1 completed: underwriter said yes");
    });
  });

  it("serves the agent's connectors", async () => {
    await withServer({
      harness: (dataDir) => createHarness({
        host: localHost({ dataDir, sandbox: "in-process" }),
        model: model(() => ({ text: "hello from the web" })),
        runtime: { bash: false },
      }),
      files: {
        "connectors/web/connector.ts": `import { webRichConnector } from ${JSON.stringify(descriptorPath)};
export default webRichConnector({ authenticate: async () => ({ id: "u1" }), session: ({ body, user }) => user.id + ":" + body.id });\n`,
      },
    }, async (server) => {
      // Connectors take cross-origin requests: a web chat on another site posts to them.
      const response = await post(`${server.url}/connectors/web`, {
        id: "chat_1",
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Hi" }] }],
      }, { origin: "https://app.example", "sec-fetch-site": "cross-site" });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("hello from the web");
    });
  });

  it("asks for the token when one is set, and needs one to listen on a public address", async () => {
    const harness = (dataDir: string) => createHarness({
      host: localHost({ dataDir, sandbox: "in-process" }),
      model: model(() => ({ text: "ok" })),
      runtime: { bash: false },
    });
    await withServer({ harness, token: "secret" }, async (server) => {
      expect((await fetch(server.url)).status).toBe(401);
      expect((await fetch(server.url, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
      expect((await fetch(server.url, { headers: { authorization: "Bearer secret" } })).status).toBe(200);
    });
    await expect(withServer({ harness, hostname: "0.0.0.0" }, async () => {})).rejects.toThrow(
      /Set a token \(--token or LITTLE_HARNESS_TOKEN\) to listen on 0\.0\.0\.0/,
    );
    await withServer({ harness, hostname: "0.0.0.0", token: "secret" }, async (server) => {
      const local = server.url.replace("0.0.0.0", "127.0.0.1");
      expect((await fetch(local, { headers: { authorization: "Bearer secret" } })).status).toBe(200);
    });
    // A name is checked by the address it binds, not by how it reads.
    await withServer({ harness, hostname: "localhost" }, async (server) => {
      expect((await fetch(server.url)).status).toBe(200);
    });
  });

  it("without a token, answers only JSON requests to a loopback name that do not come from a web page", async () => {
    let turns = 0;
    const harness = (dataDir: string) => createHarness({
      host: localHost({ dataDir, sandbox: "in-process" }),
      model: model(() => {
        turns += 1;
        return { text: "ok" };
      }),
      runtime: { bash: false },
    });
    await withServer({ harness }, async (server) => {
      const port = new URL(server.url).port;
      const messages = `${server.url}/sessions/s1/messages`;
      const prompt = JSON.stringify({ prompt: "Hello." });

      // A page in the browser posting a simple, preflight-free request.
      expect(await rawRequest(messages, { method: "POST", headers: { "content-type": "text/plain" }, body: prompt })).toBe(415);
      expect(await rawRequest(messages, { method: "POST", body: prompt })).toBe(415);
      expect((await post(messages, { prompt: "Hello." }, { origin: "https://evil.example" })).status).toBe(403);
      expect((await fetch(server.url, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
      expect((await fetch(server.url, { headers: { "sec-fetch-site": "same-site" } })).status).toBe(403);
      // A page on a domain rebound to 127.0.0.1 sends its own name as the Host.
      expect(await rawRequest(server.url, { headers: { host: `evil.example:${port}` } })).toBe(403);
      expect(await rawRequest(server.url, { headers: { host: "localhost:1" } })).toBe(403);
      expect(turns).toBe(0);

      expect(await rawRequest(server.url, { headers: { host: `localhost:${port}` } })).toBe(200);
      expect(await rawRequest(server.url, { headers: { host: `[::1]:${port}` } })).toBe(200);
      expect((await post(messages, { prompt: "Hello." })).status).toBe(200);
      expect(turns).toBe(1);
    });
  });

  it("keeps continuing parked turns when checking the schedules fails", async () => {
    await withServer({
      harness: (dataDir) => {
        // A schedule state file that cannot be read makes every schedule check fail.
        mkdirSync(join(dataDir, "schedules", "loan-officer"), { recursive: true });
        writeFileSync(join(dataDir, "schedules", "loan-officer", "morning.json"), "not json");
        return createHarness({
          host: localHost({ dataDir, sandbox: "in-process" }),
          model: model((prompt) => {
            const asked = toolResult(prompt, "ask_person");
            const waited = toolResult(prompt, "await_tasks");
            if (waited?.status === "satisfied") return { text: `underwriter said ${waited.tasks[0].answer.option}` };
            if (asked !== undefined) return { call: { toolName: "await_tasks", input: { taskIds: [asked.taskId], mode: "all" } } };
            return { call: { toolName: "ask_person", input: { question: "Approve APP-1?", options: [{ id: "yes", label: "Yes" }] } } };
          }),
          humanInput: true,
          runtime: { bash: false },
        });
      },
      files: {
        "schedules/morning.ts": `import { defineSchedule } from ${JSON.stringify(schedulePath)};\nexport default defineSchedule({ cron: "0 9 * * *", timezone: "UTC", prompt: "Work the backlog." });\n`,
      },
    }, async (server, logs) => {
      expect(await (await post(`${server.url}/sessions/app-1/messages`, { prompt: "Review APP-1." })).json()).toMatchObject({ status: "parked" });
      // Answered outside the API, so only the timer's tick continues the turn.
      const [question] = await listInputRequests({ harness: server.harness });
      await answerInputRequest({ harness: server.harness, sessionId: "app-1", requestId: question!.requestId, answer: { option: "yes" } });

      await server.tick();
      expect(logs.some((line) => line.startsWith("[schedule] checking schedules failed:"))).toBe(true);
      expect(logs).toContain("[resume] session app-1 completed: underwriter said yes");
    });
  });
});

describe("agent server turns", () => {
  it("passes a request's extraBody to the turn's tools and its trigger to the turn, checked by parseExtraBody", async () => {
    const seen: unknown[] = [];
    const triggers: unknown[] = [];
    await withServer({
      harness: (dataDir) => createHarness({
        host: localHost({ dataDir, sandbox: "in-process" }),
        model: model((prompt) => (toolResult(prompt, "whoami") === undefined ? { call: { toolName: "whoami", input: {} } } : { text: "ok" })),
        tools: {
          whoami: tool({
            description: "Who is asking.",
            inputSchema: z.object({}),
            execute: async (_input, options) => {
              seen.push(harnessToolContext(options).extraBody);
              return "noted";
            },
          }),
        },
        runtime: { bash: false },
        onEvent: (event) => {
          if (event.type === "harness.session.started") triggers.push(event.metadata);
        },
      }),
      parseExtraBody: (value) => {
        if (!(typeof value === "object" && value !== null && "turnKey" in value)) throw new Error("no turnKey");
        return value;
      },
    }, async (server) => {
      const messages = `${server.url}/sessions/s-1/messages`;
      const reply = await post(messages, {
        prompt: "Hi",
        extraBody: { turnKey: "k1", who: "Dana" },
        trigger: { kind: "message", source: "littledb", from: "u_1" },
      });
      expect(await reply.json()).toMatchObject({ status: "completed", text: "ok" });
      expect(seen).toEqual([{ turnKey: "k1", who: "Dana" }]);
      expect(triggers[0]).toMatchObject({ triggerKind: "message", triggerSource: "littledb", triggerFrom: "u_1" });

      const refused = await post(messages, { prompt: "Hi", extraBody: { who: "Dana" } });
      expect(refused.status).toBe(400);
      expect((await refused.json()).error).toContain("no turnKey");
      // A request with no extraBody at all is checked too.
      const missing = await post(messages, { prompt: "Hi" });
      expect(missing.status).toBe(400);
      expect((await missing.json()).error).toContain("no turnKey");
      expect((await post(messages, { prompt: "Hi", trigger: { source: "x" } })).status).toBe(400);
    });
  });

  it("streams the UI message stream when asked", async () => {
    await withServer({
      harness: (dataDir) => createHarness({
        host: localHost({ dataDir, sandbox: "in-process" }),
        model: model(() => ({ text: "streamed hello" })),
        runtime: { bash: false },
      }),
    }, async (server) => {
      const reply = await post(`${server.url}/sessions/s-2/messages`, { prompt: "Hi" }, { accept: "text/event-stream" });
      expect(reply.status).toBe(200);
      expect(reply.headers.get("content-type")).toContain("text/event-stream");
      const body = await reply.text();
      expect(body).toContain("streamed hello");
      expect(body).toContain("[DONE]");
      // The reply has an id from its first chunk.
      expect(body).toMatch(/"type":"start","messageId":"msg_[0-9a-f-]{36}"/u);
      const viaQuery = await post(`${server.url}/sessions/s-2/messages?stream=1`, { prompt: "Again" });
      expect(viaQuery.headers.get("content-type")).toContain("text/event-stream");
      await viaQuery.text();
    });
  });

  it("stops a running turn", async () => {
    let started!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    await withServer({
      harness: (dataDir) => createHarness({
        host: localHost({ dataDir, sandbox: "in-process" }),
        model: model(() => ({ call: { toolName: "slow", input: {} } })),
        tools: {
          slow: tool({
            description: "Takes a while.",
            inputSchema: z.object({}),
            execute: (_input, { abortSignal }) =>
              new Promise((resolve, reject) => {
                started();
                const timer = setTimeout(() => resolve("late"), 10_000);
                abortSignal?.addEventListener("abort", () => {
                  clearTimeout(timer);
                  reject(abortSignal.reason);
                });
              }),
          }),
        },
        runtime: { bash: false },
      }),
    }, async (server) => {
      expect(await (await post(`${server.url}/sessions/idle/stop`, {})).json()).toEqual({ stopped: false });

      const running = post(`${server.url}/sessions/s-3/messages`, { prompt: "Go" });
      await toolStarted;
      expect(await (await post(`${server.url}/sessions/s-3/stop`, {})).json()).toEqual({ stopped: true });
      const reply = await running;
      expect(reply.status).toBe(200);
      expect(await reply.json()).toMatchObject({ status: "failed", sessionId: "s-3", reason: "Interrupted", error: "The turn was stopped." });
    });
  });

  it("reports a turn stopped by a limit as failed, with the reason", async () => {
    await withServer({
      harness: (dataDir) => createHarness({
        host: localHost({ dataDir, sandbox: "in-process" }),
        model: model(() => ({ call: { toolName: "quick", input: {} } })),
        tools: { quick: tool({ description: "Quick.", inputSchema: z.object({}), execute: async () => "done" }) },
        turnLimits: { maxSteps: 2 },
        runtime: { bash: false },
      }),
    }, async (server) => {
      const reply = await post(`${server.url}/sessions/s-4/messages`, { prompt: "Go" });
      expect(reply.status).toBe(200);
      expect(await reply.json()).toMatchObject({ status: "failed", reason: "StepLimitExceeded" });
    });
  });

  it("sends a turn's events to the sink it names, in order, retrying a failed batch, and a continued turn's too", async () => {
    const batches: Array<{ sessionId: string; deliveryId: string; events: Array<{ seq: number; type: string; [key: string]: unknown }> }> = [];
    const authorizations: (string | undefined)[] = [];
    let failNext = 1;
    const receiver = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        if (failNext > 0) {
          failNext -= 1;
          res.statusCode = 500;
          res.end();
          return;
        }
        authorizations.push(req.headers.authorization);
        batches.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    const sinkUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/events`;
    const events = () => batches.flatMap((batch) => batch.events);
    const waitFor = async (type: string, count = 1) => {
      for (let tries = 0; tries < 200 && events().filter((event) => event.type === type).length < count; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    try {
      await withServer({
        harness: (dataDir) => createHarness({
          host: localHost({ dataDir, sandbox: "in-process" }),
          model: model((prompt) => {
            const asked = toolResult(prompt, "ask_person");
            const waited = toolResult(prompt, "await_tasks");
            if (waited?.status === "satisfied") return { text: `underwriter said ${waited.tasks[0].answer.option}` };
            if (asked !== undefined) return { call: { toolName: "await_tasks", input: { taskIds: [asked.taskId], mode: "all" } } };
            if (JSON.stringify(prompt).includes("Approve")) {
              return { call: { toolName: "ask_person", input: { question: "Approve APP-1?", options: [{ id: "yes", label: "Yes" }] } } };
            }
            return { text: "hello there" };
          }),
          humanInput: true,
          runtime: { bash: false },
        }),
      }, async (server) => {
        const sink = { url: sinkUrl, headers: { authorization: "Bearer sink-secret" } };
        const reply = await post(`${server.url}/sessions/s-5/messages`, { prompt: "Hi", events: sink });
        expect(await reply.json()).toMatchObject({ status: "completed", text: "hello there" });
        await waitFor("turn.finished");
        const first = events();
        expect(first.map((event) => event.seq)).toEqual(first.map((_, index) => index + 1));
        expect(first.filter((event) => event.type === "text-delta").map((event) => event.text).join("")).toBe("hello there");
        expect(first.some((event) => event.type === "harness" && (event.event as { type: string }).type === "harness.session.started")).toBe(true);
        expect(first.at(-1)).toMatchObject({ type: "turn.finished", text: "hello there" });
        expect(authorizations.every((value) => value === "Bearer sink-secret")).toBe(true);

        // A turn that parks, then continues after its answer: the continued turn reports to the same sink.
        batches.length = 0;
        expect(await (await post(`${server.url}/sessions/s-6/messages`, { prompt: "Approve APP-1.", events: sink })).json()).toMatchObject({ status: "parked" });
        await waitFor("turn.parked");
        const [question] = await listInputRequests({ harness: server.harness });
        await post(`${server.url}/sessions/s-6/questions/${question!.requestId}/answer`, { option: "yes" });
        await waitFor("turn.finished");
        const types = events().map((event) => event.type);
        expect(types.indexOf("turn.parked")).toBeLessThan(types.indexOf("turn.resumed"));
        expect(events().at(-1)).toMatchObject({ type: "turn.finished", text: "underwriter said yes" });
        expect(new Set(batches.map((batch) => batch.sessionId))).toEqual(new Set(["s-6"]));
        // The continued turn is a new delivery, numbered from 1 again.
        expect(new Set(batches.map((batch) => batch.deliveryId)).size).toBe(2);
      });
    } finally {
      await new Promise<void>((resolve) => receiver.close(() => resolve()));
    }
  });

  it("reads a message staged mid-turn before the next step, refuses one with no turn running, and returns one staged too late", async () => {
    const prompts: string[] = [];
    let releaseAnswer!: () => void;
    const answerHeld = new Promise<void>((resolve) => {
      releaseAnswer = resolve;
    });
    let answering!: () => void;
    const answerStarted = new Promise<void>((resolve) => {
      answering = resolve;
    });
    let stage!: () => Promise<Response>;
    const scripted = new MockLanguageModelV3({
      doGenerate: async (options) => {
        prompts.push(JSON.stringify(options.prompt));
        if (prompts.length === 1) {
          return {
            content: [{ type: "tool-call" as const, toolCallId: "call_1", toolName: "look", input: "{}" }],
            finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
            usage,
            warnings: [],
          };
        }
        answering();
        await answerHeld;
        return { content: [{ type: "text" as const, text: "checked both" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
      },
    });
    await withServer({
      harness: (dataDir) => createHarness({
        host: localHost({ dataDir, sandbox: "in-process" }),
        model: scripted,
        tools: {
          look: tool({
            description: "Look.",
            inputSchema: z.object({}),
            execute: async () => {
              expect((await stage()).status).toBe(202);
              return "APP-1 is fine";
            },
          }),
        },
        runtime: { bash: false },
      }),
    }, async (server) => {
      const staged = `${server.url}/sessions/s-7/staged`;
      expect((await post(staged, { text: "Nothing is running." })).status).toBe(409);
      stage = () => post(staged, { text: "Also check APP-2." });
      const running = post(`${server.url}/sessions/s-7/messages`, { prompt: "Check APP-1." });
      await answerStarted;
      // Staged while the last step's model call runs: no step is left to read it.
      expect((await post(staged, { text: "And APP-3." })).status).toBe(202);
      releaseAnswer();
      expect(await (await running).json()).toMatchObject({ status: "completed", text: "checked both", unread: ["And APP-3."] });
      const second = prompts[1]!;
      expect(second).toContain("Also check APP-2.");
      expect(second.indexOf("APP-1 is fine")).toBeLessThan(second.indexOf("Also check APP-2."));
    });
  });
});

type ChangeRun = { readonly toolCallId: string; readonly extraBody: unknown };

/** A tool that changes the margin only once a person approves, waiting in its own call. */
function changeTool(runs: ChangeRun[], hold?: { gate?: Promise<void> }) {
  return tool({
    description: "Change the margin.",
    inputSchema: z.object({ to: z.string() }),
    execute: async ({ to }, options) => {
      const context = harnessToolContext(options) as HarnessToolExecutionContext;
      runs.push({ toolCallId: options.toolCallId, extraBody: context.extraBody });
      const asked = await context.ask!(
        { question: `Change the margin to ${to}?`, options: [{ id: "approve", label: "Approve" }, { id: "decline", label: "Decline" }] },
        { key: `card-${options.toolCallId}`, wait: true },
      );
      if (asked.status === "parked") return asked.output;
      await hold?.gate;
      return asked.answer?.option === "approve" ? `changed to ${to}` : "declined";
    },
  });
}

/** Records the event batches a sink receives. */
async function eventReceiver() {
  const batches: Array<{ deliveryId: string; events: Array<Record<string, unknown>> }> = [];
  const receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      batches.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const events = () => batches.flatMap((batch) => batch.events);
  return {
    url: `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/events`,
    events,
    async waitFor(type: string) {
      for (let tries = 0; tries < 200 && !events().some((event) => event.type === type); tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    close: () => new Promise<void>((resolve) => receiver.close(() => resolve())),
  };
}

/** Starts agent servers one after another on the same agent and data dirs, as a restart does. */
async function withRestarts(
  harness: (dataDir: string) => Harness,
  run: (context: { start: () => ReturnType<typeof startAgentServer>; dataDir: string }) => Promise<void>,
): Promise<void> {
  await withTempDir(async (dir) => {
    const agentDir = join(dir, "agents", "littledb");
    await mkdir(agentDir, { recursive: true });
    const dataDir = join(dir, "data");
    await run({
      dataDir,
      start: () => startAgentServer({
        agentDir,
        agentName: "littledb",
        port: 0,
        dataDir: join(dir, "cli-data"),
        log: () => undefined,
        loadHarness: async () => harness(dataDir),
        resume: "caller",
      }),
    });
  });
}

const get = async (url: string) => (await fetch(url)).json();

describe("agent server, caller-driven resume", () => {
  const margin = (runs: ChangeRun[], hold?: { gate?: Promise<void> }) => (dataDir: string) => createHarness({
    host: localHost({ dataDir, sandbox: "in-process" }),
    model: model((prompt) => {
      const changed = toolResult(prompt, "change");
      return changed === undefined ? { call: { toolName: "change", input: { to: ".05" } } } : { text: `result: ${changed}` };
    }),
    tools: { change: changeTool(runs, hold) },
    humanInput: { tool: false },
    runtime: { bash: false },
  });

  it("parks a waiting tool, takes the answer by key, and continues only through the resume route, once per resumeId", async () => {
    const runs: ChangeRun[] = [];
    let release!: () => void;
    const hold = { gate: new Promise<void>((resolve) => { release = resolve; }) };
    const sink = await eventReceiver();
    try {
      await withServer({ harness: margin(runs, hold), resume: "caller" }, async (server) => {
        const session = `${server.url}/sessions/s`;
        const parked = await (await post(`${session}/messages`, { prompt: "Lower the margin.", extraBody: { key: "k1" } })).json();
        expect(parked).toMatchObject({ status: "parked" });
        expect(await get(`${session}/turn`)).toMatchObject({ state: "parked", continuationId: parked.continuationId });

        const answer = { key: "card-call_1", option: "approve", answeredBy: "Dana" };
        expect((await post(`${session}/questions/answer`, answer)).status).toBe(200);
        expect((await post(`${session}/questions/answer`, answer)).status).toBe(200);
        expect((await post(`${session}/questions/answer`, { ...answer, option: "decline" })).status).toBe(400);

        // With resume: "caller", the timer never continues the turn.
        await server.tick();
        expect(runs).toHaveLength(1);

        const resume = { resumeId: "turn_1:2", extraBody: { key: "k2" }, events: { url: sink.url } };
        expect(await (await post(`${session}/resume`, resume)).json()).toEqual({ resumed: true, resumeId: "turn_1:2", status: "running" });
        expect(await get(`${session}/turn`)).toMatchObject({ state: "running", resumeId: "turn_1:2", resumeStatus: "running" });
        expect(await (await post(`${session}/resume`, resume)).json()).toEqual({ resumed: true, resumeId: "turn_1:2", status: "running" });
        expect(await (await post(`${session}/resume`, { ...resume, resumeId: "turn_1:3" })).json())
          .toEqual({ resumed: false, reason: "already-resumed", resumeId: "turn_1:2" });

        release();
        await sink.waitFor("turn.finished");
        expect(sink.events().find((event) => event.type === "turn.resumed")).toMatchObject({ resumeId: "turn_1:2" });
        expect(sink.events().find((event) => event.type === "turn.finished")).toMatchObject({ text: "result: changed to .05" });
        expect(runs).toEqual([
          { toolCallId: "call_1", extraBody: { key: "k1" } },
          { toolCallId: "call_1", extraBody: { key: "k2" } },
        ]);
        expect(await get(`${session}/turn`)).toEqual({ sessionId: "s", state: "idle", resumeId: "turn_1:2", resumeStatus: "finished", turnId: expect.any(String) });
        expect(await (await post(`${session}/resume`, resume)).json()).toEqual({ resumed: true, resumeId: "turn_1:2", status: "finished" });
        expect(await (await post(`${session}/resume`, { ...resume, resumeId: "turn_2:1" })).json())
          .toEqual({ resumed: false, reason: "not-parked" });
        expect(runs).toHaveLength(2);
      });
    } finally {
      await sink.close();
    }
  });

  it("continues a step with two waiting tools only once both are answered, running both again", async () => {
    const runs: ChangeRun[] = [];
    await withServer({
      harness: (dataDir) => createHarness({
        host: localHost({ dataDir, sandbox: "in-process" }),
        model: model((prompt) => {
          const changed = toolResult(prompt, "change");
          return changed === undefined
            ? { calls: [{ toolName: "change", input: { to: ".05" } }, { toolName: "change", input: { to: ".01" } }] }
            : { text: "done" };
        }),
        tools: { change: changeTool(runs) },
        humanInput: { tool: false },
        runtime: { bash: false },
      }),
      resume: "caller",
    }, async (server) => {
      const session = `${server.url}/sessions/s`;
      expect(await (await post(`${session}/messages`, { prompt: "Lower it twice." })).json()).toMatchObject({ status: "parked" });
      await post(`${session}/questions/answer`, { key: "card-call_1_1", option: "approve" });
      expect(await (await post(`${session}/resume`, { resumeId: "r1" })).json()).toEqual({ resumed: false, reason: "waiting" });
      await post(`${session}/questions/answer`, { key: "card-call_1_2", option: "decline" });
      expect(await (await post(`${session}/resume`, { resumeId: "r1" })).json()).toMatchObject({ resumed: true });
      for (let tries = 0; tries < 200 && (await get(`${session}/turn`)).state !== "idle"; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(await get(`${session}/turn`)).toMatchObject({ state: "idle", resumeStatus: "finished" });
      expect(runs.map((run) => run.toolCallId).sort()).toEqual(["call_1_1", "call_1_1", "call_1_2", "call_1_2"]);
    });
  });

  it("continues after restarts: while parked, between the answer and the resume, and during a resume", async () => {
    const runs: ChangeRun[] = [];
    await withRestarts(margin(runs), async ({ start, dataDir }) => {
      const until = async (url: string, state: string) => {
        for (let tries = 0; tries < 200 && (await get(url)).state !== state; tries += 1) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return get(url);
      };

      // Parked, then the process restarts; the answer and the resume go to the new one.
      let server = await start();
      await post(`${server.url}/sessions/a/messages`, { prompt: "Lower the margin." });
      await server.close();
      server = await start();
      await post(`${server.url}/sessions/a/questions/answer`, { key: "card-call_1", option: "approve" });
      // Answered, then the process restarts before the resume.
      await server.close();
      server = await start();
      expect(await (await post(`${server.url}/sessions/a/resume`, { resumeId: "a1" })).json()).toMatchObject({ resumed: true });
      expect(await until(`${server.url}/sessions/a/turn`, "idle")).toMatchObject({ resumeStatus: "finished" });

      // A resume claimed and recorded, then the process stopped before the turn ran.
      await post(`${server.url}/sessions/b/messages`, { prompt: "Lower the margin." });
      // A restarted server's model counts its calls from 1 again: this is its second.
      await post(`${server.url}/sessions/b/questions/answer`, { key: "card-call_2", option: "approve" });
      const durable = server.harness.config.host.durable!;
      const queued = (await durable.resumeQueue.claimNext("b"))!;
      await callerResumes(dataDir).save("b", {
        resumeId: "b1",
        continuationId: queued.continuationId,
        status: "running",
        queued,
        updatedAt: new Date().toISOString(),
      });
      await server.close();
      server = await start();
      expect(await get(`${server.url}/sessions/b/turn`)).toMatchObject({ state: "parked", resumeId: "b1", resumeStatus: "interrupted" });
      expect(await (await post(`${server.url}/sessions/b/resume`, { resumeId: "b1" })).json()).toMatchObject({ resumed: true });
      expect(await until(`${server.url}/sessions/b/turn`, "idle")).toMatchObject({ resumeStatus: "finished" });
      expect(await (await post(`${server.url}/sessions/b/resume`, { resumeId: "b1" })).json())
        .toEqual({ resumed: true, resumeId: "b1", status: "finished" });
      await server.close();

      // Each waiting call ran twice: when it parked, and once when its turn continued.
      expect(runs.map((run) => run.toolCallId)).toEqual(["call_1", "call_1", "call_2", "call_2"]);
    });
  });

  it("continues a resume that stopped right before or right after it claimed the turn", async () => {
    const runs: ChangeRun[] = [];
    await withRestarts(margin(runs), async ({ start }) => {
      for (const [sessionId, when] of [["c", "before"], ["d", "after"]] as const) {
        let server = await start();
        await post(`${server.url}/sessions/${sessionId}/messages`, { prompt: "Lower the margin." });
        await post(`${server.url}/sessions/${sessionId}/questions/answer`, { key: "card-call_1", option: "approve" });
        // The process stops at the claim: nothing after it runs.
        const queue = server.harness.config.host.durable!.resumeQueue;
        const claim = queue.claim!.bind(queue);
        queue.claim = async (resumeId) => {
          if (when === "after") await claim(resumeId);
          throw new Error("The process stopped.");
        };
        expect((await post(`${server.url}/sessions/${sessionId}/resume`, { resumeId: `${sessionId}1` })).status).toBe(500);
        await server.close();

        server = await start();
        expect(await get(`${server.url}/sessions/${sessionId}/turn`))
          .toMatchObject({ state: "parked", resumeId: `${sessionId}1`, resumeStatus: "interrupted" });
        expect(await (await post(`${server.url}/sessions/${sessionId}/resume`, { resumeId: `${sessionId}1` })).json())
          .toEqual({ resumed: true, resumeId: `${sessionId}1`, status: "running" });
        for (let tries = 0; tries < 200 && (await get(`${server.url}/sessions/${sessionId}/turn`)).state !== "idle"; tries += 1) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(await get(`${server.url}/sessions/${sessionId}/turn`)).toMatchObject({ state: "idle", resumeStatus: "finished" });
        await server.close();
      }
      // Each waiting call ran when it parked and once when its turn continued.
      expect(runs.map((run) => run.toolCallId)).toEqual(["call_1", "call_1", "call_1", "call_1"]);
    });
  });

  it("continues a resume a restart cut off without running again the calls it finished, the same arguments too", async () => {
    // The second pair has the same arguments: only each call's id tells its record apart.
    for (const [a, b] of [[".05", ".01"], [".05", ".05"]] as const) {
      const applied: string[] = [];
      let firstServer = true;
      let release!: () => void;
      const stuck = new Promise<void>((resolve) => { release = resolve; });
      const twoChanges = (dataDir: string) => {
        // In the first process the second change never finishes: the process stops while it runs.
        const hold = firstServer ? stuck : undefined;
        firstServer = false;
        return createHarness({
          host: localHost({ dataDir, sandbox: "in-process" }),
          model: model((prompt) => toolResult(prompt, "change") === undefined
            ? { calls: [{ toolName: "change", input: { to: a } }, { toolName: "change", input: { to: b } }] }
            : { text: "done" }),
          tools: {
            change: tool({
              description: "Change the margin.",
              inputSchema: z.object({ to: z.string() }),
              execute: async ({ to }, options) => {
                const context = harnessToolContext(options) as HarnessToolExecutionContext;
                const asked = await context.ask!(
                  { question: `Change the margin to ${to}?`, options: [{ id: "approve", label: "Approve" }] },
                  { key: `card-${options.toolCallId}`, wait: true },
                );
                if (asked.status === "parked") return asked.output;
                if (options.toolCallId === "call_1_2") await hold;
                applied.push(`${options.toolCallId} ${to}`);
                return `changed to ${to}`;
              },
            }),
          },
          humanInput: { tool: false },
          runtime: { bash: false },
        });
      };
      await withRestarts(twoChanges, async ({ start, dataDir }) => {
        const first = await start();
        const session = (server: { url: string }) => `${server.url}/sessions/e`;
        await post(`${session(first)}/messages`, { prompt: "Lower it twice." });
        await post(`${session(first)}/questions/answer`, { key: "card-call_1_1", option: "approve" });
        await post(`${session(first)}/questions/answer`, { key: "card-call_1_2", option: "approve" });
        expect(await (await post(`${session(first)}/resume`, { resumeId: "e1" })).json()).toMatchObject({ resumed: true });
        // The first change is done and recorded; the second still runs when the process stops.
        const logs = join(dataDir, "agent-server", "resume-runs");
        const recorded = async () => {
          const files = await readdir(logs).catch(() => []);
          return files.length === 1 && (await readFile(join(logs, files[0]!), "utf8")).includes("harness.tool_call.succeeded");
        };
        for (let tries = 0; tries < 200 && !(await recorded()); tries += 1) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(applied).toEqual([`call_1_1 ${a}`]);

        const second = await start();
        try {
          expect(await get(`${session(second)}/turn`)).toMatchObject({ state: "parked", resumeId: "e1", resumeStatus: "interrupted" });
          expect(await (await post(`${session(second)}/resume`, { resumeId: "e1" })).json()).toMatchObject({ resumed: true });
          for (let tries = 0; tries < 200 && (await get(`${session(second)}/turn`)).state !== "idle"; tries += 1) {
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          expect(await get(`${session(second)}/turn`)).toMatchObject({ state: "idle", resumeStatus: "finished" });
          // The finished change is replayed, not made again; the unfinished one runs again, with its own id.
          expect(applied).toEqual([`call_1_1 ${a}`, `call_1_2 ${b}`]);
          expect(await readdir(logs)).toEqual([]);
        } finally {
          await second.close();
          release();
          await first.close();
        }
      });
    }
  });

  it("ends a parked turn on stop and cancels the questions it waited on", async () => {
    await withServer({ harness: margin([]), resume: "caller" }, async (server) => {
      const session = `${server.url}/sessions/s`;
      await post(`${session}/messages`, { prompt: "Lower the margin." });
      expect(await (await post(`${session}/stop`, {})).json()).toEqual({ stopped: true });
      expect(await get(`${session}/turn`)).toEqual({ sessionId: "s", state: "idle", turnId: expect.stringMatching(/^turn_/) });
      expect(await listInputRequests({ harness: server.harness, sessionId: "s" })).toEqual([]);
      expect(await (await post(`${session}/resume`, { resumeId: "r1" })).json()).toEqual({ resumed: false, reason: "not-parked" });
      expect(await (await post(`${session}/stop`, {})).json()).toEqual({ stopped: false });
    });
  });
});

describe("agent server, which turn ran and how it went", () => {
  /** A model that answers as `name`, saying which version's system prompt it was sent. */
  const answerAs = (name: string) => model((prompt) => {
    const changed = toolResult(prompt, "change");
    if (changed === undefined) return { call: { toolName: "change", input: { to: ".05" } } };
    const system = prompt.filter((message) => message.role === "system").map((message) => String(message.content)).join("\n");
    return { text: `${name} model, ${/You are (v\d)\./u.exec(system)?.[1] ?? "no"} prompt, result: ${changed}` };
  });

  /**
   * A harness whose turnOptions hook decides the version live now, as a managed agent's does,
   * or the one a continued turn's pin names; it records what it decided.
   */
  const versioned = (live: { version: string }, decided: Array<{ version: string; resumed: boolean }>) => (dataDir: string) => createHarness({
    host: localHost({ dataDir, sandbox: "in-process" }),
    model: answerAs("default"),
    tools: { change: changeTool([]) },
    humanInput: { tool: false },
    runtime: { bash: false },
    turnOptions: (turn: HarnessTurnContext) => {
      const version = (turn.resumed?.pin as { version?: string } | undefined)?.version ?? live.version;
      decided.push({ version, resumed: turn.resumed !== undefined });
      return { model: answerAs(version), system: `You are ${version}.`, metadata: { littledb: { version } }, pin: { version } };
    },
  });

  it("names each turn and its version on the event that ends it and in GET /turn, and a parked turn keeps its version through a promotion and restarts", async () => {
    const live = { version: "v1" };
    const decided: Array<{ version: string; resumed: boolean }> = [];
    const sink = await eventReceiver();
    const until = async (url: string, state: string) => {
      for (let tries = 0; tries < 200 && (await get(url)).state !== state; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return get(url);
    };
    try {
      await withRestarts(versioned(live, decided), async ({ start, dataDir }) => {
        let server = await start();
        const parked = await (await post(`${server.url}/sessions/p/messages`, { prompt: "Lower the margin.", events: { url: sink.url } })).json();
        expect(parked).toMatchObject({ status: "parked", turnId: expect.any(String), metadata: { littledb: { version: "v1" } } });
        await sink.waitFor("turn.parked");
        expect(sink.events().find((event) => event.type === "turn.parked")).toMatchObject({ turnId: parked.turnId, metadata: { littledb: { version: "v1" } } });
        // Each Harness event of the turn carries the same turnId.
        expect(sink.events().find((event) => event.type === "harness")).toMatchObject({ event: { turnId: parked.turnId } });

        // Version 2 goes live while the turn waits, and the process restarts.
        await server.close();
        live.version = "v2";
        server = await start();
        expect(await get(`${server.url}/sessions/p/turn`)).toMatchObject({ state: "parked", turnId: parked.turnId, metadata: { littledb: { version: "v1" } } });

        await post(`${server.url}/sessions/p/questions/answer`, { key: "card-call_1", option: "approve" });
        expect(await (await post(`${server.url}/sessions/p/resume`, { resumeId: "p1", events: { url: sink.url } })).json()).toMatchObject({ resumed: true });
        await sink.waitFor("turn.finished");
        const finished = sink.events().find((event) => event.type === "turn.finished")!;
        // Version 1's model and prompt ran the rest of its turn, and the turn says version 1.
        expect(finished).toMatchObject({ text: "v1 model, v1 prompt, result: changed to .05", metadata: { littledb: { version: "v1" } } });
        expect(finished.turnId).not.toBe(parked.turnId);
        expect(await until(`${server.url}/sessions/p/turn`, "idle")).toMatchObject({ turnId: finished.turnId, metadata: { littledb: { version: "v1" } } });

        // A new turn runs version 2.
        expect(await (await post(`${server.url}/sessions/p/messages`, { prompt: "And again." })).json())
          .toMatchObject({ status: "completed", text: "v2 model, v2 prompt, result: changed to .05", metadata: { littledb: { version: "v2" } } });

        // A continued turn the process stopped after its resume was claimed and recorded: retried
        // with the same resumeId after a restart and another promotion, it still runs its version.
        await post(`${server.url}/sessions/q/messages`, { prompt: "Lower the margin." });
        await post(`${server.url}/sessions/q/questions/answer`, { key: "card-call_1", option: "approve" });
        const queued = (await server.harness.config.host.durable!.resumeQueue.claimNext("q"))!;
        await callerResumes(dataDir).save("q", { resumeId: "q1", continuationId: queued.continuationId, status: "running", queued, updatedAt: new Date().toISOString() });
        await server.close();
        live.version = "v3";
        server = await start();
        expect(await (await post(`${server.url}/sessions/q/resume`, { resumeId: "q1", events: { url: sink.url } })).json()).toMatchObject({ resumed: true });
        expect(await until(`${server.url}/sessions/q/turn`, "idle")).toMatchObject({ resumeStatus: "finished", metadata: { littledb: { version: "v2" } } });
        await sink.waitFor("turn.finished");
        for (let tries = 0; tries < 200 && sink.events().filter((event) => event.type === "turn.finished").length < 2; tries += 1) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(sink.events().filter((event) => event.type === "turn.finished").at(-1))
          .toMatchObject({ text: "v2 model, v2 prompt, result: changed to .05", metadata: { littledb: { version: "v2" } } });
        await server.close();

        // The hook decided from the pin each time a parked turn continued, and resolved otherwise.
        expect(decided).toEqual([
          { version: "v1", resumed: false },
          { version: "v1", resumed: true },
          { version: "v2", resumed: false },
          { version: "v2", resumed: false },
          { version: "v2", resumed: true },
        ]);
      });
    } finally {
      await sink.close();
    }
  });

  it("records a caller's outcome for a turn and hands it to the sinks, and has no route without them", async () => {
    const delivered: HarnessOutcomeEvent[] = [];
    let down = false;
    const sink = {
      name: "littledb",
      deliver: (event: HarnessOutcomeEvent) => {
        if (down) throw new Error("LittleDB is down.");
        delivered.push(event);
        // The store holds a newer revision than 1 (G24).
        return event.revision === 1 ? { ok: true, stale: true } : { ok: true };
      },
    };
    const plain = (dataDir: string) => createHarness({
      host: localHost({ dataDir, sandbox: "in-process" }),
      model: model(() => ({ text: "Refunds over $200 need a manager." })),
      runtime: { bash: false },
    });
    await withServer({ harness: plain, outcomes: { sinks: [sink] } }, async (server) => {
      const session = `${server.url}/sessions/s`;
      const done = await (await post(`${session}/messages`, { prompt: "Can I refund $300?" })).json();
      expect(done).toMatchObject({ status: "completed", turnId: expect.any(String) });

      const thumb = { turnId: done.turnId, status: "failure", detail: "Wrong limit.", reporter: "anon_1", reportKey: "msg_1" };
      const reported = await post(`${session}/outcomes`, thumb);
      expect(reported.status).toBe(200);
      expect(await reported.json()).toMatchObject({ delivered: 1, stale: 0, failed: 0, eventId: expect.any(String) });
      expect(delivered[0]).toMatchObject({ sessionId: "s", turnId: done.turnId, status: "failure", detail: "Wrong limit.", reporter: "anon_1", reportKey: "msg_1", source: "agent-server" });

      // The same reportKey replaces the answer, and a retraction withdraws it.
      await post(`${session}/outcomes`, { turnId: done.turnId, status: "success", reportKey: "msg_1" });
      await post(`${session}/outcomes`, { turnId: done.turnId, status: "success", reportKey: "msg_1", retracted: true });
      expect(delivered.map((event) => [event.status, event.reportKey, event.retracted ?? false])).toEqual([
        ["failure", "msg_1", false],
        ["success", "msg_1", false],
        ["success", "msg_1", true],
      ]);

      // A sink whose store already holds something newer says so: a definite answer, not a 502.
      const late = await post(`${session}/outcomes`, { turnId: done.turnId, status: "failure", reportKey: "msg_2", revision: 1 });
      expect(late.status).toBe(200);
      expect(await late.json()).toMatchObject({ delivered: 1, stale: 1, failed: 0 });
      delivered.pop();

      // A sink that fails: 502, so the caller tries again.
      down = true;
      const failed = await post(`${session}/outcomes`, thumb);
      expect(failed.status).toBe(502);
      expect(await failed.json()).toMatchObject({ delivered: 0, failed: 1, error: expect.stringContaining("LittleDB is down.") });
      down = false;

      expect((await post(`${session}/outcomes`, { turnId: done.turnId, status: "meh" })).status).toBe(400);
      expect((await post(`${session}/outcomes`, { status: "success" })).status).toBe(400);
      expect((await post(`${session}/outcomes`, { turnId: done.turnId, status: "success", retracted: "yes" })).status).toBe(400);
      expect((await post(`${server.url}/sessions/nobody/outcomes`, thumb)).status).toBe(404);
      expect(delivered).toHaveLength(3);

      // A revision orders reports under one key, so it needs the key and is a whole number from 0.
      for (const revision of [-1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1]) {
        expect((await post(`${session}/outcomes`, { ...thumb, revision })).status).toBe(400);
      }
      expect((await post(`${session}/outcomes`, { turnId: done.turnId, status: "success", revision: 1 })).status).toBe(400);
      expect(delivered).toHaveLength(3);
      expect((await post(`${session}/outcomes`, { ...thumb, revision: 1_762_000_000_000 })).status).toBe(200);
      expect(delivered.at(-1)).toMatchObject({ reportKey: "msg_1", revision: 1_762_000_000_000 });
    });
    await withServer({ harness: plain }, async (server) => {
      expect((await post(`${server.url}/sessions/s/outcomes`, { turnId: "t", status: "success" })).status).toBe(404);
    });
  });
});
