import { tool } from "ai";
import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";
import "./type-helpers.js";
import type { ToolInput, ToolOutput, ToolOutputPart, ToolPart, ToolUI } from "./type-helpers.js";

const lookupOrder = tool({
  description: "Look up an order.",
  inputSchema: z.object({ orderId: z.string() }),
  outputSchema: z.object({
    order: z.object({
      id: z.string(),
      status: z.enum(["pending", "shipped"]),
    }),
  }),
  execute: async ({ orderId }) => ({
    order: { id: orderId, status: "shipped" as const },
  }),
});

describe("connector type helpers", () => {
  it("infers tool input and output from a single AI SDK tool", () => {
    type LookupOrderTool = typeof lookupOrder;

    expectTypeOf<ToolInput<LookupOrderTool>>().toEqualTypeOf<{ orderId: string }>();
    expectTypeOf<ToolOutput<LookupOrderTool>>().toEqualTypeOf<{
      order: { id: string; status: "pending" | "shipped" };
    }>();
    expectTypeOf<ToolUI<LookupOrderTool>>().toEqualTypeOf<{
      input: { orderId: string };
      output: { order: { id: string; status: "pending" | "shipped" } };
    }>();
  });

  it("builds typed static tool UI parts for a named tool", () => {
    type LookupOrderTool = typeof lookupOrder;
    type LookupOrderPart = ToolPart<"lookup-order", LookupOrderTool>;
    type LookupOrderOutputPart = ToolOutputPart<"lookup-order", LookupOrderTool>;

    expectTypeOf<LookupOrderPart["type"]>().toEqualTypeOf<"tool-lookup-order">();
    expectTypeOf<LookupOrderOutputPart>().toMatchTypeOf<LookupOrderPart>();
    expectTypeOf<LookupOrderOutputPart["state"]>().toEqualTypeOf<"output-available">();
    expectTypeOf<LookupOrderOutputPart["input"]>().toEqualTypeOf<{ orderId: string }>();
    expectTypeOf<LookupOrderOutputPart["output"]>().toEqualTypeOf<{
      order: { id: string; status: "pending" | "shipped" };
    }>();
  });
});
