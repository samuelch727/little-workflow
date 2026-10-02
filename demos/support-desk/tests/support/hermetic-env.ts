/**
 * The suite's hermeticity guarantee, installed before ANY test module is imported.
 *
 * Three things have to be true on a bare CI runner and on a developer laptop alike, and a
 * vitest `setupFiles` entry is the only hook early enough to make all three true.
 *
 * 1. **No credential is ever required.** `agent.ts` resolves its model at module level
 *    (`model: supportModel()`), and that module level runs the moment `loadHarness` imports
 *    it — before any `beforeAll` could install anything. Installing the `globalThis` model
 *    seam here short-circuits it: `modelForSlot` returns the override without ever reading
 *    `DEEPSEEK_API_KEY`. This is the in-process analogue of what
 *    `tests/support/preload-mock-model.mjs` does for the driver's child processes.
 *
 * 2. **The developer's real key is never read.** `loadSupportEnv()` only FILLS gaps — it
 *    never overwrites a variable that is already defined — so predefining a fake value
 *    shadows every `.env.local` on the machine. Without this a local run would merge the
 *    real key into `process.env`, and `driver.test.ts` hands its whole environment to the
 *    children it spawns.
 *
 * 3. **No test can reach a real littleDB.** `LITTLEDB_URL=""` reads as "unset" to
 *    `supportLittleDb()` (it checks for a non-empty string), so a developer with a running
 *    local stack still gets the no-littleDB path unless a test explicitly points the URL at
 *    its own stub server.
 *
 * None of this changes live behaviour: `experiment/run.mjs` runs without this setup file, so
 * its candidate chain resolves the real key and the real stack exactly as before.
 */
import type { LanguageModel } from "ai";
import { setSupportModel } from "../../agents/support/env";

process.env.DEEPSEEK_API_KEY = "test-key-never-sent";
process.env.LITTLEDB_URL = "";

// A stand-in, not a mock: nothing in the suite calls THIS model. Files that exercise the
// agent install their own scripted one. Anything that did call this would fail loudly rather
// than quietly reach api.deepseek.com.
setSupportModel({ provider: "test", modelId: "unused" } as unknown as LanguageModel);
