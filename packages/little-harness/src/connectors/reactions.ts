import { sha256Hex } from "../ids.js";
import { reportHarnessOutcome } from "../outcomes/record.js";
import type { HarnessOutcomeStatus } from "../outcomes/types.js";
import type { Harness } from "../types.js";
import type {
  ChatSdkEmoji,
  ChatSdkReactionEvent,
  ChatSdkReactionOutcomeOptions,
} from "./descriptors.js";

/** Reaction names read as "this reply was good". Covers normalized and raw platform spellings. */
export const DEFAULT_POSITIVE_REACTIONS = ["thumbs_up", "thumbsup", "+1", "👍"] as const;
/** Reaction names read as "this reply was bad". */
export const DEFAULT_NEGATIVE_REACTIONS = ["thumbs_down", "thumbsdown", "-1", "👎"] as const;

/**
 * Classify a reaction into an outcome status, or `undefined` for every emoji that is not a
 * configured verdict (a 🎉 is not feedback and must not enter the sample).
 *
 * Both the normalized emoji name and the raw platform emoji are considered, because adapters
 * differ: Slack sends `+1`, Google Chat sends `👍`, and the SDK normalizes both to `thumbs_up`
 * only when it knows the mapping.
 */
export function classifyReaction(
  event: ChatSdkReactionEvent,
  options: ChatSdkReactionOutcomeOptions = {},
): HarnessOutcomeStatus | undefined {
  const positive = normalizeAll(options.positive ?? DEFAULT_POSITIVE_REACTIONS);
  const negative = normalizeAll(options.negative ?? DEFAULT_NEGATIVE_REACTIONS);
  for (const candidate of reactionNames(event)) {
    if (positive.has(candidate)) return "success";
    if (negative.has(candidate)) return "failure";
  }
  return undefined;
}

/** Every spelling of the reacted emoji this classifier is willing to look at. */
export function reactionNames(event: ChatSdkReactionEvent): string[] {
  const names = [emojiName(event.emoji), event.rawEmoji]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map(normalize);
  return [...new Set(names)];
}

function emojiName(emoji: ChatSdkEmoji | undefined): string | undefined {
  if (emoji === undefined) return undefined;
  if (typeof emoji === "string") return emoji;
  if (typeof emoji.name === "string" && emoji.name.length > 0) return emoji.name;
  try {
    return String(emoji);
  } catch {
    return undefined;
  }
}

function normalize(value: string): string {
  // Slack-style `:+1:` and `thumbs_up` must compare equal to the configured names.
  return value.trim().replace(/^:+|:+$/gu, "").toLowerCase();
}

function normalizeAll(values: readonly string[]): Set<string> {
  return new Set(values.map(normalize));
}

/**
 * The reporter identity written to the trace: `anon_<16 hex of sha256(platform:userId)>`.
 *
 * A reaction carries a real person on every chat platform, and a raw handle in an append-only
 * trace is a handle forever. This is a stable pseudonym instead — enough to tell two raters
 * apart and to recognise the same rater toggling their own reaction, and nothing else. It is
 * not reversible from the trace, though it IS enumerable by anyone who already holds the
 * platform's user-id list, which is why no display name, handle, or message text is stored
 * alongside it.
 */
export function pseudonymousReporterId(platform: string, userId: string): string {
  return `anon_${sha256Hex(`${platform}:${userId}`).slice(0, 16)}`;
}

export type ReactionOutcomeHandlerOptions = {
  harness: Harness<any, any>;
  adapterName: string;
  reactions?: ChatSdkReactionOutcomeOptions;
};

/**
 * Build the `chat.onReaction` handler that turns a thumbs up/down into an `outcome.reported`
 * trace event on the session behind that thread.
 *
 * The handler NEVER throws and never rejects: a reaction is an observation about a run that
 * already finished, so a failure to record it must not surface as an error in the chat
 * platform's event loop.
 */
export function createReactionOutcomeHandler(
  options: ReactionOutcomeHandlerOptions,
): (event: ChatSdkReactionEvent) => Promise<void> {
  const reactions = options.reactions ?? {};
  return async (event) => {
    try {
      const status = classifyReaction(event, reactions);
      if (status === undefined) return;

      // The bot reacting to itself is not user feedback.
      if (event.user?.isMe === true) return;
      // A reaction on a message the ASSISTANT did not write grades the user's own words, not
      // the agent's. When the platform does not attach the message, the reaction is kept (the
      // message id is recorded so a later reader can re-attribute it).
      if (event.message?.author !== undefined && event.message.author.isMe !== true) return;

      const retracted = event.added === false;
      if (retracted && (reactions.onRemoved ?? "retract") === "ignore") return;

      const threadId = event.threadId ?? event.thread?.id;
      if (threadId === undefined) return;

      const context = { adapterName: options.adapterName };
      // A custom resolver OWNS the mapping: `undefined` from it means "this thread is not one
      // I can attribute", which must skip — not silently fall back to the default session id.
      const sessionId = reactions.session
        ? await reactions.session(event, context)
        : `${options.adapterName}:${threadId}`;
      if (sessionId === undefined) return;

      const defaultReporter = pseudonymousReporterId(
        options.adapterName,
        event.user?.userId ?? "unknown",
      );
      const reporter = reactions.reporterId
        ? reactions.reporterId(event, context)
        : defaultReporter;
      // The dedupe key always carries a pseudonym — even when the app chose to store none —
      // so two raters on the same message stay distinct subjects instead of overwriting
      // each other. It is the same pseudonym class, so this stores no additional identity.
      const reportKey = `chat-sdk:${options.adapterName}:${threadId}:${event.messageId}:${reporter ?? defaultReporter}`;

      const result = await reportHarnessOutcome({
        harness: options.harness,
        sessionId,
        status,
        source: "chat-sdk",
        reportKey,
        ...(retracted ? { retracted: true } : {}),
        ...(reporter === undefined ? {} : { reporter }),
        ...(reactions.sinks === undefined ? {} : { sinks: reactions.sinks }),
        metadata: {
          surface: {
            platform: options.adapterName,
            threadId,
            messageId: event.messageId,
            reaction: reactionNames(event)[0] ?? null,
            added: event.added !== false,
          },
        },
      });

      try {
        await reactions.onOutcome?.(result, event);
      } catch {
        /* Outcome observers must not break the platform's reaction handler. */
      }
    } catch {
      /* An outcome is an observation, never a gate: swallow everything. */
    }
  };
}
