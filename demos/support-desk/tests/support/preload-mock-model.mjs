/**
 * A `node --import` preload that installs a stand-in agent before `experiment/run.mjs` runs.
 *
 * This is what lets the driver be tested end to end without a provider: the model seam is a
 * `globalThis` symbol (see `agents/support/env.ts`), and a preload is the one hook that runs
 * in the child process EARLY enough to set it — before jiti loads `agent.ts` and captures the
 * model. `SUPPORT_MOCK_AGENT` picks which stand-in ("oracle", "v1" or "null"); it defaults to
 * the v1 agent, since the driver's own story is a v1 traffic run.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const demoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const jiti = createJiti(join(demoRoot, "_support_preload_.js"), { interopDefault: false });

const { mockAgentModel } = await jiti.import(join(demoRoot, "tests", "support", "mock-agent.ts"));
const { setSupportModel } = await jiti.import(join(demoRoot, "agents", "support", "env.ts"));

setSupportModel(mockAgentModel(process.env.SUPPORT_MOCK_AGENT ?? "v1"));
