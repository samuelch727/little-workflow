/**
 * The suite's hermeticity guarantee, installed before ANY test module is imported.
 *
 * Two things have to be true on a bare CI runner and on a developer laptop alike, and this
 * file is the only place early enough to make both true.
 *
 * 1. No credential is ever required. `workflows/*.ts` resolve their model at MODULE level —
 *    `export default asHarnessWorkflow(createXWorkflow(dreamerModel()), …)` — because that
 *    default export is what `discoverWorkflows` loads. A test file that imports one of those
 *    modules statically (`workflows.test.ts` does) therefore calls `dreamerModel()` during
 *    import, before any `beforeAll` can run. Installing the `globalThis` model seam here
 *    short-circuits that (`dreamerModel()` returns the override without touching
 *    `DEEPSEEK_API_KEY`), which is the same seam `preload-mock-model.mjs` installs for the
 *    driver's child processes — the in-process analogue of the same trick.
 *
 * 2. The developer's real key is never read. `loadDreamerEnv()` only FILLS gaps — it never
 *    overwrites a variable that is already defined — so predefining a fake value shadows
 *    every `.env.local` on the machine. That matters beyond the model: `controlPlaneUrl()`,
 *    `fallbackEngineUrl()` and `projectKey()` all call `loadDreamerEnv()`, so without this
 *    line a local run would merge the real key into `process.env` and `driver.test.ts` would
 *    hand it to every child it spawns (`env: { ...process.env }`). Tests must not be able to
 *    reach a provider even by accident.
 *
 * Neither line changes live behaviour: `run.mjs` runs without this setup file, so its
 * candidate chain resolves the real key exactly as before.
 */
import type { LanguageModel } from "ai";
import { setDreamerModel } from "../../agents/dreamer/env";

process.env.DEEPSEEK_API_KEY = "test-key-never-sent";

// A stand-in, not a mock: nothing in the suite calls THIS model. Files that exercise the
// model install their own (`investigation.test.ts`, `workflows.test.ts`), and the rest only
// need the agent folder to load. Anything that did call it would fail loudly rather than
// quietly reach api.deepseek.com.
setDreamerModel({ provider: "test", modelId: "unused" } as unknown as LanguageModel);
