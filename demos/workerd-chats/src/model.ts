import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";

type ModelSettings = {
  MODEL_BASE_URL?: string;
  MODEL_NAME?: string;
  MODEL_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
};

/** A compatible LAN model takes precedence over DeepSeek, then the keyless script. */
export function chatModel(settings: ModelSettings): LanguageModel {
  if (settings.MODEL_BASE_URL) {
    if (!settings.MODEL_NAME) throw new Error("MODEL_NAME is required when MODEL_BASE_URL is set");
    return createOpenAICompatible({
      name: "local", baseURL: settings.MODEL_BASE_URL,
      ...(settings.MODEL_API_KEY ? { apiKey: settings.MODEL_API_KEY } : {}),
    })(settings.MODEL_NAME);
  }
  return settings.DEEPSEEK_API_KEY
    ? createDeepSeek({ apiKey: settings.DEEPSEEK_API_KEY })("deepseek-v4-flash")
    : scriptedModel();
}

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** Keyless commands for bash, questions, one-shot plans and reusable workflows. */
function scriptedModel(): LanguageModel {
  return new MockLanguageModelV3({
    provider: "scripted",
    modelId: "bash-echo",
    doGenerate: async (options) => scriptedReply(options),
    doStream: async (options) => {
      const { prompt, tools } = options;
      // The compiler puts planning instructions in the system prompt. A marker
      // in a user's question, tool result or saved history is ordinary chat data.
      const plannerSource = promptText(prompt.filter((message) => message.role === "system"));
      const marker = "no prose or markdown fences:\n";
      const markerAt = plannerSource.indexOf(marker);
      if (markerAt >= 0 && tools?.some((entry) => entry.name === "bash")) {
        // The real planner prompt carries a valid tool.call -> ai.generate LWIR
        // skeleton. Adapt its final input to the result of our example's tool.
        const start = plannerSource.indexOf("{", markerAt);
        const end = plannerSource.indexOf("\n}", start);
        if (start < 0 || end < 0) throw new Error("No workflow skeleton in the scripted planner prompt");
        const plan = JSON.parse(plannerSource.slice(start, end + 2)) as {
          steps: { id: string; uses: string; input?: string; with?: { tool?: string } }[];
        };
        const count = plan.steps.find((step) => step.uses === "tool.call" && step.with?.tool === "word_count");
        const reply = plan.steps.find((step) => step.uses === "ai.generate");
        if (!count || !reply) throw new Error("The scripted planner expected word_count and a model step");
        reply.input = `WORD_COUNT={{ steps.${count.id}.output.count }}`;
        return textStream(JSON.stringify(plan));
      }
      const count = /WORD_COUNT=(\d+)/u.exec(promptText(prompt))?.[1];
      if (!tools?.length && count !== undefined) return textStream(`Words: ${count}`);
      const content = scriptedReply(options).content;
      const part = content[0]!;
      return part.type === "tool-call" ? callStream(content.filter((item): item is ReturnType<typeof call>["content"][number] => item.type === "tool-call")) : textStream(part.text);
    },
  });
}

/** Share the chat decisions between the JSON and streaming transports. */
function scriptedReply({ prompt, tools }: Parameters<MockLanguageModelV3["doGenerate"]>[0]) {
  const last = prompt.at(-1);
  if (last?.role === "tool") {
    const part = last.content[0];
    if (part?.type === "tool-result" && part.output.type.startsWith("error-")) {
      return text(`Tool error: ${JSON.stringify(part.output)}`);
    }
    const output = part?.type === "tool-result" ? (part.output as { value?: unknown }).value : undefined;
    if (part?.type === "tool-result" && part.toolName === "ask_person") {
      return call("await_tasks", { taskIds: [(output as { taskId: string }).taskId], mode: "all" });
    }
    if (part?.type === "tool-result" && part.toolName === "await_tasks") {
      const answer = (output as { tasks?: { answer?: { text?: string } }[] }).tasks?.[0]?.answer;
      return text(answer?.text ?? JSON.stringify(output));
    }
    return text(JSON.stringify(output));
  }
  const user = prompt.filter((message) => message.role === "user").at(-1);
  const command = Array.isArray(user?.content)
    ? user.content.map((part) => (part.type === "text" ? part.text : "")).join("")
    : "";
  if (command.startsWith("parallel-bash:")) {
    const input = { command: command.slice("parallel-bash:".length).trim() };
    const first = call("bash", input), second = call("bash", input);
    return { ...first, content: [...first.content, ...second.content] };
  }
  if (command.startsWith("ask:")) return call("ask_person", { question: command.slice(4).trim() });
  if (command.startsWith("orders:")) {
    return tools?.some(entry => entry.name === "orders_lookup")
      ? call("orders_lookup", { status: command.slice(7).trim() })
      : text("The remote orders tool is disabled; set DATA_API_TOKEN.");
  }
  if (command.startsWith("plan:")) {
    return call("run_ad_hoc_plan", {
      purpose: "Count words and write their total",
      input: { text: command.slice(5).trim() },
      outputSchema: { type: "string" },
      plan: {
        steps: [
          { id: "count", uses: "tool.call", tool: "word_count", with: { text: "{{ input.text }}" }, output: { mode: "json", schema: true } },
          { id: "reply", uses: "ai.generate", model: "default", prompt: "WORD_COUNT={{ steps.count.output.count }}", output: { mode: "text" } },
        ],
        output: { from: "reply" },
      },
    });
  }
  if (command.startsWith("define:")) {
    return call("define_workflow", {
      id: command.slice(7).trim(),
      description: "Count the words in input.text and reply with their total.",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
      outputSchema: { type: "string" },
      tools: ["word_count"],
    });
  }
  if (command.startsWith("use:")) {
    const input = command.slice(4);
    const separator = input.indexOf(":");
    if (separator < 1) return text("Use use:<workflow-id>:<text>.");
    const id = input.slice(0, separator).trim();
    const handle = id.replaceAll(".", "_");
    return tools?.some((entry) => entry.name === handle)
      ? call(handle, { text: input.slice(separator + 1).trim() })
      : text(`No defined workflow named ${id} is offered in this chat.`);
  }
  return call("bash", { command });
}

function promptText(prompt: unknown): string {
  return (prompt as readonly { content: string | readonly { text?: string }[] }[])
    .map(({ content }) => typeof content === "string" ? content : content.map((part) => part.text ?? "").join(""))
    .join("\n");
}

function textStream(value: string): Awaited<ReturnType<MockLanguageModelV3["doStream"]>> {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "text-start", id: "0" });
        controller.enqueue({ type: "text-delta", id: "0", delta: value });
        controller.enqueue({ type: "text-end", id: "0" });
        controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
        controller.close();
      },
    }),
  };
}

function callStream(parts: readonly ReturnType<typeof call>["content"][number][]): Awaited<ReturnType<MockLanguageModelV3["doStream"]>> {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        for (const part of parts) {
          controller.enqueue({ type: "tool-input-start", id: part.toolCallId, toolName: part.toolName });
          controller.enqueue({ type: "tool-input-delta", id: part.toolCallId, delta: part.input });
          controller.enqueue({ type: "tool-input-end", id: part.toolCallId });
          controller.enqueue(part);
        }
        controller.enqueue({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage });
        controller.close();
      },
    }),
  };
}

function call(toolName: string, input: unknown) {
  return {
    content: [{ type: "tool-call" as const, toolCallId: crypto.randomUUID(), toolName, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls" as const, raw: "tool-calls" }, usage, warnings: [],
  };
}

function text(value: string) {
  return {
    content: [{ type: "text" as const, text: value }],
    finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [],
  };
}
