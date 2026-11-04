import { renderAgentSource } from "@little-stack/harness/scaffold";

/** The starter workflow's id. It is also its Harness tool name, manifest key and folder name. */
export const STARTER_WORKFLOW = "starter_echo";

/** Both the headless CLI and Next import this server-neutral agent module. */
export function agentSource(provider: string, model: string, workflow: boolean): Record<string, string> {
  return {
    "agent.ts": `import { createHarness, localHost } from "@little-stack/harness";
${workflow ? 'import { loadWorkflow } from "@little-stack/workflow";\n' : ""}import { demoModel } from "./demo-model.ts";

// Keyless by default. Set LITTLE_DEMO=0 to call the live provider in live-model.ts (real calls and charges).
const model = process.env.LITTLE_DEMO === "0" ? (await import("./live-model.ts")).model : demoModel;

// The system prompt is instructions.md; tools/ is discovered next to this file.
export default createHarness({
  model,
  host: localHost(),
${workflow ? `  workflows: [
    await loadWorkflow(new URL("./workflows/${STARTER_WORKFLOW}", import.meta.url), { executionMode: "durable" }),
  ],
` : ""}});
`,
    "live-model.ts": liveModelSource(provider, model),
    "demo-model.ts": demoModelSource(workflow),
    ...(workflow ? { [`workflows/${STARTER_WORKFLOW}/workflow.ts`]: starterWorkflowSource() } : {}),
  };
}

/**
 * The provider module exports the live `model` only. It reuses the Harness scaffold's provider
 * rendering (imports, env checks, install comment) and drops the harness it wraps the model in.
 */
export function liveModelSource(provider: string, model: string): string {
  const agent = renderAgentSource({ provider, model });
  const harnessImport = 'import { createHarness, localHost } from "@little-stack/harness";\n';
  const harness = /export default createHarness\(\{\n {2}model: (.+),\n {2}system: .*\n {2}host: localHost\(\),\n\}\);\n$/u;
  const match = harness.exec(agent);
  if (!agent.startsWith(harnessImport) || match === null) {
    throw new Error(`Unexpected Harness agent template for provider '${provider}'.`);
  }
  return agent.slice(harnessImport.length, match.index) + `export const model = ${match[1]};\n`;
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
          controller.enqueue({ type: "tool-call", toolCallId: "demo", toolName: "${STARTER_WORKFLOW}", input: JSON.stringify({ value: "hello" }) });
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

/** The starter workflow: a fixed plan, so it runs durably without a model or a key. */
export function starterWorkflowSource(): string {
  return `import { defineWorkflow } from "@little-stack/workflow";
import { tool } from "ai";
import { z } from "zod";

const input = z.object({ value: z.string() });

export default defineWorkflow({
  id: "${STARTER_WORKFLOW}",
  description: "Echo a value through a durable, keyless workflow.",
  input,
  tools: {
    echo: tool({
      description: "Return the value it was given.",
      inputSchema: input,
      execute: async ({ value }) => ({ echoed: value }),
    }),
  },
  // A fixed plan runs as written, with no model. Replace it with \`model\` to let a planner draft the steps.
  plan: {
    steps: [
      {
        id: "echo",
        uses: "tool.call",
        with: { tool: "echo", args: { value: "{{ input.value }}" } },
        output: { mode: "json", schema: true },
      },
    ],
  },
});
`;
}

export function smokeSource(agents: string, workflow: boolean): string {
  return `import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHarness, localHost, streamHarness } from "@little-stack/harness";
${workflow ? 'import { loadWorkflow, localWorld } from "@little-stack/workflow";\n' : ""}
// Keyless even when LITTLE_DEMO=0 is exported: loadHarness reads it when it imports agent.ts.
process.env.LITTLE_DEMO = "1";
const agentDir = join(process.cwd(), ${JSON.stringify(`${agents}/support`)});
const dir = await mkdtemp(join(tmpdir(), "little-smoke-"));
try {
  const harness = await loadHarness(agentDir, { host: localHost({ dataDir: join(dir, "harness") }) });
  const result = streamHarness({ harness, messages: [{ id: "smoke", role: "user", parts: [{ type: "text", text: "hello" }] }] });
  const body = await result.toUIMessageStreamResponse().text();
  await result.finished;
  assert.match(body, /Hello from Little/);
${workflow ? `  assert.match(body, /${STARTER_WORKFLOW}/);
  const workflow = await loadWorkflow(join(agentDir, "workflows/${STARTER_WORKFLOW}"));
  const run = await workflow.run({ value: "hello" }, { world: localWorld({ dataDir: join(dir, "workflow") }) });
  assert.equal(run.status, "completed");
  assert.deepEqual(run.output, { echoed: "hello" });
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
import * as nodeModule from "node:module";
import { join } from "node:path";
import type { Harness, StreamHarnessOptions } from "@little-stack/harness";

// Native Node loading keeps filesystem/native runtime packages out of Next's bundle
// without rewriting the application's config. Run from the project root.
// Binding first prevents webpack from replacing this native runtime loader.
const requirePackage = nodeModule.createRequire.bind(nodeModule)(join(process.cwd(), "package.json"));
const { loadHarness, streamHarness } = requirePackage("@little-stack/harness") as typeof import("@little-stack/harness");
let ready: Promise<Harness> | undefined;

export function getAgent(): Promise<Harness> {
  ready ??= loadHarness(join(process.cwd(), ${JSON.stringify(agents)}, "support")).catch((error: unknown) => {
    ready = undefined;
    throw error;
  });
  return ready;
}

// Single-process LOCAL filesystem persistence. Production needs authenticated
// users, rate limits, durable storage and an appropriate execution host.
export async function streamAgent(options: Omit<StreamHarnessOptions, "harness">) {
  return streamHarness({ ...options, harness: await getAgent() });
}
`,
    [`${app}/${route}/route.ts`]: `import { randomUUID } from "node:crypto";
import { z } from "zod";
import { streamAgent } from "${upRoute}agents/server";

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
  const result = await streamAgent({
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
