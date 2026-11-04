import { expectTypeOf, it } from "vitest";
import type { generateHarness } from "./generate-harness.js";
import type { streamHarness } from "./stream-harness.js";
import type { HarnessParkedResult, HarnessTurnResult, StreamHarnessTurnFinished } from "./result.js";

it("exposes parked turns through both public execution entry points", () => {
  type Generated = Awaited<ReturnType<typeof generateHarness<{ priority: number }>>>;
  type Finished = Awaited<ReturnType<typeof streamHarness>["finished"]>;
  expectTypeOf<Generated>().toEqualTypeOf<HarnessTurnResult<{ priority: number }>>();
  expectTypeOf<Finished>().toEqualTypeOf<StreamHarnessTurnFinished>();
  expectTypeOf<Extract<Generated, { status: "parked" }>>().toEqualTypeOf<HarnessParkedResult>();
  expectTypeOf<Extract<Finished, { status: "parked" }>>().toEqualTypeOf<HarnessParkedResult>();
  expectTypeOf<Extract<Generated, { status: "completed" }>["output"]>()
    .toEqualTypeOf<{ priority: number }>();
});
