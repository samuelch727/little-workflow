import { describe, expect, it, vi } from "vitest";
import { bundleToHarnessOptions, littledb } from "./index.js";
import type { ConfigBundle } from "../contract.js";

const BUNDLE: ConfigBundle = {
  prompt: "You are the managed agent.",
  skills: ["search", "summarize"],
  toolManifest: {},
  modelSlot: "deepseek-chat",
  sampling: {},
  hyperparams: {},
  memoryPolicy: {},
};

const BUNDLE_NO_SKILLS: ConfigBundle = {
  ...BUNDLE,
  skills: [],
};

describe("bundleToHarnessOptions", () => {
  it("maps prompt→system and resolves the model slot via modelFor", () => {
    const model = { id: "deepseek-chat" };
    // Use a skills-free bundle so no skillFor is needed
    const opts = bundleToHarnessOptions(BUNDLE_NO_SKILLS, { modelFor: (slot) => (slot === "deepseek-chat" ? (model as never) : undefined) });
    expect(opts.system).toBe("You are the managed agent.");
    expect(opts.model).toBe(model);
  });

  it("maps skills via skillFor when provided", () => {
    const opts = bundleToHarnessOptions(BUNDLE, {
      modelFor: () => ({} as never),
      skillFor: (name) => ({ name } as never),
    });
    expect(opts.skills).toEqual([{ name: "search" }, { name: "summarize" }]);
  });

  it("throws a clear error when the model slot can't be resolved", () => {
    expect(() => bundleToHarnessOptions(BUNDLE_NO_SKILLS, { modelFor: () => undefined })).toThrow(/model slot/i);
  });

  it("returns empty skills array when bundle has no skills and skillFor is omitted", () => {
    const opts = bundleToHarnessOptions(BUNDLE_NO_SKILLS, { modelFor: () => ({} as never) });
    expect(opts.skills).toEqual([]);
  });

  it("throws a clear error naming the skills when bundle has skills but skillFor is omitted", () => {
    expect(() => bundleToHarnessOptions(BUNDLE, { modelFor: () => ({} as never) })).toThrow(/skillFor/i);
    expect(() => bundleToHarnessOptions(BUNDLE, { modelFor: () => ({} as never) })).toThrow(/search/);
    expect(() => bundleToHarnessOptions(BUNDLE, { modelFor: () => ({} as never) })).toThrow(/summarize/);
  });
});

describe("littledb().outcomeSink", () => {
  it("routes a harness outcome to POST /api/outcomes, keyed to the trace reporter's run id", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://cp/api/outcomes");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        runId: "harness_slack:T1",
        status: "failure",
        metadata: { sessionId: "slack:T1", promptHash: "a".repeat(64) },
      });
      return Response.json({ ok: true });
    });

    const db = littledb({
      controlPlaneUrl: "http://cp",
      engineUrl: "http://engine",
      harnessId: "support",
      projectKey: "k",
      modelFor: () => ({}) as never,
      fetchImpl: fetchImpl as never,
    });

    const result = await db.outcomeSink.deliver({
      eventId: "evt_1",
      sequence: 3_000_000_000_000_042,
      sessionId: "slack:T1",
      timestamp: "2026-08-07T00:00:00.000Z",
      status: "failure",
      source: "chat-sdk",
      promptHash: "a".repeat(64),
      metadata: {},
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true });
  });
});
