import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../ids.js";
import { createEventedFileWriter } from "../execution/evented-file-writer.js";
import { localHost } from "../local-host/index.js";
import { withTempDir } from "../test/temp.js";
import { resolveTraceOptions } from "./options.js";
import { captureTraceContent } from "./content.js";

describe("captureTraceContent", () => {
  it("records an unavailable full copy above the writer's byte ceiling without creating an artifact", async () => {
    await withTempDir(async (dir) => {
      const session = await localHost({ dataDir: dir }).sessions.getOrCreate({ id: "bounded" });
      const write = vi.fn(session.files.writeText);
      const emit = vi.fn(async () => {});
      const options = resolveTraceOptions({ content: { previewBytes: 3, maxInlineBytes: 1 } }, undefined);
      const files = createEventedFileWriter({ ...session.files, limits: { maxFileBytes: 10 }, writeText: write }, emit, { traceOptions: options });
      const value = "界😀界😀";
      const ref = await captureTraceContent({ value, label: "response", files, traceOptions: options });
      expect(files.limits).toEqual({ maxFileBytes: 10 });
      expect(ref).toEqual({ captured: false, preview: "界😀", truncated: true, bytes: 14, sha256: sha256Hex(new TextEncoder().encode(value)), mediaType: "text/plain", unavailableReason: "storage_limit", storageLimitBytes: 10 });
      expect(new TextEncoder().encode(ref.preview).byteLength).toBe(7);
      expect(ref.preview!.length).toBe(3);
      expect(write).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
      expect(ref).not.toHaveProperty("contentRef");
      await expect(session.files.list("/artifacts/trace", { recursive: true })).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("stores the exact ceiling, preserves sanitized hashes, and propagates unrelated write failures", async () => {
    await withTempDir(async (dir) => {
      const session = await localHost({ dataDir: dir }).sessions.getOrCreate({ id: "boundary" });
      const traceOptions = resolveTraceOptions({ content: { previewBytes: 2, maxInlineBytes: 1 } }, undefined);
      const value = "界😀";
      const files = { ...session.files, limits: { maxFileBytes: 7 } };
      const ref = await captureTraceContent({ value, label: "exact", files, traceOptions });
      expect(ref.captured).toBe(true);
      expect(ref.preview).toBe("界");
      expect((await files.read(ref.contentRef!)).text()).toBe(value);
      const over = await captureTraceContent({ value: `${value}x`, label: "one-byte-over", files, traceOptions });
      expect(over).toMatchObject({ captured: false, bytes: 8, unavailableReason: "storage_limit", storageLimitBytes: 7 });
      expect(over).not.toHaveProperty("contentRef");
      const failure = new Error("Synthetic required storage failure");
      for (const limits of [undefined, { maxFileBytes: 7 }]) {
        await expect(captureTraceContent({ value, label: "fails", files: { ...files, limits, writeText: async () => { throw failure; } }, traceOptions })).rejects.toBe(failure);
      }
      const redacted = await captureTraceContent({ value: { safe: "visible", token: "private" }, label: "redacted", files, traceOptions });
      expect(redacted).toMatchObject({ captured: false, redacted: true, unavailableReason: "storage_limit", sha256: sha256Hex(new TextEncoder().encode(JSON.stringify({ safe: "visible", token: "[redacted]" }, null, 2))) });
    });
  });

  it.each(["x", "界"])("preserves the default 512-code-unit preview for %s text", async character => {
    await withTempDir(async dir => {
      const session = await localHost({ dataDir: dir }).sessions.getOrCreate({ id: "legacy-preview" });
      const value = character.repeat(700);
      const ref = await captureTraceContent({ value, label: "response", files: session.files, traceOptions: resolveTraceOptions(undefined, undefined) });
      expect(ref.preview).toBe(character.repeat(512));
      expect(ref.bytes).toBe(new TextEncoder().encode(value).byteLength);
      expect(ref.sha256).toBe(sha256Hex(new TextEncoder().encode(value)));
    });
  });

  it.each([
    [0, ""], [1, "a"], [2, "a"], [3, "a😀"], [4, "a😀b"], [5, "a😀b"],
  ] as const)("clips at %i code units without splitting an astral character", async (limit, expected) => {
    await withTempDir(async dir => {
      const session = await localHost({ dataDir: dir }).sessions.getOrCreate({ id: "surrogate-preview" });
      const ref = await captureTraceContent({ value: "a😀b", label: "response", files: session.files, traceOptions: resolveTraceOptions({ content: { previewBytes: limit } }, undefined) });
      expect(ref.preview).toBe(expected);
      expect(ref.preview!.length).toBeLessThanOrEqual(limit);
      expect(new TextDecoder().decode(new TextEncoder().encode(ref.preview))).toBe(ref.preview);
      expect(ref.bytes).toBe(6);
    });
  });

  it("backs off a surrogate pair split by the default boundary", async () => {
    await withTempDir(async dir => {
      const session = await localHost({ dataDir: dir }).sessions.getOrCreate({ id: "default-surrogate-preview" });
      const ref = await captureTraceContent({ value: `${"a".repeat(511)}😀z`, label: "response", files: session.files, traceOptions: resolveTraceOptions(undefined, undefined) });
      expect(ref.preview).toBe("a".repeat(511));
      expect(ref.bytes).toBe(516);
    });
  });

  it("captures small strings inline with byte metadata", async () => {
    await withTempDir(async (dir) => {
      const session = await localHost({ dataDir: dir }).sessions.getOrCreate({ id: "chat_123" });

      await expect(
        captureTraceContent({
          value: "short result",
          label: "tool-output",
          files: session.files,
          traceOptions: resolveTraceOptions(undefined, undefined),
        }),
      ).resolves.toEqual({
        captured: true,
        preview: "short result",
        truncated: false,
        bytes: 12,
        sha256: expect.any(String),
        mediaType: "text/plain",
      });
    });
  });

  it("spools large strings into trace artifacts", async () => {
    await withTempDir(async (dir) => {
      const session = await localHost({ dataDir: dir }).sessions.getOrCreate({ id: "chat_123" });
      const large = "x".repeat(80);

      const ref = await captureTraceContent({
        value: large,
        label: "model-response",
        files: session.files,
        traceOptions: resolveTraceOptions(
          { content: { previewBytes: 8, maxInlineBytes: 16 } },
          undefined,
        ),
      });

      expect(ref).toEqual({
        captured: true,
        preview: "xxxxxxxx",
        truncated: true,
        contentRef: expect.stringMatching(/^\/artifacts\/trace\/model-response\//),
        bytes: 80,
        sha256: expect.any(String),
        mediaType: "text/plain",
      });
      await expect(session.files.read(ref.contentRef!)).resolves.toMatchObject({ path: ref.contentRef });
      expect((await session.files.read(ref.contentRef!)).text()).toBe(large);
    });
  });

  it("redacts sensitive paths and metadata keys", async () => {
    await withTempDir(async (dir) => {
      const session = await localHost({ dataDir: dir }).sessions.getOrCreate({ id: "chat_123" });
      const traceOptions = resolveTraceOptions(
        { redaction: { paths: ["/persistent/secrets"], metadataKeys: ["token"] } },
        undefined,
      );

      await expect(
        captureTraceContent({
          value: "secret",
          label: "tool-input",
          files: session.files,
          traceOptions,
          path: "/persistent/secrets/key.txt",
        }),
      ).resolves.toEqual({
        captured: false,
        redacted: true,
        redactionReason: "path",
      });

      await expect(
        captureTraceContent({
          value: "secret",
          label: "tool-input",
          files: session.files,
          traceOptions,
          metadataKey: "token",
        }),
      ).resolves.toEqual({
        captured: false,
        redacted: true,
        redactionReason: "metadataKey",
      });
    });
  });

  it("redacts nested sensitive metadata keys before serializing previews", async () => {
    await withTempDir(async (dir) => {
      const session = await localHost({ dataDir: dir }).sessions.getOrCreate({ id: "chat_123" });

      const ref = await captureTraceContent({
        value: {
          query: "alpha",
          apiKey: "secret-api-key",
          nested: { token: "secret-token", safe: "visible" },
        },
        label: "tool-input",
        files: session.files,
        traceOptions: resolveTraceOptions(undefined, undefined),
      });

      expect(ref).toMatchObject({
        captured: true,
        redacted: true,
        redactionReason: "metadataKey",
      });
      expect(ref.preview).toContain("visible");
      expect(ref.preview).not.toContain("secret-api-key");
      expect(ref.preview).not.toContain("secret-token");
    });
  });

  it("summarizes nested binary metadata without serializing raw bytes", async () => {
    await withTempDir(async (dir) => {
      const session = await localHost({ dataDir: dir }).sessions.getOrCreate({ id: "chat_123" });

      const ref = await captureTraceContent({
        value: {
          file: new Uint8Array([0, 1, 2, 3]),
          nested: { buffer: Buffer.from([4, 5, 6]) },
        },
        label: "tool-input",
        files: session.files,
        traceOptions: resolveTraceOptions(undefined, undefined),
      });

      const preview = JSON.parse(ref.preview!);
      expect(preview).toEqual({
        file: { binary: true, bytes: 4, sha256: expect.any(String) },
        nested: { buffer: { binary: true, bytes: 3, sha256: expect.any(String) } },
      });
      expect(ref.preview).not.toContain('"data"');
      expect(ref.preview).not.toContain('"0"');
    });
  });

  it("records binary values as metadata without preview or trace artifact content", async () => {
    await withTempDir(async (dir) => {
      const session = await localHost({ dataDir: dir }).sessions.getOrCreate({ id: "chat_123" });
      const value = new Uint8Array([0, 1, 2, 3]);

      const ref = await captureTraceContent({
        value,
        label: "tool-output",
        files: session.files,
        traceOptions: resolveTraceOptions(undefined, undefined),
        mediaType: "application/pdf",
      });

      expect(ref).toEqual({
        captured: false,
        bytes: 4,
        sha256: expect.any(String),
        mediaType: "application/pdf",
      });
      expect(ref.preview).toBeUndefined();
      expect(ref.contentRef).toBeUndefined();
      await expect(session.files.list("/artifacts/trace", { recursive: true })).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });
});
