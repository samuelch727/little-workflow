import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { UIMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness } from "../create-harness.js";
import { HarnessInputError } from "../errors.js";
import type { StreamHarnessFinished } from "../execution/result.js";
import { localHost } from "../local-host/index.js";
import { chatSdkConnector, webRichConnector } from "./descriptors.js";
import { loadConnectorToolExtensions } from "./discovery.js";
import { loadWebRichConnector } from "./index.js";
import {
  attachSessionConnector,
  listSessionConnectors,
} from "./session-registry.js";

const model = { modelId: "mock", specificationVersion: "v2", provider: "mock" } as any;
const descriptorPath = resolve(import.meta.dirname, "descriptors.ts");
const toolExtensionsPath = resolve(import.meta.dirname, "tool-extensions.ts");
const dirs: string[] = [];

const requestMessages: UIMessage[] = [
  { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] },
];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function harness() {
  return createHarness({ host: localHost(), model });
}

function harnessWithTools() {
  return createHarness({
    host: localHost(),
    model,
    tools: {
      showOrder: {
        description: "Base order tool.",
        inputSchema: {} as any,
        execute: async () => ({ ok: true }),
      },
    } as any,
  });
}

function jsonRequest(
  body: unknown,
  options: { signal?: AbortSignal; headers?: HeadersInit } = {},
): Request {
  return new Request("https://example.com/api/chat", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

function streamResult(text = "ok", finished: Promise<StreamHarnessFinished> = finishedResult()) {
  return {
    text: Promise.resolve(text),
    output: Promise.resolve(text),
    textStream: (async function* () {
      yield text;
    })(),
    toUIMessageStream: () => new ReadableStream(),
    toUIMessageStreamResponse: vi.fn(() => new Response(text)),
    finished,
  };
}

function finishedResult(): Promise<StreamHarnessFinished> {
  return Promise.resolve({
    session: {} as any,
    artifacts: [],
    trace: { id: "trace" },
    persistence: { status: "not-configured" },
    warnings: [],
    commitManual: async () => ({ status: "not-configured" }),
  } as any);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
}

async function tmpAgent() {
  const dir = await mkdtemp(join(tmpdir(), "lh-web-rich-"));
  dirs.push(dir);
  return join(dir, "agents", "support");
}

describe("loadWebRichConnector", () => {
  it("loads connector tool extensions for string connector ids and passes active connector context to streamHarness", async () => {
    const agent = await tmpAgent();
    await mkdir(join(agent, "connectors", "web", "tools"), { recursive: true });
    await writeFile(
      join(agent, "connectors", "web", "connector.ts"),
      `import { webRichConnector } from ${JSON.stringify(descriptorPath)};
       export default webRichConnector({
         authenticate: async () => ({ id: "u1" }),
         session: ({ body, user }) => user.id + ":active:" + body.id
       });`,
    );
    await writeFile(
      join(agent, "connectors", "web", "tools", "showOrder.ts"),
      `import { extendTool } from ${JSON.stringify(toolExtensionsPath)};
       export default extendTool({} as any, { description: "Web order tool." });`,
    );
    const calls: Array<{ connector: unknown; connectorTools: unknown }> = [];
    const loaded = await loadWebRichConnector({
      agentDir: agent,
      connector: "web",
      loadHarness: async () => harnessWithTools(),
      loadConnectorToolExtensions,
      streamHarness: (options) => {
        calls.push({ connector: options.connector, connectorTools: options.connectorTools });
        return streamResult();
      },
    });

    await loaded.POST(jsonRequest({ id: "chat_1", messages: requestMessages }));

    expect(calls[0]?.connector).toEqual({
      id: "web",
      kind: "web-rich",
      endpoint: {
        id: "u1:chat_1",
        platform: "web",
        threadId: "chat_1",
        userId: "u1",
      },
    });
    expect(calls[0]?.connectorTools).toMatchObject({
      showOrder: { description: "Web order tool." },
    });
  });

  it("passes the connector descriptor's toolPolicy to streamHarness", async () => {
    const agent = await tmpAgent();
    await mkdir(join(agent, "connectors", "web"), { recursive: true });
    await writeFile(
      join(agent, "connectors", "web", "connector.ts"),
      `import { webRichConnector } from ${JSON.stringify(descriptorPath)};
       export default webRichConnector({
         authenticate: async () => ({ id: "u1" }),
         session: ({ body, user }) => user.id + ":active:" + body.id,
         toolPolicy: { allow: ["render-dashboard"] }
       });`,
    );
    const calls: Array<{ toolPolicy: unknown }> = [];
    const loaded = await loadWebRichConnector({
      agentDir: agent,
      connector: "web",
      loadHarness: async () => harnessWithTools(),
      loadConnectorToolExtensions,
      streamHarness: (options) => {
        calls.push({ toolPolicy: options.toolPolicy });
        return streamResult();
      },
    });

    await loaded.POST(jsonRequest({ id: "chat_1", messages: requestMessages }));

    expect(calls[0]?.toolPolicy).toEqual({ allow: ["render-dashboard"] });
  });

  it("attaches the active web-rich endpoint in the session registry", async () => {
    const agent = await tmpAgent();
    await mkdir(join(agent, "connectors", "web"), { recursive: true });
    await writeFile(
      join(agent, "connectors", "web", "connector.ts"),
      `import { webRichConnector } from ${JSON.stringify(descriptorPath)};
       export default webRichConnector({
         authenticate: async () => ({ id: "u1" }),
         session: ({ body, user }) => user.id + ":active:" + body.id
       });`,
    );
    const loaded = await loadWebRichConnector({
      agentDir: agent,
      connector: "web",
      loadHarness: async () => harness(),
      streamHarness: () => streamResult(),
    });

    await loaded.POST(jsonRequest({ id: "chat_1", messages: requestMessages }));

    const session = await loaded.harness.sessions.get("u1:active:chat_1");
    expect(session).toBeDefined();
    expect(await listSessionConnectors(session!)).toMatchObject([
      {
        connectorId: "web",
        kind: "web-rich",
        delivery: "active",
        endpoint: {
          id: "u1:chat_1",
          platform: "web",
          threadId: "chat_1",
          userId: "u1",
        },
      },
    ]);
  });

  it("delivers final assistant text to registered mirror connector deliverers", async () => {
    const agent = await tmpAgent();
    await mkdir(join(agent, "connectors", "web"), { recursive: true });
    await writeFile(
      join(agent, "connectors", "web", "connector.ts"),
      `import { webRichConnector } from ${JSON.stringify(descriptorPath)};
       export default webRichConnector({
         authenticate: async () => ({ id: "u1" }),
         session: ({ body, user }) => user.id + ":mirror:" + body.id
       });`,
    );
    const deliver = vi.fn(async () => {});
    const loaded = await loadWebRichConnector({
      agentDir: agent,
      connector: "web",
      delivery: { deliverers: { slack: deliver } },
      loadHarness: async () => harness(),
      streamHarness: () => streamResult("mirrored web reply"),
    });
    const session = await loaded.harness.sessions.getOrCreate({ id: "u1:mirror:chat_1" });
    const mirror = await attachSessionConnector(session, {
      connectorId: "slack",
      kind: "chat-sdk",
      delivery: "mirror",
      endpoint: { id: "slack:T1", platform: "slack", threadId: "T1", userId: "slack:U1" },
    });

    await loaded.POST(jsonRequest({ id: "chat_1", messages: requestMessages }));
    for (let attempt = 0; attempt < 10 && deliver.mock.calls.length === 0; attempt += 1) {
      await flushPromises();
    }

    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      session: expect.objectContaining({ id: "u1:mirror:chat_1" }),
      sessionId: "u1:mirror:chat_1",
      text: "mirrored web reply",
      target: mirror,
      active: expect.objectContaining({ connectorId: "web", delivery: "active" }),
    }));
  });

  it("does not deliver mirrors when text resolves but finished rejects", async () => {
    const finished = deferred<StreamHarnessFinished>();
    const onError = vi.fn(async (_ctx: any) => {});
    const deliver = vi.fn(async () => {});
    const loaded = await loadWebRichConnector({
      agentDir: "agents/support",
      connectorId: "web",
      connector: webRichConnector({
        authenticate: async () => ({ id: "u1" }),
        session: ({ body, user }) => user.id + ":mirror:" + body.id,
        onError,
      }),
      delivery: { deliverers: { slack: deliver } },
      loadHarness: async () => harness(),
      loadConnectorToolExtensions: async (_agentDir, _connectorId, baseTools) => baseTools,
      streamHarness: () => streamResult("should not mirror", finished.promise),
    });
    const session = await loaded.harness.sessions.getOrCreate({ id: "u1:mirror:chat_1" });
    await attachSessionConnector(session, {
      connectorId: "slack",
      kind: "chat-sdk",
      delivery: "mirror",
      endpoint: { id: "slack:T1", platform: "slack", threadId: "T1", userId: "slack:U1" },
    });

    const response = await loaded.POST(jsonRequest({ id: "chat_1", messages: requestMessages }));
    await flushPromises();
    finished.reject(new Error("finished failed"));
    await flushPromises();

    expect(response.status).toBe(200);
    expect(deliver).not.toHaveBeenCalled();
    expect(onError.mock.calls.map(([ctx]) => ((ctx as any).error as Error).message)).toEqual([
      "finished failed",
    ]);
  });

  it("runs direct descriptor objects without connectorId and skips extension loading and session attachment", async () => {
    const calls: Array<{ connector: unknown; connectorTools: unknown }> = [];
    const loaded = await loadWebRichConnector({
      agentDir: "agents/support",
      connector: webRichConnector({
        authenticate: async () => ({ id: "u1" }),
        session: ({ body }) => body.id,
      }),
      loadHarness: async () => harness(),
      streamHarness: (options) => {
        calls.push({ connector: options.connector, connectorTools: options.connectorTools });
        return streamResult();
      },
    });

    await loaded.POST(jsonRequest({ id: "chat_1", messages: requestMessages }));

    expect(calls).toEqual([{ connector: undefined, connectorTools: undefined }]);
    await expect(loaded.harness.sessions.get("chat_1")).resolves.toBeUndefined();
  });

  it("resolves string connector ids, loads the harness, and rejects non-web-rich descriptors", async () => {
    const agent = await tmpAgent();
    await mkdir(join(agent, "connectors"), { recursive: true });
    await writeFile(
      join(agent, "connectors", "web.ts"),
      `import { webRichConnector } from ${JSON.stringify(descriptorPath)};
       export default webRichConnector({
         authenticate: async () => ({ id: "u1" }),
         session: ({ body, user }) => user.id + ":" + body.id
       });`,
    );
    await writeFile(
      join(agent, "connectors", "slack.ts"),
      `import { chatSdkConnector } from ${JSON.stringify(descriptorPath)};
       export default chatSdkConnector({
         userName: "support",
         adapter: { name: "slack", create: () => ({ name: "slack" }) },
         state: () => ({})
       });`,
    );

    await expect(
      loadWebRichConnector({
        agentDir: agent,
        connector: "web",
        loadHarness: async () => harness(),
        streamHarness: () => streamResult(),
      }),
    ).resolves.toMatchObject({ connectorId: "web" });

    await expect(
      loadWebRichConnector({
        agentDir: agent,
        connector: "slack",
        loadHarness: async () => harness(),
        streamHarness: () => streamResult(),
      }),
    ).rejects.toThrow(HarnessInputError);
  });

  it("validates request JSON and preserves bad-request and unauthorized statuses", async () => {
    const onError = vi.fn(async (_ctx: any) => {});
    const loaded = await loadWebRichConnector({
      agentDir: "agents/support",
      connector: webRichConnector({
        authenticate: async () => null,
        session: ({ body }) => body.id,
        onError,
      }),
      loadHarness: async () => harness(),
      streamHarness: () => streamResult(),
    });

    await expect(loaded.POST(new Request("https://example.com", { method: "POST", body: "{" }))).resolves.toMatchObject({
      status: 400,
    });
    await expect(loaded.POST(jsonRequest({ id: 123, messages: [] }))).resolves.toMatchObject({ status: 400 });
    await expect(loaded.POST(jsonRequest({ id: "chat_1", messages: requestMessages }))).resolves.toMatchObject({
      status: 401,
    });

    expect(onError).toHaveBeenCalledTimes(3);
    expect(onError.mock.calls.map(([ctx]) => (ctx as any).error)).toHaveLength(3);
  });

  it("uses request history by default, resolves session, extra body, and abort signal before returning the UI response", async () => {
    const abortController = new AbortController();
    const calls: Array<{
      session?: string;
      messages: UIMessage[] | undefined;
      extraBody: unknown;
      abortSignal: AbortSignal | undefined;
    }> = [];
    const loaded = await loadWebRichConnector({
      agentDir: "agents/support",
      connector: webRichConnector({
        authenticate: async () => ({ id: "u1", email: "sam@example.com" }),
        session: ({ body, user }) => `${user.id}:${body.id}`,
        extraBody: ({ body, user }) => ({ requestId: body.id, userId: user.id }),
      }),
      loadHarness: async () => harness(),
      streamHarness: (options) => {
        calls.push({
          session: options.session as string,
          messages: options.messages,
          extraBody: options.extraBody,
          abortSignal: options.abortSignal,
        });
        return streamResult("streamed");
      },
    });

    const request = jsonRequest({ id: "chat_1", messages: requestMessages }, { signal: abortController.signal });
    const response = await loaded.POST(request);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("streamed");
    expect(calls).toEqual([
      {
        session: "u1:chat_1",
        messages: requestMessages,
        extraBody: { requestId: "chat_1", userId: "u1" },
        abortSignal: request.signal,
      },
    ]);
  });

  it("lets authenticate read the request body while POST still parses and uses it", async () => {
    const authenticatedBodies: unknown[] = [];
    const calls: Array<{ session?: string; messages: UIMessage[] | undefined }> = [];
    const loaded = await loadWebRichConnector({
      agentDir: "agents/support",
      connector: webRichConnector({
        authenticate: async (request) => {
          const body = await request.json();
          authenticatedBodies.push(body);
          return { id: "u1" };
        },
        session: ({ body, user }) => `${user.id}:${body.id}`,
      }),
      loadHarness: async () => harness(),
      streamHarness: (options) => {
        calls.push({
          session: options.session as string,
          messages: options.messages,
        });
        return streamResult("streamed");
      },
    });

    const response = await loaded.POST(jsonRequest({ id: "chat_1", messages: requestMessages }));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("streamed");
    expect(authenticatedBodies).toEqual([{ id: "chat_1", messages: requestMessages }]);
    expect(calls).toEqual([{ session: "u1:chat_1", messages: requestMessages }]);
  });

  it("supports request, server, and function history policies", async () => {
    const calls: Array<UIMessage[] | undefined> = [];
    const serverMessages: UIMessage[] = [
      { id: "server_1", role: "user", parts: [{ type: "text", text: "loaded" }] },
    ];
    const functionMessages: UIMessage[] = [
      { id: "fn_1", role: "assistant", parts: [{ type: "text", text: "computed" }] },
    ];

    for (const history of [
      { source: "request" as const },
      { source: "server" as const, load: vi.fn(async () => serverMessages) },
      vi.fn(async () => functionMessages),
    ]) {
      const loaded = await loadWebRichConnector({
        agentDir: "agents/support",
        connector: webRichConnector({
          authenticate: async () => ({ id: "u1" }),
          session: ({ body }) => body.id,
          history,
        }),
        loadHarness: async () => harness(),
        streamHarness: (options) => {
          calls.push(options.messages);
          return streamResult();
        },
      });

      await loaded.POST(jsonRequest({ id: "chat_1", messages: requestMessages }));
    }

    expect(calls).toEqual([requestMessages, serverMessages, functionMessages]);
  });

  it("runs beforeRun before streaming and afterRun only after finished resolves without consuming the response stream", async () => {
    const finished = deferred<StreamHarnessFinished>();
    const events: string[] = [];
    const result = streamResult("ok", finished.promise);
    const beforeRun = vi.fn(async () => {
      events.push("before");
    });
    const afterRun = vi.fn(async () => {
      events.push("after");
    });
    const loaded = await loadWebRichConnector({
      agentDir: "agents/support",
      connector: webRichConnector({
        authenticate: async () => ({ id: "u1" }),
        session: ({ body }) => body.id,
        beforeRun,
        afterRun,
      }),
      loadHarness: async () => harness(),
      streamHarness: () => {
        events.push("stream");
        return result;
      },
    });

    const response = await loaded.POST(jsonRequest({ id: "chat_1", messages: requestMessages }));

    expect(response.status).toBe(200);
    expect(result.toUIMessageStreamResponse).toHaveBeenCalledOnce();
    expect(events).toEqual(["before", "stream"]);
    finished.resolve(await finishedResult());
    await flushPromises();
    expect(afterRun).toHaveBeenCalledOnce();
    expect(events).toEqual(["before", "stream", "after"]);
  });

  it("reports session, history, stream, and finished errors through onError with available context", async () => {
    const onError = vi.fn(async (_ctx: any) => {});
    const base = {
      authenticate: async () => ({ id: "u1" }),
      onError,
    };

    const sessionFailure = await loadWebRichConnector({
      agentDir: "agents/support",
      connector: webRichConnector({
        ...base,
        session: () => {
          throw new Error("session failed");
        },
      }),
      loadHarness: async () => harness(),
      streamHarness: () => streamResult(),
    });
    await expect(sessionFailure.POST(jsonRequest({ id: "chat_1", messages: requestMessages }))).resolves.toMatchObject({
      status: 500,
    });

    const historyFailure = await loadWebRichConnector({
      agentDir: "agents/support",
      connector: webRichConnector({
        ...base,
        session: ({ body }) => body.id,
        history: { source: "server", load: async () => {
          throw new Error("history failed");
        } },
      }),
      loadHarness: async () => harness(),
      streamHarness: () => streamResult(),
    });
    await expect(historyFailure.POST(jsonRequest({ id: "chat_1", messages: requestMessages }))).resolves.toMatchObject({
      status: 500,
    });

    const streamFailure = await loadWebRichConnector({
      agentDir: "agents/support",
      connector: webRichConnector({
        ...base,
        session: ({ body }) => body.id,
      }),
      loadHarness: async () => harness(),
      streamHarness: () => {
        throw new Error("stream failed");
      },
    });
    await expect(streamFailure.POST(jsonRequest({ id: "chat_1", messages: requestMessages }))).resolves.toMatchObject({
      status: 500,
    });

    const finishedFailure = deferred<StreamHarnessFinished>();
    const finishedLoaded = await loadWebRichConnector({
      agentDir: "agents/support",
      connector: webRichConnector({
        ...base,
        session: ({ body }) => body.id,
      }),
      loadHarness: async () => harness(),
      streamHarness: () => streamResult("ok", finishedFailure.promise),
    });
    await expect(finishedLoaded.POST(jsonRequest({ id: "chat_1", messages: requestMessages }))).resolves.toMatchObject({
      status: 200,
    });
    finishedFailure.reject(new Error("finished failed"));
    await flushPromises();

    expect(onError.mock.calls.map(([ctx]) => ((ctx as any).error as Error).message)).toEqual([
      "session failed",
      "history failed",
      "stream failed",
      "finished failed",
    ]);
    expect(onError.mock.calls.at(-1)?.[0]).toMatchObject({
      session: "chat_1",
      messages: requestMessages,
    });
  });

  it("exposes a close method for connector lifecycle symmetry", async () => {
    const loaded = await loadWebRichConnector({
      agentDir: "agents/support",
      connector: webRichConnector({
        authenticate: async () => ({ id: "u1" }),
        session: ({ body }) => body.id,
      }),
      loadHarness: async () => harness(),
      streamHarness: () => streamResult(),
    });

    await expect(loaded.close()).resolves.toBeUndefined();
  });

  it("registers afterRun and mirror-delivery tasks with waitUntil when provided", async () => {
    const tasks: Promise<unknown>[] = [];
    const waitUntil = vi.fn((task: Promise<unknown>) => {
      tasks.push(task);
    });
    const loaded = await loadWebRichConnector({
      agentDir: "agents/support",
      connectorId: "web",
      connector: webRichConnector({
        authenticate: async () => ({ id: "u1" }),
        session: ({ body, user }) => `${user.id}:mirror:${body.id}`,
      }),
      waitUntil,
      loadHarness: async () => harness(),
      loadConnectorToolExtensions: async (_agentDir, _connectorId, baseTools) => baseTools,
      streamHarness: () => streamResult(),
    });

    const response = await loaded.POST(jsonRequest({ id: "chat_1", messages: requestMessages }));

    expect(response.status).toBe(200);
    expect(waitUntil).toHaveBeenCalledTimes(2);
    await expect(Promise.all(tasks)).resolves.toBeDefined();
  });

  it("falls back to a mirror target's descriptor deliver for web-rich mirror delivery", async () => {
    const agent = await tmpAgent();
    await mkdir(join(agent, "connectors", "web"), { recursive: true });
    await writeFile(
      join(agent, "connectors", "web", "connector.ts"),
      `import { webRichConnector } from ${JSON.stringify(descriptorPath)};
       export default webRichConnector({
         authenticate: async () => ({ id: "u1" }),
         session: ({ body, user }) => user.id + ":mirror:" + body.id
       });`,
    );
    await mkdir(join(agent, "connectors", "slack"), { recursive: true });
    await writeFile(
      join(agent, "connectors", "slack", "connector.ts"),
      `import { chatSdkConnector } from ${JSON.stringify(descriptorPath)};
       export default chatSdkConnector({
         userName: "support",
         adapter: { name: "slack", create: () => ({ name: "slack" }) },
         state: () => ({}),
         deliver: async (ctx) => {
           globalThis.__wp1WebMirror.push({ text: ctx.text, target: ctx.target.connectorId });
         }
       });`,
    );
    (globalThis as any).__wp1WebMirror = [];
    const tasks: Promise<unknown>[] = [];
    const loaded = await loadWebRichConnector({
      agentDir: agent,
      connector: "web",
      waitUntil: (task) => {
        tasks.push(task);
      },
      loadHarness: async () => harness(),
      streamHarness: () => streamResult("mirrored web via descriptor"),
    });
    const session = await loaded.harness.sessions.getOrCreate({ id: "u1:mirror:chat_1" });
    await attachSessionConnector(session, {
      connectorId: "slack",
      kind: "chat-sdk",
      delivery: "mirror",
      endpoint: { id: "slack:T1", platform: "slack", threadId: "T1", userId: "slack:U1" },
    });

    await loaded.POST(jsonRequest({ id: "chat_1", messages: requestMessages }));
    await Promise.all(tasks);

    expect((globalThis as any).__wp1WebMirror).toEqual([
      { text: "mirrored web via descriptor", target: "slack" },
    ]);
    delete (globalThis as any).__wp1WebMirror;
  });

  it("exposes descriptor-provided connector tools even without a connectorId", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls: Array<{ connectorTools: any }> = [];
    try {
      const loaded = await loadWebRichConnector({
        agentDir: "agents/support",
        connector: webRichConnector({
          authenticate: async () => ({ id: "u1" }),
          session: ({ body }) => body.id,
          tools: {
            renderDashboard: {
              description: "Descriptor-provided tool.",
              inputSchema: {} as any,
              execute: async () => ({ ok: true }),
            },
          } as any,
        }),
        loadHarness: async () => harness(),
        streamHarness: (options) => {
          calls.push({ connectorTools: options.connectorTools });
          return streamResult();
        },
      });

      await loaded.POST(jsonRequest({ id: "chat_1", messages: requestMessages }));
    } finally {
      warn.mockRestore();
    }

    expect(calls[0]?.connectorTools).toMatchObject({
      renderDashboard: { description: "Descriptor-provided tool." },
    });
  });

  it("merges descriptor tools with folder extensions, letting folder extensions win per name", async () => {
    const agent = await tmpAgent();
    await mkdir(join(agent, "connectors", "web", "tools"), { recursive: true });
    await writeFile(
      join(agent, "connectors", "web", "connector.ts"),
      `import { webRichConnector } from ${JSON.stringify(descriptorPath)};
       export default webRichConnector({
         authenticate: async () => ({ id: "u1" }),
         session: ({ body, user }) => user.id + ":" + body.id
       });`,
    );
    await writeFile(
      join(agent, "connectors", "web", "tools", "showOrder.ts"),
      `import { extendTool } from ${JSON.stringify(toolExtensionsPath)};
       export default extendTool({} as any, { description: "Folder order tool." });`,
    );
    const calls: Array<{ connectorTools: any }> = [];

    const loaded = await loadWebRichConnector({
      agentDir: agent,
      connectorId: "web",
      connector: webRichConnector({
        authenticate: async () => ({ id: "u1" }),
        session: ({ body, user }) => `${user.id}:${body.id}`,
        tools: {
          showOrder: {
            description: "Descriptor order tool.",
            inputSchema: {} as any,
            execute: async () => ({ ok: true }),
          },
          descriptorOnly: {
            description: "Descriptor-only tool.",
            inputSchema: {} as any,
            execute: async () => ({ ok: true }),
          },
        } as any,
      }),
      loadHarness: async () => harnessWithTools(),
      loadConnectorToolExtensions,
      streamHarness: (options) => {
        calls.push({ connectorTools: options.connectorTools });
        return streamResult();
      },
    });

    await loaded.POST(jsonRequest({ id: "chat_1", messages: requestMessages }));

    expect(calls[0]?.connectorTools.showOrder.description).toBe("Folder order tool.");
    expect(calls[0]?.connectorTools.descriptorOnly.description).toBe("Descriptor-only tool.");
  });

  it("rejects descriptor-provided tools that claim a reserved name", async () => {
    await expect(
      loadWebRichConnector({
        agentDir: "agents/support",
        connectorId: "web",
        connector: webRichConnector({
          authenticate: async () => ({ id: "u1" }),
          session: ({ body }) => body.id,
          tools: {
            bash: {
              description: "Should be rejected.",
              inputSchema: {} as any,
              execute: async () => ({ ok: true }),
            },
          } as any,
        }),
        loadHarness: async () => harness(),
        loadConnectorToolExtensions: async (_agentDir, _connectorId, baseTools) => baseTools,
        streamHarness: () => streamResult(),
      }),
    ).rejects.toThrow(HarnessInputError);
  });

  it("tolerates a missing connector folder for a descriptor object with connectorId (npm/inline connector)", async () => {
    // A real agent dir with NO `connectors/` folder: an npm-distributed or inline descriptor carries
    // its tools programmatically, so a missing folder must resolve to {} extensions rather than
    // throwing "Connector not found." when connectorId is set.
    const agent = await tmpAgent();
    const calls: Array<{ connectorTools: any }> = [];
    const loaded = await loadWebRichConnector({
      agentDir: agent,
      connectorId: "web",
      connector: webRichConnector({
        authenticate: async () => ({ id: "u1" }),
        // Isolated session id so this connectorId-scoped run does not persist a shared "chat_1"
        // session into the on-disk store (which would leak into other tests).
        session: ({ body }) => `web:tolerant:${body.id}`,
        tools: {
          renderDashboard: {
            description: "Descriptor-provided tool.",
            inputSchema: {} as any,
            execute: async () => ({ ok: true }),
          },
        } as any,
      }),
      // Isolate the session store under the temp agent dir so the attachment is cleaned by afterEach.
      loadHarness: async () => createHarness({ host: localHost({ dataDir: join(agent, ".data") }), model }),
      loadConnectorToolExtensions,
      streamHarness: (options) => {
        calls.push({ connectorTools: options.connectorTools });
        return streamResult();
      },
    });

    await loaded.POST(jsonRequest({ id: "chat_1", messages: requestMessages }));

    expect(calls[0]?.connectorTools).toMatchObject({
      renderDashboard: { description: "Descriptor-provided tool." },
    });
  });

  it("loads a tools-only connector folder for a descriptor object with connectorId (no connector module)", async () => {
    // A `connectors/<id>/` folder that ships ONLY `tools/*` — no `connector.*` module, so discovery
    // finds no candidate and the string loader throws "Connector not found.". A descriptor object with
    // connectorId must still pick up those on-disk tools, and the folder wins per-name over descriptor.
    const agent = await tmpAgent();
    await mkdir(join(agent, "connectors", "web", "tools"), { recursive: true });
    await writeFile(
      join(agent, "connectors", "web", "tools", "show-order.ts"),
      `export default { description: "Folder tool.", execute: async () => ({ ok: true }) };`,
    );
    const calls: Array<{ connectorTools: any }> = [];

    const loaded = await loadWebRichConnector({
      agentDir: agent,
      connectorId: "web",
      connector: webRichConnector({
        authenticate: async () => ({ id: "u1" }),
        // Isolated session id so this connectorId-scoped run does not leak a shared session.
        session: ({ body }) => `web:tools-only:${body.id}`,
        tools: {
          "show-order": {
            description: "Descriptor tool.",
            inputSchema: {} as any,
            execute: async () => ({ ok: true }),
          },
          descriptorOnly: {
            description: "Descriptor-only tool.",
            inputSchema: {} as any,
            execute: async () => ({ ok: true }),
          },
        } as any,
      }),
      // Isolate the session store under the temp agent dir so the attachment is cleaned by afterEach.
      loadHarness: async () => createHarness({ host: localHost({ dataDir: join(agent, ".data") }), model }),
      loadConnectorToolExtensions,
      streamHarness: (options) => {
        calls.push({ connectorTools: options.connectorTools });
        return streamResult();
      },
    });

    await loaded.POST(jsonRequest({ id: "chat_1", messages: requestMessages }));

    // The folder tool is loaded even without a connector module; folder wins per-name over the
    // descriptor, and the descriptor-only tool is still merged in.
    expect(calls[0]?.connectorTools["show-order"].description).toBe("Folder tool.");
    expect(calls[0]?.connectorTools.descriptorOnly.description).toBe("Descriptor-only tool.");
  });

  it("keeps the hard error when a STRING connector ref's tool loader reports the connector as not found", async () => {
    // A string ref explicitly named a folder connector, so a "Connector not found." from the tool
    // loader must stay fatal (unlike the descriptor-object case above).
    const agent = await tmpAgent();
    await mkdir(join(agent, "connectors"), { recursive: true });
    await writeFile(
      join(agent, "connectors", "web.ts"),
      `import { webRichConnector } from ${JSON.stringify(descriptorPath)};
       export default webRichConnector({
         authenticate: async () => ({ id: "u1" }),
         session: ({ body }) => body.id
       });`,
    );

    await expect(
      loadWebRichConnector({
        agentDir: agent,
        connector: "web",
        loadHarness: async () => harness(),
        loadConnectorToolExtensions: async () => {
          throw new HarnessInputError("Connector not found.");
        },
        streamHarness: () => streamResult(),
      }),
    ).rejects.toThrow(/Connector not found/u);
  });

  it("warns when a web-rich descriptor object is loaded without connectorId", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await loadWebRichConnector({
        agentDir: "agents/support",
        connector: webRichConnector({
          authenticate: async () => ({ id: "u1" }),
          session: ({ body }) => body.id,
        }),
        loadHarness: async () => harness(),
        streamHarness: () => streamResult(),
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("connectorId");
    } finally {
      warn.mockRestore();
    }
  });

  it("logs a single-line default route error via console.error when the descriptor declares no onError", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const loaded = await loadWebRichConnector({
        agentDir: "agents/support",
        connector: webRichConnector({
          authenticate: async () => ({ id: "u1" }),
          session: ({ body }) => body.id,
        }),
        loadHarness: async () => harness(),
        streamHarness: () => {
          throw new Error("stream boom");
        },
      });

      const response = await loaded.POST(jsonRequest({ id: "chat_1", messages: requestMessages }));

      expect(response.status).toBe(500);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const line = String(errorSpy.mock.calls[0]?.[0]);
      expect(line).toContain("phase=run");
      expect(line).toContain("status=500");
      expect(line).toContain("stream boom");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does not log the default route error when the descriptor provides onError", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onError = vi.fn(async () => {});
    try {
      const loaded = await loadWebRichConnector({
        agentDir: "agents/support",
        connector: webRichConnector({
          authenticate: async () => ({ id: "u1" }),
          session: ({ body }) => body.id,
          onError,
        }),
        loadHarness: async () => harness(),
        streamHarness: () => {
          throw new Error("stream boom");
        },
      });

      await loaded.POST(jsonRequest({ id: "chat_1", messages: requestMessages }));

      expect(onError).toHaveBeenCalledTimes(1);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("includes the error message in the response body in dev and stays bodyless in production", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const makeLoaded = () =>
      loadWebRichConnector({
        agentDir: "agents/support",
        connector: webRichConnector({
          authenticate: async () => ({ id: "u1" }),
          session: ({ body }) => body.id,
        }),
        loadHarness: async () => harness(),
        streamHarness: () => {
          throw new Error("stream boom");
        },
      });
    const previous = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "development";
      const devResponse = await (await makeLoaded()).POST(
        jsonRequest({ id: "chat_1", messages: requestMessages }),
      );
      expect(devResponse.status).toBe(500);
      expect(await devResponse.text()).toContain("stream boom");

      process.env.NODE_ENV = "production";
      const prodResponse = await (await makeLoaded()).POST(
        jsonRequest({ id: "chat_1", messages: requestMessages }),
      );
      expect(prodResponse.status).toBe(500);
      expect(await prodResponse.text()).toBe("");
    } finally {
      process.env.NODE_ENV = previous;
      errorSpy.mockRestore();
    }
  });

  it("threads the uiMessageStream option through to streamHarness so mid-stream errors can be unmasked", async () => {
    const onError = (error: unknown) => `formatted: ${String(error)}`;
    const calls: Array<{ uiMessageStream: unknown }> = [];
    const loaded = await loadWebRichConnector({
      agentDir: "agents/support",
      connector: webRichConnector({
        authenticate: async () => ({ id: "u1" }),
        session: ({ body }) => body.id,
      }),
      uiMessageStream: { onError },
      loadHarness: async () => harness(),
      streamHarness: (options) => {
        calls.push({ uiMessageStream: options.uiMessageStream });
        return streamResult();
      },
    });

    await loaded.POST(jsonRequest({ id: "chat_1", messages: requestMessages }));

    expect(calls[0]?.uiMessageStream).toEqual({ onError });
  });
});
