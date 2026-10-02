import { tool } from "ai";
import { extendTool, tryHarnessToolContext } from "little-harness/connectors/runtime";
import { z } from "zod";
import type { SupportDiscordExtraBody } from "../connector";

export const sendChannelUpdateInputSchema = z.object({
  customerId: z.string().min(1),
  summary: z.string().min(1),
  urgency: z.enum(["normal", "high"]),
});

export const sendChannelUpdateOutputSchema = z.object({
  delivered: z.boolean(),
  connector: z.literal("discord"),
  channel: z.string(),
  audience: z.literal("internal_support"),
  message: z.string(),
  auditId: z.string(),
});

const sendChannelUpdate = tool({
  description:
    "Send a Discord-only internal support channel update for the active conversation.",
  inputSchema: sendChannelUpdateInputSchema,
  outputSchema: sendChannelUpdateOutputSchema,
  strict: true,
});

export type SendChannelUpdateOutput = z.infer<typeof sendChannelUpdateOutputSchema>;

const channelUpdates: SendChannelUpdateOutput[] = [];

export function listSendChannelUpdates(): readonly SendChannelUpdateOutput[] {
  return [...channelUpdates];
}

export function clearSendChannelUpdates(): void {
  channelUpdates.length = 0;
}

export default extendTool(sendChannelUpdate, {
  description:
    "Post a concise internal support update into the active Discord thread. Use only when the active connector is Discord.",
  execute: async (
    input: z.infer<typeof sendChannelUpdateInputSchema>,
    options,
  ): Promise<SendChannelUpdateOutput> => {
    // The harness spreads its execution context (session/files/connector/extraBody) into the tool's
    // `options` at run time; `tryHarnessToolContext` reads it typed and cast-free, and returns
    // `undefined` if the tool is ever invoked outside a harness run.
    const ctx = tryHarnessToolContext<SupportDiscordExtraBody>(options);
    const endpoint = ctx?.connector?.endpoint;
    const threadId = endpoint?.threadId ?? "unknown-thread";
    const userId = endpoint?.userId ?? "unknown-user";
    const prefix = input.urgency === "high" ? "[HIGH]" : "[UPDATE]";
    const safeCustomer = input.customerId.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 64);

    const output: SendChannelUpdateOutput = {
      delivered: true,
      connector: "discord",
      channel: threadId,
      audience: "internal_support",
      message: `${prefix} ${input.customerId}: ${input.summary}`,
      auditId: `discord_${safeCustomer}_${userId}_${input.urgency}`,
    };
    channelUpdates.push(output);
    return output;
  },
});
