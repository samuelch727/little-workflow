import type { ModelMessage } from "ai";
import { expect, it, vi } from "vitest";
import { compactContext, inMemoryContextCheckpointStore } from "./policy.js";

const runtime = () => ({ store: inMemoryContextCheckpointStore(), summarize: vi.fn(), model: { modelId: "fake", providerId: "fake", maxOutputTokens: 1024, contextWindow: { tokens: 30000, source: "fixture" } } });
it("passes short image/file input through without cloning URLs/binary data or calling summary/storage", async () => {
  for (const content of [
    [{ type: "image", image: new URL("https://media.invalid/picture.png") }],
    [{ type: "file", data: new Uint8Array([1, 2]), mediaType: "application/pdf" }],
  ]) {
    const messages = [{ role: "user", content }] as ModelMessage[];
    const r = runtime();
    const projected = await compactContext({ runtime: r, sessionId: "s", messages, policy: { triggerTokens: 24000, maxCompactionCostUsdPerSession: 1 } });
    expect(projected).toBe(messages);
    expect(r.summarize).not.toHaveBeenCalled();
    expect(await r.store.list!()).toEqual([]);
  }
});
it("reclaims old text while retaining all media, and stops if retained input exceeds the hard limit", async () => {
  const media: ModelMessage = { role: "user", content: [{ type: "image", image: new URL("https://media.invalid/picture.png") }] };
  const messages: ModelMessage[] = [
    { role: "user", content: "old" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "c", toolName: "lookup", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c", toolName: "lookup", output: { type: "text", value: "data ".repeat(1500) } }] },
    media,
  ];
  const r = runtime();
  const projected = await compactContext({ runtime: r, sessionId: "s", messages, policy: { triggerTokens: 2000, keepLastTurns: 1, maxCompactionCostUsdPerSession: 1 } });
  expect(projected.at(-1)).toBe(media);
  expect(JSON.stringify(projected)).toContain("canonical result c");
  expect(r.summarize).not.toHaveBeenCalled();
  expect(await r.store.list!()).toEqual([]);
  await expect(compactContext({ runtime: r, sessionId: "s", messages: [...messages, { role: "user", content: "required ".repeat(5000) }], policy: { triggerTokens: 2000, keepLastTurns: 1 } })).rejects.toThrow("unbudgeted_multimodal_input");
  expect((messages[2] as any).content[0].output.value).toBe("data ".repeat(1500));
});
