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
