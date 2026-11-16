import { validateTraceEvent } from "./validate.js";
import { localHost } from "../local-host/index.js";
import { withTempDir } from "../test/temp.js";
import { describe, expect, it } from "vitest";
import { resolveTraceOptions } from "./options.js";
import { createTraceDiff } from "./diff.js";

const encoder = new TextEncoder();

describe("createTraceDiff", () => {
  it("creates bounded unified diffs for text updates", async () => {
    const diff = await createTraceDiff(
      encoder.encode("old line\nsame\n"),
      encoder.encode("new line\nsame\n"),
      resolveTraceOptions(undefined, undefined),
    );

    expect(diff).toEqual({
      available: true,
      format: "unified",
      preview: expect.stringContaining("-old line"),
      truncated: false,
      bytes: expect.any(Number),
      sha256: expect.any(String),
    });
    expect(diff.available && diff.preview).toContain("+new line");
  });

  it("returns unavailable when file diffs are disabled", async () => {
    await expect(
      createTraceDiff(
        encoder.encode("old"),
        encoder.encode("new"),
        resolveTraceOptions({ fileDiffs: { enabled: false } }, undefined),
      ),
    ).resolves.toEqual({ available: false, reason: "disabled" });
  });

  it("returns unavailable for binary content", async () => {
    await expect(
      createTraceDiff(
        new Uint8Array([0, 255, 1, 2]),
        new Uint8Array([0, 255, 3, 4]),
        resolveTraceOptions(undefined, undefined),
      ),
    ).resolves.toEqual({ available: false, reason: "non_text" });
  });

  it("returns unavailable when content is too large to diff", async () => {
    await expect(
      createTraceDiff(
        encoder.encode("a".repeat(32)),
        encoder.encode("b".repeat(32)),
        resolveTraceOptions({ fileDiffs: { maxBytesToDiff: 16 } }, undefined),
      ),
    ).resolves.toEqual({ available: false, reason: "too_large" });
  });
});

it("keeps a bounded diff preview when full storage exceeds the limit without schema changes", async () => {
  await withTempDir(async dir => {
    const session = await localHost({ dataDir: dir }).sessions.getOrCreate({ id: "limit" });
    const files = { ...session.files, limits: { maxFileBytes: 5 } };
    const diff = await createTraceDiff(encoder.encode("before"), encoder.encode("after"), resolveTraceOptions({ fileDiffs: { maxInlineBytes: 4 } }, undefined), { files });
    expect(diff).toMatchObject({ available: false, reason: "storage_limit", preview: "@@ -", truncated: true });
    expect(diff).not.toHaveProperty("contentRef");
    const event = { schemaVersion: "lh.trace.v2", eventId: "evt_diff", sequence: 1, sessionId: "limit", timestamp: "2026-11-12T00:00:00.000Z", type: "harness.file.updated", metadata: { path: "/session/note.md", root: "session", before: { bytes: 6, sha256: "a".repeat(64) }, after: { bytes: 5, sha256: "b".repeat(64) }, diff } };
    expect(validateTraceEvent(event).metadata?.diff).toEqual(diff);
    expect(await session.artifacts.list()).toEqual([]);
  });
});
