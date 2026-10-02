import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { mountedResultPath } from "./mounts.js";

describe("mountedResultPath", () => {
  it.each([".", "..", "../x", "x/y", "x%2Fy", ""])("rejects invalid result id %s", (resultId) => {
    expect(() => mountedResultPath("/tmp/session", { resultId, resultGrantId: "grant_1" })).toThrow(
      /invalid harness result id/i,
    );
  });

  it.each([".", "..", "../x", "x/y", "x%2Fy", ""])("rejects invalid result grant id %s", (resultGrantId) => {
    expect(() => mountedResultPath("/tmp/session", { resultId: "result_1", resultGrantId })).toThrow(
      /invalid harness result grant id/i,
    );
  });

  it("returns stable durable storage paths and a resultId-keyed opaque output URI", () => {
    const sessionDataDir = join("/tmp", "little-session");
    const result = { resultId: "result_1", resultGrantId: "grant_1" };
    const first = mountedResultPath(sessionDataDir, result);
    const second = mountedResultPath(sessionDataDir, result);

    expect(second).toEqual(first);
    expect(first).toEqual({
      resultId: "result_1",
      resultGrantId: "grant_1",
      storageValuePath: resolve(sessionDataDir, "results", "result_1", "value.json"),
      storageRecordPath: resolve(sessionDataDir, "results", "result_1", "record.json"),
      outputPath: "harness-result://result_1/output",
    });
  });

  it("never embeds the result grant id in the opaque output URI", () => {
    const { outputPath } = mountedResultPath("/tmp/little-session", {
      resultId: "result_1",
      resultGrantId: "grant_secret",
    });
    expect(outputPath).toBe("harness-result://result_1/output");
    expect(outputPath).not.toContain("grant_secret");
  });
});
