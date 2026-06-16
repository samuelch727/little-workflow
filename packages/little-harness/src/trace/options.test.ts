import { describe, expect, it } from "vitest";
import { resolveTraceOptions } from "./options.js";

describe("resolveTraceOptions", () => {
  it("defaults to bounded trace capture with schema validation enabled", () => {
    expect(resolveTraceOptions(undefined, undefined)).toEqual({
      enabled: true,
      schemaVersion: "lh.trace.v2",
      content: {
        previewBytes: 512,
        maxInlineBytes: 16 * 1024,
        captureReasoning: true,
        captureModelMessages: true,
        captureToolInputs: true,
        captureToolOutputs: true,
      },
      fileDiffs: {
        enabled: true,
        maxInlineBytes: 8 * 1024,
        maxBytesToDiff: 256 * 1024,
      },
      redaction: {
        paths: [],
        metadataKeys: ["apiKey", "authorization", "cookie", "set-cookie", "token", "password", "secret"],
      },
    });
  });

  it("lets per-run trace options override harness defaults", () => {
    const resolved = resolveTraceOptions(
      { content: { previewBytes: 64 }, fileDiffs: { enabled: false } },
      { content: { maxInlineBytes: 2048 } },
    );

    expect(resolved.enabled).toBe(true);
    expect(resolved.content.previewBytes).toBe(64);
    expect(resolved.content.maxInlineBytes).toBe(2048);
    expect(resolved.fileDiffs.enabled).toBe(false);
  });

  it("disables trace persistence when either level is false", () => {
    expect(resolveTraceOptions(false, undefined).enabled).toBe(false);
    expect(resolveTraceOptions(undefined, false).enabled).toBe(false);
  });

  it("keeps resolved disabled harness trace options disabled", () => {
    const harnessTrace = resolveTraceOptions(false, undefined);

    expect(resolveTraceOptions(harnessTrace, undefined).enabled).toBe(false);
    expect(resolveTraceOptions(harnessTrace, { content: { previewBytes: 32 } }).enabled).toBe(false);
  });

  it("keeps default redaction keys when custom keys are added", () => {
    expect(
      resolveTraceOptions({ redaction: { metadataKeys: ["customerId"] } }, undefined).redaction
        .metadataKeys,
    ).toEqual([
      "apiKey",
      "authorization",
      "cookie",
      "set-cookie",
      "token",
      "password",
      "secret",
      "customerId",
    ]);
  });
});
