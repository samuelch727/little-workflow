import { createHarness, type HarnessHost } from "@little-stack/harness";
import { scriptedModel } from "../../src/model.js";
export default (host: HarnessHost) => createHarness({ host, model: scriptedModel(), system: "You are the other folder agent." });
