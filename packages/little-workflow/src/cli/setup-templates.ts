import { renderAgentSource } from "little-harness/scaffold";

/** Both the headless CLI and Next import this server-neutral agent module. */
export function agentSource(provider: string, model: string, workflow: boolean): Record<string, string> {
  return {
    "agent.ts": `import { createHarness, localHost } from "little-harness";
import { demoModel } from "./demo-model.ts";
import echo from "./tools/echo.ts";
${workflow ? 'import { asHarnessWorkflow } from "little-workflow";\nimport workflow from "./workflows/echo/workflow.ts";\n' : ''}
// Explicit opt-in: LITTLE_DEMO=0 enables real provider calls and their charges.
const base = process.env.LITTLE_DEMO === "0"
  ? (await import("./live.ts")).default
  : createHarness({ model: demoModel, host: localHost(), system: "Help the user." });

export default createHarness({
  model: base.config.model,
  system: base.config.system,
  host: localHost(),
  tools: { echo },
${workflow ? `  workflows: [asHarnessWorkflow(workflow, {
    // Increment this identity when changing the workflow definition.
    definitionIdentity: "little-setup.echo@1",
    executionMode: "durable",
  })],\n` : ''}});
`,
    "live.ts": renderAgentSource({ provider, model }),
    "demo-model.ts": demoModelSource(workflow),
    ...(workflow ? { "workflows/echo/workflow.ts": keylessWorkflowSource() } : {}),
  };
}

function demoModelSource(workflow: boolean): string {
  return `import { MockLanguageModelV3 } from "ai/test";

// Deterministic AI SDK mock; no network, key, or billable model call.
const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};
export const demoModel = new MockLanguageModelV3({
  provider: "little-demo",
  modelId: "keyless",
  doStream: async (options) => ({
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
${workflow ? `        if (!options.prompt.some((message) => message.role === "tool")) {
          controller.enqueue({ type: "tool-call", toolCallId: "demo-echo", toolName: "starter_echo", input: JSON.stringify({ value: "hello" }) });
          controller.enqueue({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage });
          controller.close();
          return;
        }
` : ''}        controller.enqueue({ type: "text-start", id: "demo" });
        controller.enqueue({ type: "text-delta", id: "demo", delta: "Hello from Little.${workflow ? ' The durable echo workflow completed.' : ''}" });
        controller.enqueue({ type: "text-end", id: "demo" });
        controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
        controller.close();
      },
    }),
  }),
});
`;
}

/** Shared, deterministic workflow used by unified setup; no provider-dependent planning. */
export function keylessWorkflowSource(): string {
  return `import { defineWorkflow } from "little-workflow";
import { tool } from "ai";
import { z } from "zod";
import { demoModel } from "../../demo-model.ts";

export default defineWorkflow({
  id: "starter.echo",
  description: "Run a durable, keyless echo example.",
  model: demoModel,
  input: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
  tools: {
    echo: tool({
      description: "Return a deterministic starter response.",
      inputSchema: z.object({}),
      execute: async () => ({ ok: true, message: "Workflow completed without a model call." }),
    }),
  },
  planner: {
    model: demoModel,
    harness: {
      harnessId: "little-setup-echo@1",
      async run() {
        return {
          kind: "plan",
          lwir: {
            apiVersion: "littleworkflow.dev/v0.1",
            kind: "Workflow",
            metadata: { name: "starter.echo" },
            input: { schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } },
            output: { schema: true },
            permissions: { models: [], tools: ["echo"], secrets: [], network: [] },
            steps: [{ id: "echo", uses: "tool.call", with: { tool: "echo", args: {} }, output: { mode: "json", schema: true } }],
          },
        };
      },
    },
  },
});
`;
}

export function smokeSource(agents: string, workflow: boolean): string {
  return `import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, localHost, streamHarness } from "little-harness";

// Set BEFORE importing definitions, even if the developer enabled a live provider.
process.env.LITTLE_DEMO = "1";
const dir = await mkdtemp(join(tmpdir(), "little-smoke-"));
try {
  const { default: agent } = await import("../${agents}/support/agent.ts");
  const host = localHost({ dataDir: join(dir, "harness") });
  const harness = { ...agent, sessions: host.sessions, config: { ...agent.config, host } };
  const result = streamHarness({ harness, messages: [{ id: "smoke", role: "user", parts: [{ type: "text", text: "hello" }] }] });
  const body = await result.toUIMessageStreamResponse().text();
  await result.finished;
  assert.match(body, /Hello from Little/);
${workflow ? `  const { localWorld } = await import("little-workflow");
  const { default: workflow } = await import("../${agents}/support/workflows/echo/workflow.ts");
  const run = await workflow.run({ value: "hello" }, { world: localWorld({ dataDir: join(dir, "workflow") }) });
  assert.equal(run.status, "completed");
  assert.deepEqual(run.output, { ok: true, message: "Workflow completed without a model call." });
  assert.match(body, /starter_echo/);
` : ''}  console.log("Little keyless smoke passed${workflow ? ' (Harness + durable Workflow)' : ''}.");
} finally {
  await rm(dir, { recursive: true, force: true });
}
`;
}

export function nextFiles(app: string, agents: string, route: string, page: string): Record<string, string> {
  // agents is a sibling of app; relative imports also work with custom tsconfig aliases.
  const upRoute = "../".repeat(route.split("/").length + 1);
  return {
    [`${agents}/server.ts`]: `import "server-only";
import agent from "./support/agent.ts";

// A single-process LOCAL development store. Production needs authenticated users,
// durable storage, rate limits, and an appropriate execution host.
export function getAgent() {
  return agent;
}
`,
    [`${app}/${route}/route.ts`]: `import { randomUUID } from "node:crypto";
import { z } from "zod";
import { streamHarness } from "little-harness/execution";
import { getAgent } from "${upRoute}agents/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const bodySchema = z.object({
  messages: z.array(z.object({
    id: z.string().min(1).max(128),
    role: z.enum(["user", "assistant"]),
    parts: z.array(z.object({ type: z.literal("text"), text: z.string().max(10000) })).max(20),
  })).min(1).max(100),
});

export async function POST(request: Request) {
  // Local development only. Replace with SERVER-VERIFIED authentication before deployment.
  // Browser userId, chat id, and history are never authentication or authorization.
  if (process.env.NODE_ENV === "production" && process.env.LITTLE_DEMO !== "1") {
    return Response.json({ error: "Configure server-side authentication before enabling production chat." }, { status: 403 });
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return new Response(null, { status: 403 });
  let raw: unknown;
  try {
    const text = await request.text();
    if (text.length > 100000) return new Response(null, { status: 413 });
    raw = JSON.parse(text);
  } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
  const body = bodySchema.safeParse(raw);
  if (!body.success) return Response.json({ error: "Expected text messages" }, { status: 400 });
  const result = streamHarness({
    harness: getAgent(),
    messages: body.data.messages,
    // Every unauthenticated request gets a fresh server-chosen session.
    session: randomUUID(),
    abortSignal: request.signal,
  });
  return result.toUIMessageStreamResponse();
}
`,
    [`${app}/${page}/use-chat-ui.ts`]: `"use client";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useMemo } from "react";

// App-local UI hook over the public AI SDK useChat API.
export function useChatUI() {
  const transport = useMemo(() => new DefaultChatTransport({
    api: "/${route}",
    prepareSendMessagesRequest: ({ messages }) => ({ body: {
      messages: messages.map((message) => ({ ...message, parts: message.parts.filter((part) => part.type === "text") })),
    } }),
  }), []);
  return useChat({ transport });
}
`,
    [`${app}/${page}/page.tsx`]: `"use client";
import { useState } from "react";
import { useChatUI } from "./use-chat-ui";

export default function LittleChat() {
  const { messages, sendMessage, status, error } = useChatUI();
  const [text, setText] = useState("");
  const busy = status === "submitted" || status === "streaming";
  return <main style={{ maxWidth: 720, margin: "4rem auto", padding: 24, fontFamily: "system-ui" }}>
    <h1>Little chat</h1>
    <p>Keyless demo by default. Local development storage; configure authentication before deployment.</p>
    <div aria-live="polite">{messages.map((message) => <p key={message.id}>
      <strong>{message.role}: </strong>{message.parts.map((part, index) => part.type === "text" ? <span key={index}>{part.text}</span> : null)}
    </p>)}</div>
    {error && <p role="alert">{error.message}</p>}
    <form onSubmit={(event) => { event.preventDefault(); if (!text.trim() || busy) return; void sendMessage({ text }); setText(""); }}>
      <label htmlFor="message">Message </label>
      <input id="message" value={text} onChange={(event) => setText(event.target.value)} disabled={busy} />
      <button disabled={busy || !text.trim()}>Send</button>
    </form>
  </main>;
}
`,
  };
}
