import type { JsonObject } from "../types.js";

export type HarnessTraceSchemaVersion = "lh.trace.v2";

export type HarnessTraceOptions =
  | false
  | {
      schemaVersion?: HarnessTraceSchemaVersion;
      content?: Partial<HarnessTraceContentOptions>;
      fileDiffs?: Partial<HarnessTraceFileDiffOptions>;
      redaction?: Partial<HarnessTraceRedactionOptions>;
    };

export type ResolvedHarnessTraceOptions = {
  enabled: boolean;
  schemaVersion: HarnessTraceSchemaVersion;
  content: HarnessTraceContentOptions;
  fileDiffs: HarnessTraceFileDiffOptions;
  redaction: HarnessTraceRedactionOptions;
};

export type HarnessTraceContentOptions = {
  /** Legacy option name: maximum UTF-16 code units in a preview, not a UTF-8 storage quota. */
  previewBytes: number;
  /** Maximum UTF-8 bytes before full optional content is stored in an artifact. */
  maxInlineBytes: number;
  captureReasoning: boolean;
  captureModelMessages: boolean;
  captureToolInputs: boolean;
  captureToolOutputs: boolean;
};

export type HarnessTraceFileDiffOptions = {
  enabled: boolean;
  maxInlineBytes: number;
  maxBytesToDiff: number;
};

export type HarnessTraceRedactionOptions = {
  paths: string[];
  metadataKeys: string[];
};

export type TraceContentRef = {
  captured: boolean;
  preview?: string;
  truncated?: boolean;
  contentRef?: string;
  bytes?: number;
  sha256?: string;
  mediaType?: string;
  redacted?: boolean;
  redactionReason?: string;
  /** Full optional content could not be stored; preview/hash/size describe the sanitized value. */
  unavailableReason?: "storage_limit";
  storageLimitBytes?: number;
};

export type TraceFileDiff =
  | {
      available: true;
      format: "unified";
      preview?: string;
      truncated: boolean;
      contentRef?: string;
      bytes?: number;
      sha256?: string;
    }
  | {
      available: false;
      reason: "disabled" | "non_text" | "too_large" | "redacted" | "content_unavailable";
    };

export type TraceErrorEnvelope = {
  name: string;
  message: string;
  stack?: string;
  cause?: JsonObject | string | number | boolean | null;
};
