import type { HarnessTrigger } from "../types.js";
import type { ChatSdkMessage } from "./descriptors.js";

/**
 * INTERNAL, never re-exported. A Chat SDK descriptor that knows better than the chat default how
 * its turns start keeps a function under this key: `emailConnector` names the sender and the
 * subject. `Symbol.for`, so a descriptor made by another copy of this module is still read.
 */
export const CHAT_TURN_TRIGGER = Symbol.for("little-harness.connector.turn-trigger");

export type ChatTurnTrigger = (message: ChatSdkMessage) => HarnessTrigger;

/** How a chat turn started: the descriptor's own reading, else the platform and the message's author. */
export function chatTurnTrigger(descriptor: object, adapterName: string, message: ChatSdkMessage): HarnessTrigger {
  const own = (descriptor as Record<symbol, unknown>)[CHAT_TURN_TRIGGER];
  if (typeof own === "function") {
    try {
      return (own as ChatTurnTrigger)(message);
    } catch {
      // A trigger only describes the turn; reading it must never stop one.
    }
  }
  const from = message.author?.userName || message.author?.userId;
  return { kind: "message", source: adapterName, ...(from ? { from } : {}) };
}
