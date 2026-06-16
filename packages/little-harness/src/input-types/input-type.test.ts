import { z } from "zod";
import { describe, expect, it } from "vitest";
import { inputType } from "./input-type.js";

describe("inputType", () => {
  it("keeps descriptions and validates inputs", () => {
    const type = inputType({
      description: "Triage one support ticket.",
      inputSchema: z.object({ id: z.string() }),
      toMessages: ({ input }) => [{ role: "user", content: input.id }],
    });

    expect(type.description).toBe("Triage one support ticket.");
    expect(type.inputSchema?.parse({ id: "t1" })).toEqual({ id: "t1" });
  });
});
