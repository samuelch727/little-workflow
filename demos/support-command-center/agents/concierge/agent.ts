import { createHarness, localHost } from "little-harness";
import { getConciergeModel } from "./env";

/**
 * "Relay" — a release/ops concierge. The same agent is exposed through the Slack
 * connector (channel text) and the web connector (json-render dashboards); only
 * the connector-specific tools differ.
 */
export default createHarness({
  host: localHost({ dataDir: ".little-harness/concierge" }),
  model: getConciergeModel(),
});
