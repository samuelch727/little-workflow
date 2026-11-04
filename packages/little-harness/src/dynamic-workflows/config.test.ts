import { describe, expect, it } from "vitest";
import { HarnessInputError } from "../errors.js";
import { resolveDynamicWorkflows, DEFAULT_DYNAMIC_WORKFLOW_LIMITS } from "./config.js";

const factory = { compile: () => ({ ok: false as const, causeCode: "plan_invalid" as const, message: "x" }) };

describe("resolveDynamicWorkflows", () => {
  it("returns undefined when absent", () => {
    expect(resolveDynamicWorkflows(undefined)).toBeUndefined();
  });
  it("resolves defaults from an enabled config", () => {
    const resolved = resolveDynamicWorkflows({ enabled: true, factory });
    expect(resolved?.limits).toEqual(DEFAULT_DYNAMIC_WORKFLOW_LIMITS);
    // Only the two enforced knobs exist: maxSteps (factory cap) and maxRuntimeMs (run timeout).
    expect(DEFAULT_DYNAMIC_WORKFLOW_LIMITS).toEqual({ maxSteps: 8, maxRuntimeMs: 120_000 });
    expect(resolved?.exclude).toEqual([]);
    expect(resolved?.factory).toBe(factory);
  });
  it("merges partial limits and exclude", () => {
    const resolved = resolveDynamicWorkflows({ enabled: true, factory, exclude: ["d"], limits: { maxRuntimeMs: 60_000 } });
    expect(resolved?.limits.maxRuntimeMs).toBe(60_000);
    expect(resolved?.limits.maxSteps).toBe(8);
    expect(resolved?.exclude).toEqual(["d"]);
  });
  it("keeps extra model slots and refuses 'default' or an unusable slot name", () => {
    const fast = { modelId: "fast" };
    expect(resolveDynamicWorkflows({ enabled: true, factory, models: { fast } })?.models).toEqual({ fast });
    expect(resolveDynamicWorkflows({ enabled: true, factory })?.models).toBeUndefined();
    expect(() => resolveDynamicWorkflows({ enabled: true, factory, models: { default: fast } })).toThrow(
      /'default' cannot be a model slot name/u,
    );
    expect(() => resolveDynamicWorkflows({ enabled: true, factory, models: { "two words": fast } })).toThrow(HarnessInputError);
  });
  it("keeps a registry and refuses one whose hooks are not functions", () => {
    const registry = { resolve: (records: readonly unknown[]) => records as never };
    expect(resolveDynamicWorkflows({ enabled: true, factory, registry })?.registry).toBe(registry);
    expect(resolveDynamicWorkflows({ enabled: true, factory })).not.toHaveProperty("registry");
    expect(() => resolveDynamicWorkflows({ enabled: true, factory, registry: { resolve: "all" } as never })).toThrow(
      /registry must be an object/u,
    );
    expect(() => resolveDynamicWorkflows({ enabled: true, factory, registry: null as never })).toThrow(HarnessInputError);
  });
  it("throws a clear error when enabled without a factory (bare true)", () => {
    expect(() => resolveDynamicWorkflows({ enabled: true } as never)).toThrow(HarnessInputError);
    expect(() => resolveDynamicWorkflows(true as never)).toThrow(/dynamicWorkflows\(\)/);
  });
  it("rejects non-positive-integer limits (a bad value would disable the cap)", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveDynamicWorkflows({ enabled: true, factory, limits: { maxSteps: bad } as never })).toThrow(HarnessInputError);
      expect(() => resolveDynamicWorkflows({ enabled: true, factory, limits: { maxRuntimeMs: bad } as never })).toThrow(HarnessInputError);
    }
  });
});
