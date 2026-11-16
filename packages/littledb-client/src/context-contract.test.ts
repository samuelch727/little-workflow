import { expect, it } from "vitest";
import { ResolvedModelSchema } from "./contract.js";
it("preserves optional context metadata and explicit disable across the SDK boundary", () => {
  const base = { id: "scripted", paidBy: "key", source: "project" };
  expect(ResolvedModelSchema.parse(base)).toEqual(base);
  const configured = { ...base, contextWindow: { tokens: 100000, source: "https://example.com/model", checkedAt: "2026-11-13" }, contextPolicy: { triggerTokens: 80000, keepLastTurns: 4, summaryModel: false, maxCompactionCostUsdPerSession: 0 } };
  expect(ResolvedModelSchema.parse(configured)).toEqual(configured);
  expect(ResolvedModelSchema.parse({ ...base, contextPolicy: false }).contextPolicy).toBe(false);
  expect(() => ResolvedModelSchema.parse({ ...base, contextPolicy: { triggerTokens: 20, maxCompactionCostUsdPerSession: -1 } })).toThrow();
});
