import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { streamHarness } from "little-harness";
import type { ChatSdkChatConstructor, LoadedChatSdkConnector } from "little-harness/connectors";
import { loadChatSdkConnector } from "little-harness/connectors";
import { librarianLittleDb } from "./littledb";

export const librarianAgentDir = dirname(fileURLToPath(import.meta.url));

export type LoadLibrarianOptions = {
  /** Swap in an in-memory Chat SDK double so the demo runs with no platform at all. */
  readonly createChat?: ChatSdkChatConstructor;
};

/**
 * Load the Librarian's chat connector, with littleDB managed config applied PER SESSION.
 *
 * This is the whole architectural answer in one function. `createHarness` builds one
 * harness with static options and `loadChatSdkConnector` loads one agent folder, so
 * per-session config cannot come from either. It comes from the third seam:
 * `loadChatSdkConnector({ streamHarness })` replaces the per-run entry point, and
 * `StreamHarnessOptions extends HarnessAgentOptions`, whose `system` and `model`
 * `resolveTurnConfig` merges over the harness config for that run only. `onEvent` rides
 * the same options object, next to the harness-level one rather than replacing it.
 *
 * The seam is synchronous, so the async `createSessionConfig` call cannot happen here —
 * the connector's awaited `beforeRun` does it first (see `connectors/slack/connector.ts`)
 * and this wrapper only reads the resolved value.
 *
 * With `LITTLEDB_URL` unset there is no wrapper behaviour at all: `overridesFor` returns
 * `undefined` and every run is the plain harness built from `agent.ts` + `instructions.md`.
 */
export async function loadLibrarianConnector(
  options: LoadLibrarianOptions = {},
): Promise<LoadedChatSdkConnector<unknown>> {
  const db = librarianLittleDb();

  return loadChatSdkConnector({
    agentDir: librarianAgentDir,
    connector: "slack",
    ...(options.createChat === undefined ? {} : { createChat: options.createChat }),
    streamHarness: (streamOptions) => {
      const sessionId =
        typeof streamOptions.session === "string" ? streamOptions.session : streamOptions.session?.id;
      const overrides = sessionId === undefined ? undefined : db?.overridesFor(sessionId);
      const result = streamHarness(
        overrides === undefined ? streamOptions : { ...streamOptions, ...overrides },
      );
      if (db !== undefined) {
        // Belt and braces: the reporter already awaits each event as it is emitted, so the
        // eval-run upload is current; this makes the end of a turn an explicit flush point.
        void result.finished.then(() => db.flush()).catch(() => undefined);
      }
      return result;
    },
  });
}
