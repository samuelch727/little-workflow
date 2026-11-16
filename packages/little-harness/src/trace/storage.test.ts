import { tool } from "ai";
import { z } from "zod";
import { MockLanguageModelV3 } from "ai/test";
import { InMemoryFs } from "just-bash";
import { describe, expect, it } from "vitest";
import { createHarness } from "../create-harness.js";
import { generateHarness } from "../execution/generate-harness.js";
import { localHost } from "../local-host/index.js";
import { virtualHost } from "../virtual-host/virtual-host.js";
import { withTempDir } from "../test/temp.js";
import { captureTraceContent } from "./content.js";
import { resolveTraceOptions } from "./options.js";
import { createEventedFileWriter } from "../execution/evented-file-writer.js";
import type { HarnessEvent } from "../types.js";
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

type Prompt = ReadonlyArray<{ role: string; content: unknown }>;

/** Runs each command with bash, one model call per command, then answers with the last output. */
function bashModel(commands: readonly string[]) {
  let calls = 0;
  return new MockLanguageModelV3({
    doGenerate: async ({ prompt }) => {
      const command = commands[calls];
      calls += 1;
      if (command !== undefined) {
        return {
          content: [{
            type: "tool-call" as const,
            toolCallId: `call_${calls}`,
            toolName: "bash",
            input: JSON.stringify({ command }),
          }],
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
          usage,
          warnings: [],
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(lastToolResult(prompt as Prompt, "bash")) }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage,
        warnings: [],
      };
    },
  });
}

function lastToolResult(prompt: Prompt, toolName: string): unknown {
  const results = prompt.flatMap((message) =>
    message.role === "tool" && Array.isArray(message.content)
      ? (message.content as Array<{ type: string; toolName: string; output: { value: unknown } }>)
          .filter((part) => part.type === "tool-result" && part.toolName === toolName)
          .map((part) => part.output.value)
      : [],
  );
  return results.at(-1);
}


describe("host-owned trace content", () => {
  it.each(["local", "virtual"] as const)("does not return 33 KiB command output as artifacts on %s", async kind => {
    await withTempDir(async dir => {
      for (const spooling of [undefined, false, { outputDir: "/session/custom-spools" }] as const) {
        const host = kind === "local" ? localHost({ dataDir: dir }) : virtualHost({ fs: new InMemoryFs() });
        const events: Omit<HarnessEvent, "timestamp" | "sessionId">[] = [];
        const id = `output-${String(spooling)}`;
        const harness = createHarness({ host, ...(spooling === undefined ? {} : { toolResultSpooling: spooling }), model: bashModel(["printf 'SECRET-LOOKING-OUTPUT %.0s' $(seq 1 1600)"]), onEvent: e => { events.push(e); } });
        const result = await generateHarness({ harness, session: id, prompt: "go" });
        expect(result.status).toBe("completed");
        expect(result.artifacts).toEqual([]);
        const refs = [...JSON.stringify(events).matchAll(/"contentRef":"([^" ]+)"/g)].map(match => match[1]!);
        expect(refs.length).toBeGreaterThan(0);
        for (const ref of refs) {
          expect(ref).toMatch(/^\/\.little-harness\/trace\//);
          expect((await result.session.traceContent!.read(ref)).text()).toBeTruthy();
        }
      }
      const host = kind === "local" ? localHost({ dataDir: dir }) : virtualHost({ fs: new InMemoryFs() });
      const harness = createHarness({ host, trace: false, model: bashModel(["printf 'SECRET-LOOKING-OUTPUT %.0s' $(seq 1 1600)"]) });
      const result = await generateHarness({ harness, session: "no-trace", prompt: "go" });
      expect(result.status).toBe("completed");
      expect(result.artifacts).toEqual([]);
    });
  });
  it.each(["local", "virtual"] as const)("keeps spills private and artifacts genuine on %s", async kind => {
    await withTempDir(async dir => {
      const fs = new InMemoryFs();
      const host = kind === "local" ? localHost({ dataDir: dir }) : virtualHost({ fs });
      const session = await host.sessions.getOrCreate({ id: "g9" });
      const events: Omit<HarnessEvent, "timestamp" | "sessionId">[] = [];
      const value = "SECRET-LOOKING-OUTPUT ".repeat(1600);
      const traceOptions = resolveTraceOptions(undefined, undefined);
      const ref = await captureTraceContent({ value, label: "output", files: session.files, traceOptions });
      expect(ref.contentRef).toMatch(/^\/\.little-harness\/trace\/output\//);
      expect((await session.traceContent!.read(ref.contentRef!)).text()).toBe(value);
      expect(await session.artifacts.list()).toEqual([]);
      await expect(session.files.read(ref.contentRef!)).rejects.toThrow();
      const reopened = await host.sessions.getOrCreate({ id: "g9" });
      expect((await reopened.traceContent!.read(ref.contentRef!)).text()).toBe(value);
      await expect(session.traceContent!.read("/.little-harness/trace/../../trace.ndjson")).rejects.toThrow();
      const evented = createEventedFileWriter(session.files, async e => { events.push(e); }, { traceOptions });
      await evented.writeText("/session/.tool-results/result.txt", value, { metadata: { spooledToolResult: true } });
      const spool = events.find(e => e.type === "harness.file.created");
      expect(spool?.metadata?.diff).toEqual({ available: false, reason: "harness_file" });
      expect(await session.artifacts.list()).toEqual([]);
      await session.files.writeText("/artifacts/user.txt", "user output");
      await session.files.writeText("/artifacts/trace/legacy.txt", "legacy output");
      expect((await session.traceContent!.read("/artifacts/trace/legacy.txt")).text()).toBe("legacy output");
      expect((await session.artifacts.list()).map(a => a.path)).toEqual(expect.arrayContaining(["/artifacts/user.txt", "/artifacts/trace/legacy.txt"]));
      const harness = createHarness({ host, model: bashModel(["ls /.little-harness; cat /session/.tool-results/result.txt | wc -c"])});
      const result = await generateHarness({ harness, session: "g9", prompt: "go" });
      expect(result.status).toBe("completed");
      if (result.status !== "completed") throw new Error(result.status);
      const output = JSON.parse(result.text);
      expect(output.stderr).toContain("No such file");
      expect(output.stdout).toContain(String(value.length));
    });
  });
});

it.each(["local", "virtual"] as const)("never exposes trace writes to a custom tool on %s", async kind => {
  await withTempDir(async dir => {
    let calls = 0;
    let checked = false;
    const value = "private trace result ".repeat(2000);
    const model = new MockLanguageModelV3({ doGenerate: async () => ({
      content: calls++ === 0 ? [{ type: "tool-call" as const, toolCallId: "check_1", toolName: "check", input: "{}" }] : [{ type: "text" as const, text: "done" }],
      finishReason: { unified: calls === 1 ? "tool-calls" as const : "stop" as const, raw: "stop" }, usage, warnings: [],
    }) });
    const harness = createHarness({
      host: kind === "local" ? localHost({ dataDir: dir }) : virtualHost({ fs: new InMemoryFs() }), model,
      runtime: { bash: false, python: false, javascript: false, toolBridge: false },
      tools: { check: tool({ inputSchema: z.object({}), execute: async (_input, ctx) => {
        const context = ctx as unknown as { files: import("../types.js").FileWriter; session: import("../types.js").HarnessSession };
        expect(context.files).not.toHaveProperty("traceContent");
        expect(context.session.files).not.toHaveProperty("traceContent");
        expect(context.session.traceContent).not.toHaveProperty("write");
        const ref = await captureTraceContent({ value, label: "tool-test", files: context.files, traceOptions: resolveTraceOptions(undefined, undefined) });
        expect(ref.contentRef).toMatch(/^\/\.little-harness\/trace\//);
        expect((await context.session.traceContent!.read(ref.contentRef!)).text()).toBe(value);
        checked = true;
        return "ok";
      } }) },
    });
    const result = await generateHarness({ harness, prompt: "check" });
    expect(checked).toBe(true);
    expect(result.artifacts).toEqual([]);
  });
});

it("value redaction changes trace only, not tool results, model input or authored files", async () => {
  await withTempDir(async dir => {
    const secret = 'literal"\\\nSECRET-LOOKING-OUTPUT';
    let calls = 0;
    let sawOriginal = false;
    const events: HarnessEvent[] = [];
    const model = new MockLanguageModelV3({ doGenerate: async ({ prompt }) => {
      if (calls++ === 0) return { content: [{ type: "tool-call" as const, toolCallId: "literal_1", toolName: "literal", input: "{}" }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
      sawOriginal = JSON.stringify(prompt).includes(JSON.stringify(secret).slice(1, -1));
      return { content: [{ type: "text" as const, text: secret }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
    } });
    const host = localHost({ dataDir: dir });
    const session = await host.sessions.getOrCreate({ id: "literal" });
    const harness = createHarness({ host, model,
      trace: { redaction: { values: [secret] }, content: { maxInlineBytes: 1 } },
      runtime: { bash: false, python: false, javascript: false, toolBridge: false },
      tools: { literal: tool({ inputSchema: z.object({}), execute: async () => {
        await session.files.writeText("/session/original.txt", secret);
        return { nested: secret };
      } }) },
    });
    const result = await generateHarness({ harness, session, prompt: "run literal", onEvent: event => { events.push(event); } });
    expect(sawOriginal).toBe(true);
    expect(result.status).toBe("completed");
    if (result.status === "completed") expect(result.text).toBe(secret);
    expect((await session.files.read("/session/original.txt")).text()).toBe(secret);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(JSON.stringify(secret).slice(1, -1));
    const refs = [...serialized.matchAll(/"contentRef":"([^"]+)"/g)].map(match => match[1]!);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const content = (await session.traceContent!.read(ref)).text();
      expect(content).not.toContain(secret);
      expect(content).not.toContain(JSON.stringify(secret).slice(1, -1));
    }
  });
});

it.each(["local", "virtual"] as const)("redacts large bash stdout previews and spills on %s", async kind => {
  await withTempDir(async dir => {
    const marker = "SECRET-LOOKING-OUTPUT";
    const events: HarnessEvent[] = [];
    const host = kind === "local" ? localHost({ dataDir: dir }) : virtualHost({ fs: new InMemoryFs() });
    const harness = createHarness({ host, trace: { redaction: { values: [marker] } }, model: bashModel(["printf 'SECRET-LOOKING-OUTPUT %.0s' $(seq 1 2000)"]) });
    const result = await generateHarness({ harness, session: "redacted-stdout", prompt: "go", onEvent: e => { events.push(e); } });
    expect(result.status).toBe("completed");
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(marker);
    expect(serialized).toContain("[redacted]");
    const refs = [...serialized.matchAll(/"contentRef":"([^" ]+)"/g)].map(match => match[1]!);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect((await result.session.traceContent!.read(ref)).text()).not.toContain(marker);
  });
});

it.each(["url", "error", "toJSON", "tag"])("masks JSON form in spills and events: %s", async kind => {
  await withTempDir(async dir => {
    const secret = "SECRETVALUE42";
    const value = kind === "url" ? new URL(`https://h.example/?k=${secret}`)
      : kind === "error" ? Object.assign(new Error("boom"), { stderr: `auth ${secret}` })
      : kind === "toJSON" ? { toJSON() { return { leaked: secret }; } }
      : { [Symbol.toStringTag]: "Custom", field: secret };
    let calls = 0;
    const model = new MockLanguageModelV3({ doGenerate: async () => calls++ === 0
      ? { content: [{ type: "tool-call" as const, toolCallId: "lookup_1", toolName: "lookup", input: "{}" }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] }
      : { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] } });
    const host = localHost({ dataDir: dir });
    const session = await host.sessions.getOrCreate({ id: kind });
    const events: HarnessEvent[] = [];
    const harness = createHarness({ host, model, trace: { redaction: { values: [secret] }, content: { maxInlineBytes: 100 } }, runtime: { bash: false, python: false, javascript: false, toolBridge: false }, tools: { lookup: tool({ inputSchema: z.object({}), execute: async () => ({ value, padding: "x".repeat(200) }) }) } });
    await generateHarness({ harness, session, prompt: "lookup", onEvent: event => { events.push(event); } });
    const serialized = JSON.stringify(events);
    expect(() => JSON.parse(serialized)).not.toThrow();
    expect(serialized).not.toContain(secret);
    const refs = [...serialized.matchAll(/"contentRef":"([^"]+)"/g)].map(match => match[1]!);
    expect(refs.some(ref => ref.includes("tool-output"))).toBe(true);
    for (const ref of refs) {
      const text = (await session.traceContent!.read(ref)).text();
      if (ref.endsWith(".json")) expect(() => JSON.parse(text)).not.toThrow();
      expect(text).not.toContain(secret);
    }
  });
});
