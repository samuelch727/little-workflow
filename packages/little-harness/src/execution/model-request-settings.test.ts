import { describe, expect, it } from "vitest";
import { modelRequestSettings } from "./model-request-settings.js";

describe("modelRequestSettings", () => {
  it("preserves empty activeTools arrays as a request-shaping setting", () => {
    expect(modelRequestSettings({ activeTools: [] })).toEqual({ activeTools: [] });
    expect(modelRequestSettings({ activeTools: ["lookup", "bash", "lookup"] })).toEqual({
      activeTools: ["bash", "lookup"],
    });
  });

  it("canonicalizes common object toolChoice shapes to stable string values", () => {
    expect(modelRequestSettings({ toolChoice: "none" }, { toolChoice: { type: "none" } })).toEqual({
      toolChoice: "none",
    });
    expect(modelRequestSettings({ toolChoice: "required" }, { toolChoice: { type: "required" } })).toEqual({
      toolChoice: "required",
    });
    expect(modelRequestSettings({ toolChoice: "auto" }, { toolChoice: { type: "auto" } })).toEqual({
      toolChoice: "auto",
    });
  });
});
