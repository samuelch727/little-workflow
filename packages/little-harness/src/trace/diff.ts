import { sha256Hex } from "../ids.js";
import type { FileWriter } from "../types.js";
import type { ResolvedHarnessTraceOptions, TraceFileDiff } from "./types.js";

const decoder = new TextDecoder("utf8", { fatal: true });

export async function createTraceDiff(
  before: Uint8Array | undefined,
  after: Uint8Array | undefined,
  traceOptions: ResolvedHarnessTraceOptions,
  options: { files?: FileWriter; path?: string } = {},
): Promise<TraceFileDiff> {
  if (!traceOptions.enabled || !traceOptions.fileDiffs.enabled) {
    return { available: false, reason: "disabled" };
  }
  if (!after) {
    return { available: false, reason: "content_unavailable" };
  }
  if ((before?.byteLength ?? 0) > traceOptions.fileDiffs.maxBytesToDiff || after.byteLength > traceOptions.fileDiffs.maxBytesToDiff) {
    return { available: false, reason: "too_large" };
  }
  if (!isProbablyText(before) || !isProbablyText(after)) {
    return { available: false, reason: "non_text" };
  }

  const beforeText = before ? decoder.decode(before) : "";
  const afterText = decoder.decode(after);
  const unified = unifiedDiff(beforeText, afterText);
  const bytesContent = new TextEncoder().encode(unified);
  const bytes = bytesContent.byteLength;
  const sha256 = sha256Hex(bytesContent);
  const out: TraceFileDiff = {
    available: true,
    format: "unified",
    preview: unified.slice(0, traceOptions.fileDiffs.maxInlineBytes),
    truncated: bytes > traceOptions.fileDiffs.maxInlineBytes,
    bytes,
    sha256,
  };

  if (out.truncated && options.files) {
    const ref = await options.files.writeText(
      `/artifacts/trace/file-diffs/${safePathSegment(options.path ?? "diff")}/${sha256.slice(
        0,
        16,
      )}.diff`,
      unified,
      {
        mediaType: "text/x-diff",
        source: "trace",
        artifact: {
          metadata: {
            traceDiff: true,
            path: options.path,
            bytes,
          },
        },
      },
    );
    out.contentRef = ref.path;
  }

  return out;
}

function isProbablyText(content: Uint8Array | undefined): boolean {
  if (!content) {
    return true;
  }
  if (content.includes(0)) {
    return false;
  }
  try {
    decoder.decode(content);
    return true;
  } catch {
    return false;
  }
}

function unifiedDiff(beforeText: string, afterText: string): string {
  const beforeLines = splitLines(beforeText);
  const afterLines = splitLines(afterText);
  const max = Math.max(beforeLines.length, afterLines.length);
  const lines = ["@@ -1 +1 @@"];

  for (let index = 0; index < max; index += 1) {
    const before = beforeLines[index];
    const after = afterLines[index];
    if (before === after) {
      if (before !== undefined && before !== "") {
        lines.push(` ${before}`);
      }
      continue;
    }
    if (before !== undefined && before !== "") {
      lines.push(`-${before}`);
    }
    if (after !== undefined && after !== "") {
      lines.push(`+${after}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function safePathSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._:-]/g, "_").replace(/\.\.+/g, "_");
  return safe.length > 0 ? safe.slice(0, 96) : "diff";
}
