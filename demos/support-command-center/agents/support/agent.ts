import { createHarness, localHost } from "little-harness";
import { getSupportModel } from "./env";

export default createHarness({
  host: localHost({ dataDir: ".little-harness/support-command-center" }),
  model: getSupportModel(),
});
