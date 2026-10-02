import test from "node:test";
import assert from "node:assert/strict";
import { parseVariant } from "./variant-config.mjs";

test("stub-supervisor maps to supervised workflow config", () => {
  const config = parseVariant("stub-supervisor");
  assert.deepEqual(config, {
    variant: "stub-supervisor",
    useStubPlanner: true,
    useSupervisorLoop: true,
    workflowId: "candidate.review.supervised",
    maxCycles: 3,
  });
});

test("single maps to single-cycle workflow config", () => {
  const config = parseVariant("single");
  assert.deepEqual(config, {
    variant: "single",
    useStubPlanner: false,
    useSupervisorLoop: false,
    workflowId: "candidate.review.single-cycle",
    maxCycles: 1,
  });
});

test("unknown variant throws", () => {
  assert.throws(
    () => parseVariant("invalid"),
    /Unknown variant/u,
  );
});
