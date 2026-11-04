import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { streamHarness } from "@little-stack/harness";
import type { ChatSdkChatConstructor, LoadedChatSdkConnector } from "@little-stack/harness/connectors";
import { loadChatSdkConnector } from "@little-stack/harness/connectors";
import { librarianLittleDb } from "./littledb";

export const librarianAgentDir = dirname(fileURLToPath(import.meta.url));

export type LoadLibrarianOptions = {
  /** Swap in an in-memory Chat SDK double so the demo runs with no platform at all. */
  readonly createChat?: ChatSdkChatConstructor;
};

/**
 * Load the Librarian's chat connector.
 *
 * The LittleDB version is applied per session by the harness's own `turnOptions` hook (see
 * `agent.ts`), so the connector needs nothing for it. The `streamHarness` wrapper only makes
 * the end of a turn a flush point: traces are queued and sent in the background, and a
 * short-lived driver would otherwise lose the last ones.
 */
export async function loadLibrarianConnector(
  options: LoadLibrarianOptions = {},
): Promise<LoadedChatSdkConnector<unknown>> {
  const db = librarianLittleDb();

  return loadChatSdkConnector({
    agentDir: librarianAgentDir,
    connector: "slack",
    ...(options.createChat === undefined ? {} : { createChat: options.createChat }),
    ...(db === undefined
      ? {}
      : {
          streamHarness: (streamOptions) => {
            const result = streamHarness(streamOptions);
            void result.finished.then(() => db.flush()).catch(() => undefined);
            return result;
          },
        }),
  });
}
