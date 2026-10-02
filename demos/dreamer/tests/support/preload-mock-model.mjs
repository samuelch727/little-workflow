/**
 * A `node --import` preload that installs the scripted mock model before `run.mjs` runs.
 *
 * This is what lets the driver be tested end to end without a provider: the model seam is a
 * `globalThis` symbol (see `agents/dreamer/env.ts`), and a preload is the one hook that runs
 * in the child process EARLY enough to set it — before jiti loads `agent.ts` and captures
 * the model. `DREAMER_STUB_CONTROL_PLANE` carries the stub's URL from the parent test.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const demoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const jiti = createJiti(join(demoRoot, "_dreamer_preload_.js"), { interopDefault: false });

const { scriptedModel } = await jiti.import(join(demoRoot, "tests", "support", "mock-model.ts"));
const { fullInvestigationTurns, workflowOutput } = await jiti.import(
  join(demoRoot, "tests", "support", "investigation-script.ts"),
);
const { setDreamerModel } = await jiti.import(join(demoRoot, "agents", "dreamer", "env.ts"));

setDreamerModel(scriptedModel({ turns: fullInvestigationTurns(), workflowOutput }));
