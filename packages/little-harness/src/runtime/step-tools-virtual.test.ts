import { jsonSchema, tool, type ToolSet } from "ai";
import { InMemoryFs } from "just-bash";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HarnessPersistenceError } from "../errors.js";
import { once, withStepToolContext } from "./step-tools.js";

const disk = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const forbidden = (name: string) => () => {
    disk.calls.push(name);
    throw new Error(`Native filesystem access forbidden: ${name}`);
  };
  return {
    ...actual,
    mkdir: forbidden("mkdir"),
    readFile: forbidden("readFile"),
    rename: forbidden("rename"),
    writeFile: forbidden("writeFile"),
  };
});

afterEach(() => {
  expect(disk.calls).toEqual([]);
  disk.calls.length = 0;
  vi.restoreAllMocks();
});

const onceDir = "/data/sessions/chat/once";
const input = { applicationId: "APP-1012" };

function marked(execute: () => unknown) {
  return once(tool({
    description: "Record a decision.",
    inputSchema: jsonSchema<typeof input>({ type: "object" }),
    execute,
  }));
}

function call(tools: ToolSet): Promise<unknown> {
  const execute = tools.record!.execute as (input: unknown, options: unknown) => Promise<unknown>;
  return execute(input, { toolCallId: "call", messages: [] });
}

function wrap(fs: InMemoryFs, record: ReturnType<typeof marked>, dir = onceDir) {
  return withStepToolContext({ record }, { sessionId: "chat", onceDir: dir, fs });
}

describe("once records in the data filesystem", () => {
  it("records the same JSON through a temporary name and mv, then returns it for a second call", async () => {
    const fs = new InMemoryFs();
    const write = vi.spyOn(fs, "writeFile");
    const move = vi.spyOn(fs, "mv");
    const execute = vi.fn(() => ({ recordId: "record_1" }));
    const tools = wrap(fs, marked(execute));

    expect(await call(tools)).toEqual({ recordId: "record_1" });
    expect(await call(tools)).toEqual({ recordId: "record_1" });
    expect(execute).toHaveBeenCalledTimes(1);
    const [name] = await fs.readdir(onceDir);
    expect(name).toMatch(/^idem_[0-9a-f]{32}\.json$/u);
    const final = `${onceDir}/${name}`;
    expect(JSON.parse(await fs.readFile(final))).toEqual({
      toolName: "record", recordedAt: expect.any(String), result: { recordId: "record_1" },
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0]).toMatch(new RegExp(`^${final}\\.\\d+\\.\\d+\\.tmp$`, "u"));
    expect(move).toHaveBeenCalledExactlyOnceWith(write.mock.calls[0]![0], final);
    expect(write.mock.invocationCallOrder[0]).toBeLessThan(move.mock.invocationCallOrder[0]!);
  });

  it("shares an in-flight call across wrappers over the same filesystem and normalized path", async () => {
    const fs = new InMemoryFs();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const execute = vi.fn(async () => {
      started();
      await gate;
      return { recordId: "record_1" };
    });
    const record = marked(execute);
    const first = call(wrap(fs, record));
    await entered;
    const second = call(wrap(fs, record, "data/sessions/./chat/other/../once/"));
    release();

    expect(await Promise.all([first, second])).toEqual([
      { recordId: "record_1" }, { recordId: "record_1" },
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(onceDir)).toHaveLength(1);
  });

  it("reads a completed record after reopening the adapter over the same filesystem", async () => {
    const fs = new InMemoryFs();
    const firstExecute = vi.fn(() => ({ recordId: "record_1" }));
    expect(await call(wrap(fs, marked(firstExecute)))).toEqual({ recordId: "record_1" });

    // Discard module state: only the filesystem carries the result into this wrapper.
    vi.resetModules();
    const reopened = await import("./step-tools.js");
    const secondExecute = vi.fn(() => ({ recordId: "record_2" }));
    const tools = reopened.withStepToolContext({ record: marked(secondExecute) }, {
      sessionId: "chat", onceDir, fs,
    });

    expect(await call(tools)).toEqual({ recordId: "record_1" });
    expect(firstExecute).toHaveBeenCalledTimes(1);
    expect(secondExecute).not.toHaveBeenCalled();
  });

  it("keeps simultaneous calls at the same path independent across different filesystem objects", async () => {
    const firstFs = new InMemoryFs();
    const secondFs = new InMemoryFs();
    const first = vi.fn(() => ({ filesystem: "first" }));
    const second = vi.fn(() => ({ filesystem: "second" }));

    expect(await Promise.all([
      call(wrap(firstFs, marked(first))), call(wrap(secondFs, marked(second))),
    ])).toEqual([{ filesystem: "first" }, { filesystem: "second" }]);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    const [name] = await firstFs.readdir(onceDir);
    expect(await secondFs.readdir(onceDir)).toEqual([name]);
    expect(JSON.parse(await secondFs.readFile(`${onceDir}/${name}`)).result).toEqual({ filesystem: "second" });
  });

  it("preserves undefined results in a second wrapper", async () => {
    const fs = new InMemoryFs();
    const execute = vi.fn(() => undefined);
    const record = marked(execute);
    expect(await call(wrap(fs, record))).toBeUndefined();
    expect(await call(wrap(fs, record))).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
    const [name] = await fs.readdir(onceDir);
    expect(JSON.parse(await fs.readFile(`${onceDir}/${name}`))).toMatchObject({ resultUndefined: true });
  });

  it("leaves a persisted unavailable marker when the result is not JSON", async () => {
    const fs = new InMemoryFs();
    const execute = vi.fn(() => ({ amount: 1000n }));
    const record = marked(execute);
    expect(await call(wrap(fs, record))).toEqual({ amount: 1000n });
    vi.resetModules();
    const reopened = await import("./step-tools.js");
    const tools = reopened.withStepToolContext({ record }, { sessionId: "chat", onceDir, fs });
    await expect(call(tools)).rejects.toMatchObject({
      name: "HarnessPersistenceError",
      message: expect.stringContaining("could not be saved, so it does not run again"),
    });
    expect(execute).toHaveBeenCalledTimes(1);
    const [name] = await fs.readdir(onceDir);
    expect(JSON.parse(await fs.readFile(`${onceDir}/${name}`))).toMatchObject({ resultUnavailable: true });
  });

  it("refuses an unrecorded repeat on the same filesystem without affecting another filesystem", async () => {
    const failedFs = new InMemoryFs();
    vi.spyOn(failedFs, "writeFile").mockRejectedValue(Object.assign(new Error("ENOSPC: full"), { code: "ENOSPC" }));
    const execute = vi.fn(() => ({ recordId: "record_1" }));
    const record = marked(execute);
    expect(await call(wrap(failedFs, record))).toEqual({ recordId: "record_1" });
    await expect(call(wrap(failedFs, record, "data/sessions/chat/once/"))).rejects.toThrow(HarnessPersistenceError);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await call(wrap(new InMemoryFs(), record))).toEqual({ recordId: "record_1" });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does not record a thrown tool error, so a second attempt can run", async () => {
    const fs = new InMemoryFs();
    const execute = vi.fn().mockRejectedValueOnce(new Error("service unavailable")).mockResolvedValue({ recordId: "record_1" });
    const record = marked(execute);
    await expect(call(wrap(fs, record))).rejects.toThrow("service unavailable");
    expect(await fs.exists(onceDir)).toBe(false);
    expect(await call(wrap(fs, record))).toEqual({ recordId: "record_1" });
    expect(await call(wrap(fs, record))).toEqual({ recordId: "record_1" });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("propagates non-missing read errors and malformed records before running the tool", async () => {
    const fs = new InMemoryFs();
    const execute = vi.fn(() => "written");
    const tools = wrap(fs, marked(execute));
    const failure = Object.assign(new Error("EACCES: refused"), { code: "EACCES" });
    const read = vi.spyOn(fs, "readFile").mockRejectedValueOnce(failure);
    await expect(call(tools)).rejects.toBe(failure);
    read.mockResolvedValueOnce("{broken");
    await expect(call(tools)).rejects.toThrow(SyntaxError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("normalizes uncoded read errors without widening the missing-file catch", async () => {
    const fs = new InMemoryFs();
    const execute = vi.fn(() => "written");
    const tools = wrap(fs, marked(execute));
    const read = vi.spyOn(fs, "readFile");
    const uncoded = new Error("EIO: read failed");
    read.mockRejectedValueOnce(uncoded);
    await expect(call(tools)).rejects.toBe(uncoded);
    expect(uncoded).toMatchObject({ code: "EIO", message: "EIO: read failed" });
    const alreadyCoded = Object.assign(new Error("ENOENT: misleading missing prefix"), { code: "EACCES" });
    read.mockRejectedValueOnce(alreadyCoded);
    await expect(call(tools)).rejects.toBe(alreadyCoded);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["mkdir", "writeFile", "mv"] as const)("normalizes a %s record failure and refuses a repeat", async operation => {
    const fs = new InMemoryFs();
    const failure = new Error("EROFS: record storage refused");
    vi.spyOn(fs, operation).mockRejectedValue(failure);
    const execute = vi.fn(() => "written");
    const record = marked(execute);
    expect(await call(wrap(fs, record))).toBe("written");
    expect(failure).toMatchObject({ code: "EROFS", message: "EROFS: record storage refused" });
    await expect(call(wrap(fs, record))).rejects.toThrow(HarnessPersistenceError);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
