import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { createHarness } from "../create-harness.js";
import { HarnessInputError } from "../errors.js";
import { localHost } from "../local-host/local-host.js";
import { generateHarness } from "./generate-harness.js";
import { streamHarness } from "./stream-harness.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

async function harness() {
  const dataDir = await mkdtemp(join(tmpdir(), "turn-messages-"));
  dirs.push(dataDir);
  const model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: "ok" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage,
      warnings: [],
    }),
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          for (const part of [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "0" },
            { type: "text-delta", id: "0", delta: "ok" },
            { type: "text-end", id: "0" },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
          ]) {
            controller.enqueue(part);
          }
          controller.close();
        },
      }),
    }) as never,
  });
  return { model, harness: createHarness({ host: localHost({ dataDir }), model, runtime: { bash: false } }) };
}

function lastUserText(prompt: unknown): string {
  const messages = prompt as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
  const user = messages.filter((message) => message.role === "user").at(-1);
  return (user?.content ?? []).map((part) => part.text ?? "").join("");
}

describe("prompt", () => {
  it("sends a plain prompt as one user message", async () => {
    const { model, harness: h } = await harness();
    const result = await generateHarness({ harness: h, session: "s", prompt: "Pre-approve APP-1001." });

    expect(result.status).toBe("completed");
    expect(lastUserText(model.doGenerateCalls[0]?.prompt)).toBe("Pre-approve APP-1001.");
  });

  it("works with streamHarness too", async () => {
    const { model, harness: h } = await harness();
    const streaming = streamHarness({ harness: h, session: "s", prompt: "Pre-approve APP-1002." });

    expect(await streaming.text).toBe("ok");
    expect((await streaming.finished).status).toBe("completed");
    expect(lastUserText(model.doStreamCalls[0]?.prompt)).toBe("Pre-approve APP-1002.");
  });

  it("refuses prompt with messages or an Input Type, and an empty prompt", async () => {
    const { harness: h } = await harness();
    await expect(
      generateHarness({
        harness: h,
        prompt: "a",
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "b" }] }],
      }),
    ).rejects.toThrow("Pass `prompt` or `messages`, not both.");
    await expect(generateHarness({ harness: h, prompt: "a", type: "doc.review", input: {} })).rejects.toThrow(
      "Pass `prompt` or `type` + `input`, not both.",
    );
    await expect(generateHarness({ harness: h, prompt: "a", input: { applicationId: "APP-1" } })).rejects.toThrow(
      "Pass `prompt` or `type` + `input`, not both.",
    );
    const streaming = streamHarness({ harness: h, prompt: "a", input: { applicationId: "APP-1" } });
    await expect(streaming.finished).rejects.toThrow("Pass `prompt` or `type` + `input`, not both.");
    await expect(streaming.text).rejects.toBeInstanceOf(HarnessInputError);
    await expect(generateHarness({ harness: h, prompt: "  " })).rejects.toBeInstanceOf(HarnessInputError);
  });

  it("explains a message without parts instead of failing inside the AI SDK", async () => {
    const { harness: h } = await harness();
    await expect(
      generateHarness({ harness: h, messages: [{ role: "user", content: "hi" }] as never }),
    ).rejects.toThrow("messages[0] has no `parts`");
    const streaming = streamHarness({ harness: h, messages: [{ role: "user", content: "hi" }] as never });
    await expect(streaming.text).rejects.toThrow("messages[0] has no `parts`");
    await expect(streaming.finished).rejects.toBeInstanceOf(HarnessInputError);
  });
});
