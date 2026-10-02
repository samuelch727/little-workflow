import type { ToolSet, UIMessage } from "ai";
import type { CliIo } from "../cli-core.js";
import type { ConnectorToolPolicy } from "../connectors/tool-extensions.js";
import type { HarnessParkedResult, StreamHarnessTurnFinished } from "../execution/result.js";
import { streamHarness as defaultStreamHarness } from "../execution/stream-harness.js";
import { createEventId } from "../ids.js";
import type { Harness } from "../types.js";
import { renderUiMessageStream } from "./stream-renderer.js";

/**
 * Drive an interactive REPL over a loaded {@link Harness}: read a line, stream the assistant reply
 * incrementally, and loop, persisting the conversation across turns. `read` returns the next user
 * line or `null` to stop; `:exit` quits and `:reset` clears the conversation. Factored out of the
 * CLI command so it is testable with a mock-model harness and scripted input.
 */
export async function runRepl(
  harness: Harness,
  io: CliIo,
  read: () => Promise<string | null>,
  opts: {
    session?: string;
    streamHarness?: typeof defaultStreamHarness;
    connectorTools?: ToolSet;
    toolPolicy?: ConnectorToolPolicy;
  } = {},
): Promise<void> {
  const session = opts.session ?? `repl_${createEventId()}`;
  const streamHarness = opts.streamHarness ?? defaultStreamHarness;
  const out = io.stdout ?? ((text: string) => void process.stdout.write(text));
  const messages: UIMessage[] = [];
  for (;;) {
    await out("\nyou> ");
    const line = await read();
    if (line === null) break;
    const trimmed = line.trim();
    if (trimmed === ":exit") break;
    if (trimmed === ":reset") {
      messages.length = 0;
      await out("(conversation reset)\n");
      continue;
    }
    if (trimmed === "") continue;
    const userMessage = { id: createEventId(), role: "user" as const, parts: [{ type: "text" as const, text: line }] };
    messages.push(userMessage);
    const result = streamHarness({
      harness,
      messages,
      session,
      uiMessageStream: { onError: formatReplError },
      ...(opts.connectorTools === undefined ? {} : { connectorTools: opts.connectorTools }),
      ...(opts.toolPolicy === undefined ? {} : { toolPolicy: opts.toolPolicy }),
    });
    const renderResult = renderUiMessageStream(result.toUIMessageStream(), out);
    let finished: StreamHarnessTurnFinished;
    try {
      finished = await result.finished as StreamHarnessTurnFinished; // let the turn settle (durability flushed) before the next prompt
    } catch (error) {
      rollbackMessage(messages, userMessage.id);
      const rendered = await renderResult;
      if (!rendered.streamFailed) {
        await out(`\n[error]\n${formatReplError(error)}\n`);
      }
      continue;
    }
    if (finished.status === "parked") {
      const rendered = await renderResult;
      if (rendered.streamFailed) {
        rollbackMessage(messages, userMessage.id);
        continue;
      }
      await out(formatParkedSummary(finished));
      await out("\n");
      continue;
    }
    const { assistantText, streamFailed } = await renderResult;
    if (streamFailed) {
      rollbackMessage(messages, userMessage.id);
      continue;
    }
    if (assistantText.length > 0) {
      messages.push({ id: createEventId(), role: "assistant", parts: [{ type: "text", text: assistantText }] });
    } else {
      rollbackMessage(messages, userMessage.id);
    }
  }
}

function rollbackMessage(messages: UIMessage[], id: string): void {
  if (messages[messages.length - 1]?.id === id) {
    messages.pop();
  }
}

function formatReplError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error, null, 2) ?? String(error);
  } catch {
    return String(error);
  }
}

function formatParkedSummary(result: HarnessParkedResult): string {
  const waitingFor = [
    ...(result.pending.taskIds ?? []),
    ...(result.pending.toolCallIds ?? []),
  ];
  if (waitingFor.length === 0) {
    return `Parked: ${result.continuationId}`;
  }
  return `Parked: ${result.continuationId} waiting for ${waitingFor.join(", ")}`;
}
