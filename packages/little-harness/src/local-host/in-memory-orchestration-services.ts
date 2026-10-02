import type { HarnessOrchestrationServices } from "../types.js";
import {
  createDurableOrchestrationServices,
  type LocalHarnessDurableServicesFaultInjection,
} from "./durable-services.js";
import { createInMemoryDurableStore, type DurableJsonStore } from "./durable-store.js";

export type InMemoryOrchestrationServicesOptions = {
  /** Share one backend between facades by passing the same store to each. */
  readonly store?: DurableJsonStore;
  /** Opaque path-key prefix for the ledger collections; never touches the filesystem. */
  readonly rootDir?: string;
  readonly faultInjection?: LocalHarnessDurableServicesFaultInjection;
};

/** In-memory orchestration services: the reference ledger semantics over a Map-backed store. */
export function createInMemoryOrchestrationServices(
  options: InMemoryOrchestrationServicesOptions = {},
): HarnessOrchestrationServices {
  return createDurableOrchestrationServices({
    rootDir: options.rootDir ?? "/in-memory",
    store: options.store ?? createInMemoryDurableStore(),
    ...(options.faultInjection === undefined ? {} : { faultInjection: options.faultInjection }),
  });
}
