import { expect, it, vi } from "vitest";
import {
  attachTraceContentStore,
  createTraceContentStore,
  isTraceContentRef,
  sanitizeTraceValue,
  TRACE_CONTENT_PREFIX,
} from "../internals.js";
import { localHost } from "../local-host/index.js";
import { withTempDir } from "../test/temp.js";
import type { FileWriter } from "../types.js";
import { captureTraceContent } from "./content.js";
import { resolveTraceOptions } from "./options.js";

it("keeps spilled trace content out of session files once a host attaches a store to its own writer", async () => {
  await withTempDir(async (dir) => {
    const session = await localHost({ dataDir: dir }).sessions.getOrCreate({ id: "custom" });
    // A host that builds its own writer: the same methods, and no store attached.
    const written: string[] = [];
    const files: FileWriter = {
      ...session.files,
      writeText: (path, text, options) => {
        written.push(path);
        return session.files.writeText(path, text, options);
      },
    };
    const traceOptions = resolveTraceOptions({ content: { maxInlineBytes: 8 } }, undefined);
    const value = "x".repeat(64);

    const legacy = await captureTraceContent({ value, label: "tool-output", files, traceOptions });
    expect(legacy.contentRef).toMatch(/^\/artifacts\/trace\//);
    expect(written).toEqual([legacy.contentRef]);

    const kept = new Map<string, string>();
    const store = createTraceContentStore(
      files,
      async (relative) => new TextEncoder().encode(kept.get(relative) ?? ""),
      async (relative, text) => {
        kept.set(relative, text);
      },
    );
    attachTraceContentStore(files, store);

    const spilled = await captureTraceContent({ value: `${value}!`, label: "tool-output", files, traceOptions });
    expect(spilled.contentRef?.startsWith(TRACE_CONTENT_PREFIX)).toBe(true);
    expect(isTraceContentRef(spilled.contentRef!)).toBe(true);
    expect(written).toHaveLength(1);
    expect([...kept.values()]).toEqual([`${value}!`]);
    expect((await store.read(spilled.contentRef!)).text()).toBe(`${value}!`);
    // A reference written before the store existed stays readable through it.
    expect((await store.read(legacy.contentRef!)).text()).toBe(value);
  });
});

it("unboxes primitive wrappers when values are listed, and only real wrappers", () => {
  const secret = "SECRETVALUE42";
  const options = resolveTraceOptions({ redaction: { values: [secret] } }, undefined);
  const spoofed = { [Symbol.toStringTag]: "String", field: secret };
  const retagged = Object.assign(new String(`a ${secret}`), { [Symbol.toStringTag]: "Custom" });
  const result = sanitizeTraceValue(
    { text: new String(`a ${secret}`), count: new Number(5), flag: new Boolean(false), spoofed, retagged },
    options,
  );
  expect(result.value).toEqual({
    text: "a [redacted]",
    count: 5,
    flag: false,
    spoofed: { field: "[redacted]" },
    retagged: "a [redacted]",
  });
  expect(JSON.stringify(result.value)).not.toContain(secret);
});

it("does not probe ordinary objects for boxed primitives", () => {
  // Each probe is a caught exception. Three per object made a 4 MB result take seconds.
  const options = resolveTraceOptions({ redaction: { values: ["SECRETVALUE42"] } }, undefined);
  const probe = vi.spyOn(Reflect, "apply");
  try {
    const result = sanitizeTraceValue(
      { rows: [{ id: 1, tags: ["a"], meta: { ok: true } }], when: new Date(0), url: new URL("https://example.test/"), map: new Map() },
      options,
    );
    expect(probe).not.toHaveBeenCalled();
    expect(result.redacted).toBe(false);
  } finally {
    probe.mockRestore();
  }
});
