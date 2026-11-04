import type { HarnessWorkflowRunContext } from "@little-stack/harness";
import { localWorld } from "./authoring.js";
import { virtualWorld } from "./world.js";
import type { World } from "./world-port.js";

/** Internal default for adapters that have not been given an explicit World. */
export function defaultWorldForHarness(ctx: Pick<HarnessWorkflowRunContext, "persistence">): World {
  const { dataDir, fs } = ctx.persistence;
  return fs === undefined ? localWorld({ dataDir }) : virtualWorld({ fs, dataDir });
}
