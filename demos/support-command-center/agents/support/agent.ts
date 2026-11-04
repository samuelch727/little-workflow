import { createHarness, localHost } from "@little-stack/harness";
import { getSupportModel } from "./env";

export default createHarness({
  host: localHost({ dataDir: ".little-harness/support-command-center" }),
  model: getSupportModel(),
  // This agent answers email from outside the team (connectors/email), and it only needs its own
  // tools, so it gets no shell.
  runtime: { bash: false },
});
