import { expect, it } from "vitest";
import { dynamicWorkflows } from "./dynamic-workflow.js";

it("returns an enabled config carrying the factory", () => {
  const config = dynamicWorkflows();
  expect(config.enabled).toBe(true);
  expect(typeof config.factory.compile).toBe("function");
  expect(config.exclude).toBeUndefined();
});

it("passes through exclude and limits", () => {
  const config = dynamicWorkflows({ exclude: ["danger"], limits: { maxRuntimeMs: 60_000 } });
  expect(config.exclude).toEqual(["danger"]);
  expect(config.limits).toEqual({ maxRuntimeMs: 60_000 });
});

it("passes a registry through and keeps the factory's define", () => {
  const registry = { resolve: (records: readonly unknown[]) => records as never };
  const config = dynamicWorkflows({ registry, world: () => ({}) as never });
  expect(config.registry).toBe(registry);
  expect(typeof config.factory.define).toBe("function");
  expect(dynamicWorkflows()).not.toHaveProperty("registry");
});
