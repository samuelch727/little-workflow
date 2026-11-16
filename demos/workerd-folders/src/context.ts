import type { HarnessEvent } from "@little-stack/harness";
import type { scriptedModel } from "./model.js";

/** Trusted application data, built by the router. Never accepted from a message body. */
export type ChatContext = {
  env: { createModel: typeof scriptedModel; privateToken: string };
  chatSessionId: string;
  onResult: (result: { chatSessionId: string; count: number }) => void;
  onEvent: (event: HarnessEvent) => void;
};
