import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createEventId, createTurnId } from "../ids.js";
import { isSideChannelSequence } from "../outcomes/sequence.js";
import { resolveTraceOptions } from "../trace/options.js";
import { sanitizeTraceValue } from "../trace/redaction.js";
import { validateTraceEvent, type HarnessTraceEventType } from "../trace/validate.js";
import type { HarnessEvent, TraceRef } from "../types.js";
import type { ResolvedHarnessTraceOptions } from "../trace/types.js";

export class LocalTrace {
  readonly ref: TraceRef;
  private sequence: number | undefined;

  constructor(
    private readonly traceFile: string,
    private readonly traceOptions: ResolvedHarnessTraceOptions = resolveTraceOptions(
      undefined,
      undefined,
    ),
  ) {
    this.ref = {
      id: createTurnId().replace(/^turn_/, "trace_"),
      path: traceFile,
    };
  }

  async append<TEventType extends HarnessTraceEventType>(
    event: HarnessEvent<TEventType>,
  ): Promise<HarnessEvent<TEventType>> {
    const sequence = await this.nextSequence();
    const enriched = validateTraceEvent({
      ...event,
      schemaVersion: event.schemaVersion ?? this.traceOptions.schemaVersion,
      eventId: event.eventId ?? createEventId(),
      sequence: event.sequence ?? sequence,
      metadata: sanitizeTraceValue(event.metadata ?? {}, this.traceOptions).value,
    });
    await mkdir(dirname(this.traceFile), { recursive: true });
    await appendFile(this.traceFile, `${JSON.stringify(enriched)}\n`, "utf8");
    return enriched as HarnessEvent<TEventType>;
  }

  private async nextSequence(): Promise<number> {
    if (this.sequence === undefined) {
      this.sequence = await readLastSequence(this.traceFile);
    }
    this.sequence += 1;
    return this.sequence;
  }
}

async function readLastSequence(traceFile: string): Promise<number> {
  try {
    const text = await readFile(traceFile, "utf8");
    const lines = text.trim().split("\n").filter(Boolean);
    // Fallback for traces whose lines carry no usable sequence: count the lines, EXCLUDING
    // side-channel events, which are not part of run numbering.
    const runLineCount = lines.filter((line) => !isSideChannelLine(line)).length;
    for (const line of lines.reverse()) {
      try {
        const parsed = JSON.parse(line) as { sequence?: unknown };
        if (typeof parsed.sequence === "number" && Number.isInteger(parsed.sequence)) {
          // Side-channel events (outcomes) sit in a reserved band far above run numbering.
          // Resuming from one would launch every subsequent run event into that band, so the
          // scan walks past them to the last REAL trace sequence.
          if (isSideChannelSequence(parsed.sequence)) {
            continue;
          }
          return parsed.sequence;
        }
      } catch {
        return runLineCount;
      }
    }
    return runLineCount;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

function isSideChannelLine(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as { sequence?: unknown };
    return typeof parsed.sequence === "number" && isSideChannelSequence(parsed.sequence);
  } catch {
    return false;
  }
}
