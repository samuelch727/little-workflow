import { MockLanguageModelV3 } from "ai/test";
import { InMemoryFs } from "just-bash";
import { describe, expect, it, vi } from "vitest";
import { createHarness } from "../create-harness.js";
import { HarnessTerminalStageError } from "../errors.js";
import { createFsFileWriter } from "../files/fs-file-writer.js";
import { localHost } from "../local-host/index.js";
import { withTempDir } from "../test/temp.js";
import { virtualHost } from "../virtual-host/virtual-host.js";
import type { HarnessEvent, HarnessHost } from "../types.js";
import { generateHarness } from "./generate-harness.js";
import { streamHarness } from "./stream-harness.js";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
function model(command?: string) {
  let calls = 0;
  const next = () => {
    const run = calls++ === 0 && command !== undefined;
    return { content: run ? [{ type: "tool-call" as const, toolCallId: "call", toolName: "bash", input: JSON.stringify({ command }) }] : [{ type: "text" as const, text: "done" }], finishReason: { unified: run ? "tool-calls" as const : "stop" as const, raw: run ? "tool-calls" : "stop" }, usage, warnings: [] };
  };
  return new MockLanguageModelV3({ doGenerate: async () => next(), doStream: async () => {
    const result = next();
    return { stream: new ReadableStream({ start(c) {
      c.enqueue({ type: "stream-start", warnings: [] });
      for (const part of result.content) {
        if (part.type === "tool-call") c.enqueue(part);
        else { c.enqueue({ type: "text-start", id: "t" }); c.enqueue({ type: "text-delta", id: "t", delta: part.text }); c.enqueue({ type: "text-end", id: "t" }); }
      }
      c.enqueue({ type: "finish", finishReason: result.finishReason, usage }); c.close();
    } }) };
  } });
}
async function turn(host: HarnessHost, mode: "generate" | "stream", command?: string) {
  const events: HarnessEvent[] = [];
  const harness = createHarness({ host, model: model(command), onEvent: e => { events.push(e); } });
  const options = { harness, session: "chat", prompt: "go" };
  if (mode === "generate") return { result: await generateHarness(options), events };
  const run = streamHarness(options);
  const chunks = [];
  for await (const chunk of run.toUIMessageStream()) chunks.push(chunk.type);
  expect(chunks).toContain("finish");
  return { result: await run.finished, events };
}

describe("terminal artifact discovery", () => {
  for (const mode of ["generate", "stream"] as const) {
    for (const target of ["/missing", "/artifacts/link", "/session/report"]) {
      it(`${mode}: refuses ${target} links on both in-process hosts and completes another turn`, async () => {
        await withTempDir(async dir => {
          const stderrs: unknown[] = [];
          for (const host of [virtualHost({ fs: new InMemoryFs() }), localHost({ dataDir: dir, sandbox: "in-process" })]) {
            const first = await turn(host, mode, `echo data > /session/report; ln -s ${target} /artifacts/link`);
            expect(first.result.status).toBe("completed");
            const command = first.events.find(e => e.type.endsWith("command.failed"));
            expect(command).toBeDefined();
            expect(command?.metadata?.exitCode).not.toBe(0);
            stderrs.push(command?.metadata?.stderr);
            expect(await first.result.session.artifacts.list()).toEqual([]);
            const second = await turn(host, mode);
            expect(second.result.status).toBe("completed");
            expect(second.events.some(e => e.type === "harness.model.failed")).toBe(false);
          }
          expect(stderrs[0]).toEqual(stderrs[1]);
        });
      });
    }
    it(`${mode}: tolerates pre-existing dangling, self and cross-root links over two turns`, async () => {
      const fs = new InMemoryFs({ "/session/good.txt": "ok", "/artifacts/good.txt": "ok" });
      for (const root of ["/session", "/artifacts"]) {
        await fs.symlink("/missing", `${root}/dangling`);
        await fs.symlink(`${root}/self`, `${root}/self`);
        await fs.symlink("/session/good.txt", `${root}/cross`);
      }
      const host = virtualHost({ fs });
      for (let i = 0; i < 2; i++) {
        const { result, events } = await turn(host, mode);
        expect(result.status).toBe("completed");
        expect(result.artifacts.map(a => a.path)).toEqual(["/artifacts/good.txt"]);
        expect((await result.session.files.list("/session")).filter(a => a.kind === "file").map(a => a.path)).toEqual(["/session/good.txt"]);
        expect(events.some(e => e.type === "harness.model.failed")).toBe(false);
      }
    });
    it(`${mode}: a whole listing failure warns without failing a finished response`, async () => {
      const fs = new InMemoryFs();
      const host = virtualHost({ fs });
      const session = await host.sessions.getOrCreate({ id: "chat" });
      const readdir = fs.readdir.bind(fs);
      vi.spyOn(fs, "readdir").mockImplementation(async p => {
        if (p === "/artifacts") throw Object.assign(new Error("private filesystem detail"), { code: "EIO" });
        return readdir(p);
      });
      const { result, events } = await turn(host, mode);
      expect(result.status).toBe("completed");
      expect(result.artifacts).toEqual([]);
      expect(result.warnings).toContainEqual(expect.objectContaining({ code: "artifact_list_warning", metadata: { stage: "artifact_list", code: "EIO" } }));
      expect(JSON.stringify(result.warnings)).not.toContain("private filesystem detail");
      expect((await session.status()).state).toBe("idle");
      expect(events.some(e => e.type === "harness.model.failed")).toBe(false);
    });
  }
  it("skips an ENOENT race but keeps readable siblings", async () => {
    const fs = new InMemoryFs({ "/session/no.txt": "x", "/session/ok.txt": "y" });
    const original = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(async p => { if (p.endsWith("no.txt")) throw new Error("ENOENT: entry vanished"); return original(p); });
    expect(await createFsFileWriter(fs).list("/session")).toEqual([{ path: "/session/ok.txt", kind: "file", bytes: 1 }]);
  });
  it("retains terminal causes without putting them in the public message", () => {
    const cause = new Error("private");
    const error = new HarnessTerminalStageError("persistence", { cause });
    expect(error.cause).toBe(cause);
    expect(error.message).not.toContain("private");
  });
});
