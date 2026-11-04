import type { ModelMessage, PrepareStepFunction } from "ai";

/**
 * Messages that arrive while a turn runs. Before each model step the turn takes what has arrived
 * and the model reads it as the person's words, after what it had already seen.
 */
type InboxEntry = string | { readonly messageId: string; readonly text: string; readonly at?: number };
type InboxStep = { readonly stepNumber: number; readonly at: number };
export type HarnessInbox = {
  /** Returns the messages that arrived since the last call, and forgets them. */
  take(context?: InboxStep): readonly InboxEntry[] | Promise<readonly InboxEntry[]>;
  /** Restore only already-claimed arrivals before a completed first-response replay probe. */
  replay?(context: InboxStep): readonly InboxEntry[] | Promise<readonly InboxEntry[]>;
  /** Required checkpoint after the model request is durable, before provider invocation. */
  modelRequested?(context: { readonly stepNumber: number; readonly occurrenceId: string }): void | Promise<void>;
  /** Required checkpoint after the actual model response is durable. */
  modelResponded?(context: { readonly stepNumber: number; readonly occurrenceId: string }): void | Promise<void>;
};

/**
 * Wraps a turn's prepareStep so each step's messages include what arrived in the inbox, at the
 * place in the conversation where it arrived. AI SDK rebuilds each step's messages from the
 * turn's own, so arrivals are placed again on every step, and `withArrived` places them in the
 * conversation a parked turn saves.
 */
export function inboxPrepareStep<T extends PrepareStepFunction<any>>(
  prepareStep: T,
  inbox: HarnessInbox | undefined,
): { readonly prepareStep: T; readonly withArrived: (messages: ModelMessage[]) => ModelMessage[]; readonly restore: (step: InboxStep) => Promise<void> } {
  if (inbox === undefined) return { prepareStep, withArrived: (messages) => messages, restore: async () => undefined };
  const arrived: Array<{ readonly at: number; readonly message: ModelMessage }> = [];
  const identified = new Set<string>();
  const withArrived = (messages: ModelMessage[]) => {
    const out = [...messages];
    // From the last to the first, so earlier places stay put; same-place arrivals keep their order.
    for (const { at, message } of [...arrived].reverse()) out.splice(Math.min(at, out.length), 0, message);
    return out;
  };
  const add = (entries: readonly InboxEntry[], at: number) => {
    for (const item of entries) {
      const text = typeof item === "string" ? item : item.text;
      if (typeof item !== "string") { if (identified.has(item.messageId)) continue; identified.add(item.messageId); }
      if (text.trim().length > 0) arrived.push({ at: typeof item === "string" ? at : item.at ?? at, message: { role: "user", content: text } });
    }
  };
  const restore = async (step: InboxStep) => add(await inbox.replay?.(step) ?? [], step.at);
  const wrapped = (async (event: Parameters<T>[0]) => {
    const result = await prepareStep(event);
    add(await inbox.take({ stepNumber: event.stepNumber ?? 0, at: event.messages.length }), event.messages.length);
    if (arrived.length === 0) return result;
    return { ...result, messages: withArrived(result?.messages ?? event.messages) };
  }) as unknown as T;
  return { prepareStep: wrapped, withArrived, restore };
}
