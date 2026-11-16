import { describe, expect, it } from "vitest";
import { HarnessInputError } from "../errors.js";
import { sha256Hex } from "../ids.js";
import { localHost } from "../local-host/index.js";
import { withTempDir } from "../test/temp.js";
import { captureTraceContent } from "./content.js";
import { resolveTraceOptions } from "./options.js";
import { sanitizeTraceValue } from "./redaction.js";
import { traceContentStoreFor } from "./storage.js";

const marker = "SECRET-LOOKING-OUTPUT";

describe("literal trace value redaction", () => {
  it("merges run values, prioritizes longest literals, and rejects empty values", () => {
    const options = resolveTraceOptions(
      { redaction: { values: ["secret", "a.b[0]"] } },
      { redaction: { values: ["secret-long"] } },
    );
    expect(
      sanitizeTraceValue("secret-long secret a.b[0] aXb0", options),
    ).toMatchObject({
      value: "[redacted] [redacted] [redacted] aXb0",
      redacted: true,
      reason: "value",
    });
    expect(() =>
      resolveTraceOptions({ redaction: { values: [""] } }, undefined),
    ).toThrow(HarnessInputError);
    expect(() =>
      resolveTraceOptions(undefined, { redaction: { values: [""] } }),
    ).toThrow(HarnessInputError);
  });

  it.each(["private-store", "legacy-writer"] as const)(
    "redacts before clipping, hashing and spilling through %s",
    async (mode) => {
      await withTempDir(async (dir) => {
        const session = await localHost({ dataDir: dir }).sessions.getOrCreate({
          id: mode,
        });
        const files =
          mode === "private-store" ? session.files : { ...session.files };
        const options = resolveTraceOptions(
          {
            redaction: { values: [marker] },
            content: { previewBytes: 9, maxInlineBytes: 1 },
          },
          undefined,
        );
        const value = `pre:${marker}:post`;
        const expected = "pre:[redacted]:post";
        const ref = await captureTraceContent({
          value,
          label: "stdout",
          files,
          traceOptions: options,
        });
        expect(ref).toMatchObject({
          preview: expected.slice(0, 9),
          redacted: true,
          redactionReason: "value",
          bytes: new TextEncoder().encode(expected).length,
          sha256: sha256Hex(new TextEncoder().encode(expected)),
        });
        expect(ref.preview).not.toContain("SECRET");
        const stored =
          mode === "private-store"
            ? await traceContentStoreFor(files)!.read(ref.contentRef!)
            : await files.read(ref.contentRef!);
        expect(stored.text()).toBe(expected);
        expect(value).toBe(`pre:${marker}:post`);
      });
    },
  );

  it("redacts escaped JSON strings before serialization without mutating tool results", async () => {
    await withTempDir(async (dir) => {
      const session = await localHost({ dataDir: dir }).sessions.getOrCreate({
        id: "json",
      });
      const secret = 'quote" slash\\ newline\n';
      const options = resolveTraceOptions(
        {
          redaction: { values: [secret] },
          content: { maxInlineBytes: 1, previewBytes: 1000 },
        },
        undefined,
      );
      const value = Object.freeze({
        nested: Object.freeze([secret]),
        ordinary: "visible",
      });
      for (const input of [value, JSON.stringify(value)]) {
        const ref = await captureTraceContent({
          value: input,
          label: "json",
          files: session.files,
          traceOptions: options,
        });
        const stored = (
          await traceContentStoreFor(session.files)!.read(ref.contentRef!)
        ).text();
        expect(stored).not.toContain(secret);
        expect(stored).not.toContain(JSON.stringify(secret).slice(1, -1));
        expect(JSON.parse(stored)).toEqual({
          nested: ["[redacted]"],
          ordinary: "visible",
        });
        expect(ref.redactionReason).toBe("value");
      }
      expect(value.nested[0]).toBe(secret);
    });
  });

  it("keeps metadata/path precedence and is byte-identical without values", async () => {
    await withTempDir(async (dir) => {
      const session = await localHost({ dataDir: dir }).sessions.getOrCreate({
        id: "unchanged",
      });
      const base = resolveTraceOptions(
        { content: { maxInlineBytes: 1 } },
        undefined,
      );
      const empty = resolveTraceOptions(
        { content: { maxInlineBytes: 1 }, redaction: { values: [] } },
        undefined,
      );
      for (const value of [
        "normal\ntext",
        { token: "hidden", safe: "visible" },
        [1, "plain"],
      ]) {
        const input = { value, label: "same", files: session.files };
        expect(
          await captureTraceContent({ ...input, traceOptions: empty }),
        ).toEqual(await captureTraceContent({ ...input, traceOptions: base }));
      }
      const options = resolveTraceOptions(
        { redaction: { values: [marker], paths: ["/secret"] } },
        undefined,
      );
      expect(
        await captureTraceContent({
          value: marker,
          label: "path",
          files: session.files,
          traceOptions: options,
          path: "/secret/file",
        }),
      ).toEqual({ captured: false, redacted: true, redactionReason: "path" });
      expect(
        await captureTraceContent({
          value: { token: marker, safe: marker },
          label: "key",
          files: session.files,
          traceOptions: options,
        }),
      ).toMatchObject({ redacted: true, redactionReason: "metadataKey" });
    });
  });
});

it.each([[undefined], [42], "abc", [""], null, false].map(values => ({ values })))("rejects invalid value lists at both levels: %j", ({ values }) => {
  const input = { redaction: { values } } as any;
  for (const args of [[input, undefined], [undefined, input]] as const) {
    expect(() => resolveTraceOptions(args[0], args[1])).toThrow(HarnessInputError);
    expect(() => resolveTraceOptions(args[0], args[1])).toThrow("trace.redaction.values");
  }
});
it.each([
  ["90210123", { pin: 90210123 }],
  ["123", { amount: 51234 }],
  ["true", { ok: true }],
  ["key-secret", { "prefix-key-secret": "ordinary" }],
  ['": "', { a: "b" }],
  ["90210123", { pin: 90210123n }],
] as const)("keeps spilled JSON parseable for %s", async (secret, value) => {
  await withTempDir(async dir => {
    const session = await localHost({ dataDir: dir }).sessions.getOrCreate({ id: "primitive" });
    const options = resolveTraceOptions({ redaction: { values: [secret] }, content: { maxInlineBytes: 100 } }, undefined);
    const ref = await captureTraceContent({ value: { ...value, padding: "x".repeat(200) }, label: "tool-output_lookup", files: session.files, traceOptions: options });
    const text = (await traceContentStoreFor(session.files)!.read(ref.contentRef!)).text();
    expect(() => JSON.parse(text)).not.toThrow();
    // A syntax-only pattern is not content and must not alter JSON punctuation.
    if (secret !== '": "') expect(text).not.toContain(secret);
  });
});

it("keeps URL/Error JSON bytes identical with values absent or empty", async () => {
  await withTempDir(async dir => {
    const session = await localHost({ dataDir: dir }).sessions.getOrCreate({ id: "identity" });
    const value = { u: new URL("https://example.test/?q=raw"), e: Object.assign(new Error("boom"), { stderr: "raw" }) };
    for (const redaction of [{}, { values: [] }]) {
      const options = resolveTraceOptions({ redaction, content: { maxInlineBytes: 1 } }, undefined);
      const ref = await captureTraceContent({ value, label: "json", files: session.files, traceOptions: options });
      expect((await traceContentStoreFor(session.files)!.read(ref.contentRef!)).text()).toBe(JSON.stringify(value, null, 2));
    }
  });
});
it("exports sanitizers through the built internals entry and preserves binary metadata", async () => {
  const entry = await import(/* @vite-ignore */ new URL("../../dist/internals.js", import.meta.url).href);
  const options = resolveTraceOptions({ redaction: { values: ["secret"] } }, undefined);
  expect(entry.redactTraceText("secret", options).text).toBe("[redacted]");
  expect(entry.sanitizeTraceValue({ data: new Uint8Array([1, 2]) }, options).value).toEqual({ data: { binary: true, bytes: 2, sha256: sha256Hex(new Uint8Array([1, 2])) } });
});
