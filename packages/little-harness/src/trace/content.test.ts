import { describe, expect, it } from "vitest";
import { localHost } from "../local-host/index.js";
import { withTempDir } from "../test/temp.js";
import { resolveTraceOptions } from "./options.js";
import { captureTraceContent } from "./content.js";

describe("captureTraceContent", () => {
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
