import { expectTypeOf, test } from "vitest";
import type { DynamicWorkflowFactory, DynamicWorkflowsConfig } from "./types.js";

test("DynamicWorkflowsConfig carries an enabled flag and a factory", () => {
  expectTypeOf<DynamicWorkflowsConfig["enabled"]>().toEqualTypeOf<true>();
  expectTypeOf<DynamicWorkflowsConfig["factory"]>().toEqualTypeOf<DynamicWorkflowFactory>();
});
