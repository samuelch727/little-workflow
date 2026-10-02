import { MockLanguageModelV3 } from "ai/test";
import {
  ESCALATION_AMOUNT_LIMIT,
  EXCHANGE_WINDOW_DAYS,
  MAX_VERIFICATION_ATTEMPTS,
  PARTIAL_REFUND_RATE,
  REFUND_WINDOW_DAYS,
  money,
} from "../../agents/support/policy.mjs";
import { usage } from "./mock-model";

/**
 * Three deterministic stand-in agents, so the eval set can be proved falsifiable without a
 * provider.
 *
 *   "oracle"  follows `policy.md` exactly.
 *   "v1"      follows `experiment/prompt-v1.md` exactly — window from PURCHASE, no
 *             verification, full refunds, exchanges on request, escalate only if asked.
 *   "null"    answers in prose and never calls a tool.
 *
 * Why this is worth building rather than scripting fixed step lists. An eval set is only
 * meaningful if a compliant agent can actually score 100% on it and a non-compliant one
 * cannot: the first is what separates a hard task from an IMPOSSIBLE one (the kb-chatbot
 * experiment's "every answer is reachable" rule, restated for actions), and the second is
 * what proves the trap is a trap rather than a set of scenarios everything fails. Both are
 * asserted in `tests/scenarios.test.ts`, over the whole set, in seconds.
 *
 * The null agent is the third leg: `evals-research-synthesis-2026-08.md` §7 requires that a
 * canary which claims success without acting scores zero — τ-bench itself counted empty
 * responses as successes (arXiv:2507.02825).
 *
 * These agents read the conversation the way a model does — the serialized prompt, including
 * the tool results of earlier steps and earlier turns — and hold no state of their own. That
 * is deliberate: state would let them "remember" things a real model would have to re-derive,
 * and the point is to model what the prompt makes derivable.
 */

export type MockAgentMode = "oracle" | "v1" | "null";

type Content =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string };

type LookupResult = {
  found?: boolean;
  orderId?: string;
  amount?: number;
  status?: string;
  daysSincePurchase?: number;
  daysSinceDelivery?: number | null;
  opened?: boolean;
  finalSale?: boolean;
  alreadyRefunded?: boolean;
  emailMatches?: boolean;
};

const EMAIL = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/;
const ORDER = /ORD-\d+/;

/** What the customer is asking for. Address before exchange: "send it to X" is not a swap. */
export function askOf(text: string): "refund" | "exchange" | "address" {
  if (/\b(address|moved|send it to|go to)\b/i.test(text)) return "address";
  if (/\b(replacement|replacements|exchange|swap)\b/i.test(text)) return "exchange";
  return "refund";
}

function disputed(text: string): boolean {
  return /\b(did ?n[o']t (authorise|authorize|place)|never (authorised|authorized)|card issuer|charge ?back|used my details)\b/i.test(
    text,
  );
}

function newAddressIn(text: string): string | undefined {
  return /(?:send it to|go to)\s+(.+?)\s+instead/i.exec(text)?.[1];
}

/**
 * The customer's own words, without the assistant's.
 *
 * The prompt carries both, and several of the signals here — the email to verify, whether a
 * charge is disputed — are only meaningful when the CUSTOMER said them. Reading the whole
 * blob would let the agent "detect a dispute" in its own earlier apology.
 */
function userText(prompt: unknown): string {
  const messages = Array.isArray(prompt) ? prompt : [];
  const parts: string[] = [];
  for (const message of messages as Array<{ role?: string; content?: unknown }>) {
    if (message.role !== "user") continue;
    if (typeof message.content === "string") parts.push(message.content);
    else if (Array.isArray(message.content)) {
      for (const part of message.content as Array<{ type?: string; text?: string }>) {
        if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
      }
    }
  }
  return parts.join("\n");
}

/** The most recent `lookup_order` result in the conversation, if the agent has called it. */
function lastLookup(prompt: unknown): LookupResult | undefined {
  const serialized = JSON.stringify(prompt) ?? "";
  const marker = /\{"found":(?:true|false)[^]*?\}/g;
  let found: LookupResult | undefined;
  for (const match of serialized.matchAll(marker)) {
    try {
      found = JSON.parse(match[0]) as LookupResult;
    } catch {
      /* a partial match — keep the last one that parsed. */
    }
  }
  return found;
}

/**
 * How many times verification has failed in this conversation.
 *
 * Two spellings, because the two places the evidence lives spell it differently: the LIVE
 * tool result the model is looking at right now says `emailMatches`, and the carried-forward
 * record of an earlier turn (`runEpisode`'s turn parts, built from the action log) says
 * `emailVerified`. Counting only one of them is how the two-strike rule silently never fires.
 */
function countFailedVerifications(prompt: unknown): number {
  const serialized = JSON.stringify(prompt) ?? "";
  const live = (serialized.match(/"emailMatches":false/g) ?? []).length;
  const remembered = (serialized.match(/"emailVerified":false/g) ?? []).length;
  return live + remembered;
}

function alreadyRecordedOutcome(prompt: unknown): boolean {
  const serialized = JSON.stringify(prompt) ?? "";
  return /"(refundId|exchangeId|escalationId|declineId)":/.test(serialized);
}

function toolCall(toolName: string, input: unknown, step: number): Content {
  return { type: "tool-call", toolCallId: `mock_${step}`, toolName, input: JSON.stringify(input) };
}

function oracleStep(prompt: unknown, step: number): { content: Content[]; done: boolean } {
  const said = userText(prompt);
  const orderId = ORDER.exec(said)?.[0];
  const email = EMAIL.exec(said)?.[0];
  const lookup = lastLookup(prompt);

  if (orderId === undefined) {
    return { content: [{ type: "text", text: "Could you give me the order number?" }], done: true };
  }

  // Policy §5: an outcome is recorded once. A customer pressing a settled request gets an
  // explanation, not a second row in the ledger.
  if (alreadyRecordedOutcome(prompt)) {
    return {
      content: [{ type: "text", text: "I've already recorded that outcome — the policy is the same." }],
      done: true,
    };
  }

  if (lookup === undefined || lookup.orderId !== orderId) {
    return {
      content: [toolCall("lookup_order", { orderId, ...(email === undefined ? {} : { email }) }, step)],
      done: false,
    };
  }
  if (lookup.found === false) {
    return { content: [{ type: "text", text: `I can't find ${orderId}.` }], done: true };
  }

  // §4 first: escalation triggers beat everything, and neither needs verification.
  if (disputed(said)) {
    return {
      content: [
        toolCall(
          "escalate",
          { orderId, category: "charge-dispute", reason: "Customer disputes the charge." },
          step,
        ),
      ],
      done: true,
    };
  }
  if ((lookup.amount ?? 0) > ESCALATION_AMOUNT_LIMIT) {
    return {
      content: [
        toolCall(
          "escalate",
          { orderId, category: "amount-over-limit", reason: `Order is over $${ESCALATION_AMOUNT_LIMIT}.` },
          step,
        ),
      ],
      done: true,
    };
  }

  // §1: verification, and the two-strike rule.
  if (lookup.emailMatches !== true) {
    if (countFailedVerifications(prompt) >= MAX_VERIFICATION_ATTEMPTS) {
      return {
        content: [
          toolCall(
            "escalate",
            { orderId, category: "verification-failed", reason: "Two failed verification attempts." },
            step,
          ),
        ],
        done: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: "I can't match that to the account. Could you confirm the email address on the order?",
        },
      ],
      done: true,
    };
  }

  const delivered = lookup.daysSinceDelivery !== null && lookup.daysSinceDelivery !== undefined;
  const decline = (reason: string, explanation: string) => ({
    content: [toolCall("decline_request", { orderId, reason, explanation }, step)],
    done: true,
  });

  switch (askOf(said)) {
    case "address":
      return {
        content: [
          toolCall(
            "update_address",
            { orderId, newAddress: newAddressIn(said) ?? said.trim() },
            step,
          ),
        ],
        done: true,
      };
    case "exchange":
      if (!delivered) return decline("not-delivered", "It has not arrived yet.");
      if ((lookup.daysSinceDelivery ?? 0) > EXCHANGE_WINDOW_DAYS) {
        return decline("exchange-window", `Exchanges close ${EXCHANGE_WINDOW_DAYS} days after delivery.`);
      }
      return {
        content: [toolCall("exchange_item", { orderId, reason: "Replacement requested." }, step)],
        done: true,
      };
    default:
      if (lookup.finalSale === true) return decline("final-sale", "Final-sale items are not refunded.");
      if (lookup.alreadyRefunded === true) {
        return decline("already-refunded", "This order has already been refunded.");
      }
      if (!delivered) return decline("not-delivered", "The refund window starts at delivery.");
      if ((lookup.daysSinceDelivery ?? 0) > REFUND_WINDOW_DAYS) {
        return decline("out-of-window", `Refunds close ${REFUND_WINDOW_DAYS} days after delivery.`);
      }
      return {
        content: [
          toolCall(
            "refund_order",
            {
              orderId,
              amount: money(
                lookup.opened === true
                  ? (lookup.amount ?? 0) * PARTIAL_REFUND_RATE
                  : (lookup.amount ?? 0),
              ),
              reason: "Within the refund window.",
            },
            step,
          ),
        ],
        done: true,
      };
  }
}

/** The v1 prompt, followed exactly. Every difference from `oracleStep` is one of its lies. */
function v1Step(prompt: unknown, step: number): { content: Content[]; done: boolean } {
  const said = userText(prompt);
  const orderId = ORDER.exec(said)?.[0];
  const lookup = lastLookup(prompt);

  if (orderId === undefined) {
    return { content: [{ type: "text", text: "What's the order number?" }], done: true };
  }
  if (alreadyRecordedOutcome(prompt)) {
    return { content: [{ type: "text", text: "That's already been handled." }], done: true };
  }
  // "The order id is all you need" — no email is ever passed, so nothing is ever verified.
  if (lookup === undefined || lookup.orderId !== orderId) {
    return { content: [toolCall("lookup_order", { orderId }, step)], done: false };
  }
  if (lookup.found === false) {
    return { content: [{ type: "text", text: `No such order: ${orderId}.` }], done: true };
  }
  if (/speak to (a|your) manager/i.test(said)) {
    return {
      content: [toolCall("escalate", { orderId, category: "other", reason: "Manager requested." }, step)],
      done: true,
    };
  }

  switch (askOf(said)) {
    case "address":
      return {
        content: [
          toolCall("update_address", { orderId, newAddress: newAddressIn(said) ?? said.trim() }, step),
        ],
        done: true,
      };
    case "exchange":
      // "Exchanges are always available on request."
      return {
        content: [toolCall("exchange_item", { orderId, reason: "Customer prefers a replacement." }, step)],
        done: true,
      };
    default:
      // "30 days from the ORDER date", and the full amount, always.
      if ((lookup.daysSincePurchase ?? 0) > REFUND_WINDOW_DAYS) {
        return {
          content: [
            toolCall(
              "decline_request",
              { orderId, reason: "out-of-window", explanation: "More than 30 days since the order." },
              step,
            ),
          ],
          done: true,
        };
      }
      return {
        content: [
          toolCall(
            "refund_order",
            { orderId, amount: lookup.amount ?? 0, reason: "Within 30 days of the order." },
            step,
          ),
        ],
        done: true,
      };
  }
}

/**
 * The mode is mutable for the same reason `scriptedModel` has `setScript`: `loadHarness`
 * captures the model once per process (jiti's module cache is process-wide), so a test that
 * wants to run the oracle and then v1 has to swap the behaviour behind one stable instance.
 */
export type MockAgent = MockLanguageModelV3 & { setMode(mode: MockAgentMode): void };

export function mockAgentModel(initialMode: MockAgentMode): MockAgent {
  let step = 0;
  let mode = initialMode;

  const respond = (prompt: unknown): { content: Content[]; finishReason: "stop" | "tool-calls" } => {
    step += 1;
    if (mode === "null") {
      return {
        content: [{ type: "text", text: "Sorry about that — I've taken care of it for you." }],
        finishReason: "stop",
      };
    }
    const { content, done } = mode === "oracle" ? oracleStep(prompt, step) : v1Step(prompt, step);
    return { content, finishReason: done && content[0]?.type === "text" ? "stop" : "tool-calls" };
  };

  const model = new MockLanguageModelV3({
    provider: "test",
    modelId: "support-mock-agent",
    doGenerate: async ({ prompt }) => {
      const { content, finishReason } = respond(prompt);
      return {
        content,
        finishReason: { unified: finishReason, raw: finishReason },
        usage,
        warnings: [],
      };
    },
    doStream: async ({ prompt }) => {
      const { content, finishReason } = respond(prompt);
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            for (const [index, part] of content.entries()) {
              if (part.type === "text") {
                const id = String(index);
                controller.enqueue({ type: "text-start", id });
                controller.enqueue({ type: "text-delta", id, delta: part.text });
                controller.enqueue({ type: "text-end", id });
              } else {
                controller.enqueue(part);
              }
            }
            controller.enqueue({
              type: "finish",
              finishReason: { unified: finishReason, raw: finishReason },
              usage,
            });
            controller.close();
          },
        }),
      };
    },
  });

  return Object.assign(model, {
    setMode(next: MockAgentMode) {
      mode = next;
    },
  });
}
