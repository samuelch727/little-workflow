import { describe, expect, it } from "vitest";
import { ConfigBundleSchema, ResolveConfigResponseSchema, ReportOutcomeSchema } from "./contract.js";

describe("wire contract", () => {
  it("exports the three schemas with their expected top-level fields", () => {
    expect(Object.keys(ConfigBundleSchema.shape).sort()).toEqual(
      ["hyperparams", "memoryPolicy", "modelSlot", "prompt", "sampling", "skills", "toolManifest"],
    );
    expect(Object.keys(ResolveConfigResponseSchema.shape).sort()).toEqual(
      ["channel", "config", "configVersionId", "staleConfig"],
    );
    expect(Object.keys(ReportOutcomeSchema.shape).sort()).toEqual(
      ["detail", "metadata", "runId", "score", "status"],
    );
  });
});
