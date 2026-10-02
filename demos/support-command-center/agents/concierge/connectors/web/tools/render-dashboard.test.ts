import { validateSpec } from "@json-render/core";
import { describe, expect, test } from "vitest";
import renderDashboard, { renderDashboardBase } from "./render-dashboard";

describe("render-dashboard web tool", () => {
  test("is a plain executable tool (no extendTool needed for a connector-only tool)", () => {
    expect(renderDashboard).toBe(renderDashboardBase);
    expect(renderDashboard.execute).toBeTypeOf("function");
  });

  test("execute builds a valid json-render spec and a summary", async () => {
    const output = (await renderDashboard.execute?.({ version: "v4.2.0" }, {} as never)) as {
      spec: unknown;
      summary: string;
    };
    expect(validateSpec(output.spec as never).valid).toBe(true);
    expect(output.summary).toContain("v4.2.0");
  });

  test("declares an output schema for typed UI parts", () => {
    expect(renderDashboardBase.outputSchema).toBeDefined();
  });
});
