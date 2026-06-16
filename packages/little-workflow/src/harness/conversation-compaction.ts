/**
 * Deterministic conversation compaction for the model loop. Long agentic loops
 * (an orchestrator fanning out many sub-runs, a worker reading many files)
 * accumulate bulky tool results that dominate the context window. This elides
 * the *content* of old tool results — keeping the tool name + args (so the model
 * still sees what it did) and the most recent turns in full.
 *
 * It MUST be a pure function of (messages, policy): the model loop records the
 * compacted message list in the request and matches it on replay, so any
 * nondeterminism (timestamps, a summarizing model call) would break resume.
 * Modelled on opencode's pruning — but summary-free, to stay replay-safe.
 *
 * NOTE: the policy is an *implicit replay invariant*. It lives in harness options,
 * not the event log, so resuming a run with a *different* policy can change the
 * compacted messages and silently miss the replay match (same fragility as the
 * model-retry config). Keep the policy stable across a run and its resumes.
 */

export type ConversationCompactionPolicy = {
  /** Compact only once the conversation's serialized size exceeds this. */
  readonly maxChars: number;
  /** Always keep this many of the most recent messages untouched. */
  readonly keepRecentMessages: number;
  /** Only elide a tool result whose serialized size exceeds this (skip the cheap ones). */
  readonly minElideChars: number;
};

export const DEFAULT_CONVERSATION_COMPACTION: ConversationCompactionPolicy = {
  // ~250k chars ≈ 60k tokens — well clear of normal runs, so this is a no-op
  // until a loop genuinely runs long.
  maxChars: 250_000,
  keepRecentMessages: 8,
  minElideChars: 500,
};

type ToolMessage = {
  readonly role: "tool";
  readonly content: {
    readonly toolName?: unknown;
    readonly args?: unknown;
    readonly result?: unknown;
    readonly toolCallId?: unknown;
  };
};

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function conversationChars(messages: readonly unknown[]): number {
  let total = 0;
  for (const message of messages) {
    total += stableStringify(message).length;
  }
  return total;
}

function isToolMessage(message: unknown): message is ToolMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { role?: unknown }).role === "tool" &&
    typeof (message as { content?: unknown }).content === "object" &&
    (message as { content?: unknown }).content !== null
  );
}

function elideToolResult(message: unknown, minElideChars: number): unknown {
  if (!isToolMessage(message)) {
    return message;
  }
  const { content } = message;
  if (!("result" in content)) {
    return message;
  }
  const serializedChars = stableStringify(content.result).length;
  if (serializedChars <= minElideChars) {
    return message;
  }
  return {
    ...message,
    content: {
      ...content,
      result: `[context-compacted: ${serializedChars} chars elided to save context; re-read via tools if needed]`,
    },
  };
}

/**
 * Return a compacted copy of the conversation, or the same array unchanged when
 * it is under budget (the common case — keeping replay byte-identical). The
 * first message (the task/goal) and the last `keepRecentMessages` are always
 * preserved in full; older oversized tool results in between are elided.
 */
export function compactConversation(
  messages: readonly unknown[],
  policy: ConversationCompactionPolicy = DEFAULT_CONVERSATION_COMPACTION,
): unknown[] {
  const asArray = messages as unknown[];
  // Nothing to gain if the whole history already fits in the recent window.
  if (messages.length <= policy.keepRecentMessages + 1) {
    return asArray;
  }
  if (conversationChars(messages) <= policy.maxChars) {
    return asArray;
  }
  const keepFrom = messages.length - policy.keepRecentMessages;
  let changed = false;
  const compacted = messages.map((message, index) => {
    if (index === 0 || index >= keepFrom) {
      return message;
    }
    const elided = elideToolResult(message, policy.minElideChars);
    if (elided !== message) {
      changed = true;
    }
    return elided;
  });
  return changed ? compacted : asArray;
}
