export type RenderUiMessageStreamResult = {
  assistantText: string;
  streamFailed: boolean;
};

type Write = (text: string) => void | Promise<void>;
type StreamChunk = Record<string, unknown> & { type?: unknown };

type ToolInputState = {
  toolName: string;
  inputText: string;
};

export async function renderUiMessageStream(
  stream: ReadableStream,
  write: Write,
): Promise<RenderUiMessageStreamResult> {
  const reader = stream.getReader();
  const toolInputs = new Map<string, ToolInputState>();
  const printedToolInputs = new Set<string>();
  let section: string | undefined;
  let wrote = false;
  let lastChar = "";
  let assistantText = "";
  let streamFailed = false;

  const emit = async (text: string) => {
    if (text.length === 0) {
      return;
    }
    wrote = true;
    lastChar = text[text.length - 1] ?? lastChar;
    await write(text);
  };

  const ensureTrailingNewline = async () => {
    if (wrote && lastChar !== "\n") {
      await emit("\n");
    }
  };

  const startBlock = async (label: string) => {
    if (wrote) {
      await ensureTrailingNewline();
      await emit("\n");
    }
    section = label;
    await emit(`${label}\n`);
  };

  const ensureSection = async (label: string) => {
    if (section !== label) {
      await startBlock(label);
    }
  };

  const printValue = async (valueLabel: string, value: unknown) => {
    await emit(`${valueLabel}:\n`);
    await emit(formatValue(value));
    await ensureTrailingNewline();
  };

  const printValueBlock = async (label: string, valueLabel: string, value: unknown) => {
    await startBlock(label);
    await printValue(valueLabel, value);
  };

  const printStreamError = async (error: unknown) => {
    streamFailed = true;
    await startBlock("[error]");
    await emit(formatValue(error));
    await ensureTrailingNewline();
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      const chunk = asChunk(value);
      const type = typeof chunk.type === "string" ? chunk.type : "";
      if (type === "text-delta") {
        const delta = stringValue(chunk.delta) ?? stringValue(chunk.text);
        if (delta !== undefined && delta.length > 0) {
          await ensureSection("[assistant]");
          assistantText += delta;
          await emit(delta);
        }
        continue;
      }

      if (type === "reasoning-delta") {
        const delta = stringValue(chunk.delta) ?? stringValue(chunk.text);
        if (delta !== undefined && delta.length > 0) {
          await ensureSection("[reasoning]");
          await emit(delta);
        }
        continue;
      }

      if (type === "tool-call") {
        const toolCallId = toolCallIdFor(chunk);
        const toolName = toolNameFor(chunk, toolInputs, toolCallId);
        if (toolCallId !== undefined) {
          if (printedToolInputs.has(toolCallId)) {
            continue;
          }
          toolInputs.set(toolCallId, { toolName, inputText: "" });
          printedToolInputs.add(toolCallId);
        }
        await printValueBlock(`[tool call: ${toolName}]`, "input", chunk.input);
        continue;
      }

      if (type === "tool-input-available") {
        const toolCallId = toolCallIdFor(chunk);
        const toolName = toolNameFor(chunk, toolInputs, toolCallId);
        if (toolCallId !== undefined) {
          toolInputs.set(toolCallId, { toolName, inputText: "" });
          if (printedToolInputs.has(toolCallId)) {
            continue;
          }
          printedToolInputs.add(toolCallId);
        }
        await printValueBlock(`[tool call: ${toolName}]`, "input", chunk.input);
        continue;
      }

      if (type === "tool-input-error") {
        const toolCallId = toolCallIdFor(chunk);
        const toolName = toolNameFor(chunk, toolInputs, toolCallId);
        if (toolCallId !== undefined) {
          toolInputs.set(toolCallId, { toolName, inputText: "" });
          printedToolInputs.add(toolCallId);
        }
        await startBlock(`[tool error: ${toolName}]`);
        if (chunk.errorText !== undefined) {
          await printValue("error", chunk.errorText);
        }
        await printValue("input", chunk.input);
        continue;
      }

      if (type === "tool-input-start") {
        const toolCallId = toolCallIdFor(chunk);
        const toolName = toolNameFor(chunk, toolInputs, toolCallId);
        if (toolCallId !== undefined) {
          toolInputs.set(toolCallId, { toolName, inputText: "" });
        }
        continue;
      }

      if (type === "tool-input-delta") {
        const toolCallId = toolCallIdFor(chunk);
        const delta = stringValue(chunk.inputTextDelta) ?? stringValue(chunk.delta);
        if (delta !== undefined) {
          if (toolCallId !== undefined && !toolInputs.has(toolCallId)) {
            toolInputs.set(toolCallId, { toolName: "unknown", inputText: "" });
          }
          const input = toolCallId === undefined ? undefined : toolInputs.get(toolCallId);
          if (input !== undefined) {
            input.inputText += delta;
          }
        }
        continue;
      }

      if (type === "tool-input-end") {
        const toolCallId = toolCallIdFor(chunk);
        const input = toolCallId === undefined ? undefined : toolInputs.get(toolCallId);
        if (toolCallId !== undefined && input !== undefined && !printedToolInputs.has(toolCallId)) {
          printedToolInputs.add(toolCallId);
          await printValueBlock(`[tool call: ${input.toolName}]`, "input", input.inputText);
        }
        continue;
      }

      if (type === "tool-result" || type === "tool-output-available") {
        if (chunk.preliminary === true) {
          continue;
        }
        const toolCallId = toolCallIdFor(chunk);
        const toolName = toolNameFor(chunk, toolInputs, toolCallId);
        if (toolCallId !== undefined && !printedToolInputs.has(toolCallId) && "input" in chunk) {
          printedToolInputs.add(toolCallId);
          await printValueBlock(`[tool call: ${toolName}]`, "input", chunk.input);
        }
        await printValueBlock(`[tool result: ${toolName}]`, "output", "output" in chunk ? chunk.output : chunk.result);
        continue;
      }

      if (type === "tool-output-denied") {
        const toolCallId = toolCallIdFor(chunk);
        const toolName = toolNameFor(chunk, toolInputs, toolCallId);
        await printValueBlock(`[tool denied: ${toolName}]`, "output", "(denied)");
        continue;
      }

      if (type === "tool-error" || type === "tool-output-error") {
        const toolCallId = toolCallIdFor(chunk);
        const toolName = toolNameFor(chunk, toolInputs, toolCallId);
        await startBlock(`[tool error: ${toolName}]`);
        await printValue("error", chunk.errorText ?? chunk.error);
        if ("input" in chunk && (toolCallId === undefined || !printedToolInputs.has(toolCallId))) {
          if (toolCallId !== undefined) {
            printedToolInputs.add(toolCallId);
          }
          await printValue("input", chunk.input);
        }
        continue;
      }

      if (type === "error") {
        await printStreamError(chunk.errorText ?? chunk.error);
        continue;
      }
    }
  } catch (error) {
    await printStreamError(error);
  } finally {
    reader.releaseLock();
  }

  await ensureTrailingNewline();
  return { assistantText, streamFailed };
}

function asChunk(value: unknown): StreamChunk {
  return typeof value === "object" && value !== null ? (value as StreamChunk) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toolCallIdFor(chunk: StreamChunk): string | undefined {
  return stringValue(chunk.toolCallId) ?? stringValue(chunk.id);
}

function toolNameFor(
  chunk: StreamChunk,
  toolInputs: ReadonlyMap<string, ToolInputState>,
  toolCallId?: string,
): string {
  return (
    stringValue(chunk.toolName) ??
    (toolCallId === undefined ? undefined : toolInputs.get(toolCallId)?.toolName) ??
    "unknown"
  );
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    const parsed = tryParseJson(value);
    return parsed === undefined ? value : stringifyJson(parsed);
  }
  if (value instanceof Error) {
    return value.message;
  }
  if (value === undefined) {
    return "(undefined)";
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return stringifyJson(value);
}

function tryParseJson(value: string): unknown | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
