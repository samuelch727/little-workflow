import { describe, expect, it } from "vitest";
import {
  compactConversation,
  type ConversationCompactionPolicy,
} from "./conversation-compaction.js";

const POLICY: ConversationCompactionPolicy = {
  maxChars: 2_000,
  keepRecentMessages: 2,
  minElideChars: 100,
};

function userMessage(text: string): unknown {
  return { role: "user", content: { text } };
}
function assistantToolCall(toolName: string): unknown {
  return { role: "assistant", content: { toolCalls: [{ toolName, args: {} }] } };
}
function toolResult(toolName: string, result: unknown): unknown {
  return { role: "tool", content: { toolName, args: { q: 1 }, result } };
}

describe("compactConversation", () => {
  it("is a no-op when the conversation is under budget (returns the same array)", () => {
    const messages = [userMessage("goal"), assistantToolCall("bash"), toolResult("bash", "ok")];
    expect(compactConversation(messages, POLICY)).toBe(messages);
  });

  it("is a no-op when shorter than the recent window", () => {
    const big = "x".repeat(5_000);
    const messages = [userMessage("goal"), toolResult("bash", big)];
    // length (2) <= keepRecentMessages (2) + 1 → nothing old enough to elide
    expect(compactConversation(messages, POLICY)).toBe(messages);
  });

  it("elides old oversized tool results once over budget, keeping task + recent turns", () => {
    const big = "x".repeat(3_000);
    const messages = [
      userMessage("the original goal"),
      assistantToolCall("bash"),
      toolResult("bash", big), // old + oversized → elided
      assistantToolCall("read"),
      toolResult("read", big), // within keepRecentMessages (2) → kept
      assistantToolCall("write"), // recent → kept (also not a tool result)
    ];
    const compacted = compactConversation(messages, POLICY);
    expect(compacted).not.toBe(messages);

    // Task message preserved verbatim.
    expect(compacted[0]).toEqual(userMessage("the original goal"));
    // The old tool result's content was elided, but toolName + args survive.
    const elided = compacted[2] as { content: { toolName: string; args: unknown; result: unknown } };
    expect(elided.content.toolName).toBe("bash");
    expect(elided.content.args).toEqual({ q: 1 });
    expect(typeof elided.content.result).toBe("string");
    expect(elided.content.result).toContain("context-compacted");
    // The recent tool result is untouched (still the full payload).
    expect((compacted[4] as { content: { result: unknown } }).content.result).toBe(big);
  });

  it("does not elide small tool results even when over budget", () => {
    const big = "x".repeat(3_000);
    const messages = [
      userMessage("goal"),
      toolResult("a", "tiny"), // old but under minElideChars → kept
      toolResult("b", big), // old + oversized → elided (pushes over budget)
      assistantToolCall("x"),
      assistantToolCall("y"),
    ];
    const compacted = compactConversation(messages, POLICY);
    expect((compacted[1] as { content: { result: unknown } }).content.result).toBe("tiny");
    expect((compacted[2] as { content: { result: unknown } }).content.result).toContain(
      "context-compacted",
    );
  });

  it("is deterministic across equal-but-distinct inputs (the replay invariant)", () => {
    const big = "x".repeat(3_000);
    const build = () => [
      userMessage("goal"),
      assistantToolCall("bash"),
      toolResult("bash", { payload: big }), // old + oversized → elided
      assistantToolCall("read"),
      toolResult("read", big), // recent → kept
      assistantToolCall("write"),
    ];
    // On resume the message list is reconstructed from recorded events — a
    // separate but deep-equal array. It must compact byte-identically, or the
    // promptHash the loop matches on would diverge and replay would miss.
    const first = compactConversation(build(), POLICY);
    const second = compactConversation(build(), POLICY);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    // The elision placeholder depends only on the original size, never on
    // wall-clock or call order, so it is stable across runs.
    expect(JSON.stringify(first)).toContain("context-compacted");
  });

  it("is idempotent — compacting a compacted conversation changes nothing further", () => {
    const big = "x".repeat(3_000);
    const messages = [
      userMessage("goal"),
      toolResult("a", big),
      toolResult("b", big),
      assistantToolCall("x"),
      assistantToolCall("y"),
    ];
    const once = compactConversation(messages, POLICY);
    const twice = compactConversation(once, POLICY);
    expect(twice).toEqual(once);
  });
});
