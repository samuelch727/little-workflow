import { afterEach } from "vitest";
import { closeEventStoresForTest } from "./world.js";

// The orchestrator surface is deprecated but still supported, so a large share of the suite
// exercises it on purpose. `process.noDeprecation` is Node's own switch for silencing
// DeprecationWarning output (the same thing `node --no-deprecation` sets) and keeps the notice
// out of test stderr without weakening it for real callers. Our code still *calls*
// `process.emitWarning`, so orchestrator-deprecation.test.ts can spy on it and assert the
// warning fires exactly once per process.
process.noDeprecation = true;

afterEach(() => {
  closeEventStoresForTest();
});
