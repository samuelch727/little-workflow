import { HarnessInputError } from "../errors.js";
import type {
  HarnessTraceOptions,
  ResolvedHarnessTraceOptions,
} from "./types.js";

const DEFAULT_REDACTED_KEYS = [
  "apiKey",
  "authorization",
  "cookie",
  "set-cookie",
  "token",
  "password",
  "secret",
];

export function resolveTraceOptions(
  harnessOptions: HarnessTraceOptions | ResolvedHarnessTraceOptions | undefined,
  runOptions: HarnessTraceOptions | ResolvedHarnessTraceOptions | undefined,
): ResolvedHarnessTraceOptions {
  const inputs = [harnessOptions ? harnessOptions.redaction?.values : undefined, runOptions ? runOptions.redaction?.values : undefined];
  for (const input of inputs) {
    if (input !== undefined && (!Array.isArray(input) || input.some(value => typeof value !== "string" || value.length === 0))) {
      throw new HarnessInputError("trace.redaction.values must be an array of non-empty strings");
    }
  }
  const values = unique(inputs.flatMap(input => Array.isArray(input) ? input : []));
  values.sort((a, b) => b.length - a.length);
  if (
    harnessOptions === false ||
    runOptions === false ||
    (isResolvedTraceOptions(harnessOptions) && !harnessOptions.enabled) ||
    (isResolvedTraceOptions(runOptions) && !runOptions.enabled)
  ) {
    return disabledTraceOptions();
  }

  return {
    enabled: true,
    schemaVersion: runOptions?.schemaVersion ?? harnessOptions?.schemaVersion ?? "lh.trace.v2",
    content: {
      previewBytes:
        runOptions?.content?.previewBytes ?? harnessOptions?.content?.previewBytes ?? 512,
      maxInlineBytes:
        runOptions?.content?.maxInlineBytes ??
        harnessOptions?.content?.maxInlineBytes ??
        16 * 1024,
      captureReasoning:
        runOptions?.content?.captureReasoning ??
        harnessOptions?.content?.captureReasoning ??
        true,
      captureModelMessages:
        runOptions?.content?.captureModelMessages ??
        harnessOptions?.content?.captureModelMessages ??
        true,
      captureToolInputs:
        runOptions?.content?.captureToolInputs ??
        harnessOptions?.content?.captureToolInputs ??
        true,
      captureToolOutputs:
        runOptions?.content?.captureToolOutputs ??
        harnessOptions?.content?.captureToolOutputs ??
        true,
    },
    fileDiffs: {
      enabled: runOptions?.fileDiffs?.enabled ?? harnessOptions?.fileDiffs?.enabled ?? true,
      maxInlineBytes:
        runOptions?.fileDiffs?.maxInlineBytes ??
        harnessOptions?.fileDiffs?.maxInlineBytes ??
        8 * 1024,
      maxBytesToDiff:
        runOptions?.fileDiffs?.maxBytesToDiff ??
        harnessOptions?.fileDiffs?.maxBytesToDiff ??
        256 * 1024,
    },
    redaction: {
      ...(values.length ? { values } : {}),
      paths: [
        ...(harnessOptions?.redaction?.paths ?? []),
        ...(runOptions?.redaction?.paths ?? []),
      ],
      metadataKeys: unique([
        ...DEFAULT_REDACTED_KEYS,
        ...(harnessOptions?.redaction?.metadataKeys ?? []),
        ...(runOptions?.redaction?.metadataKeys ?? []),
      ]),
    },
  };
}

function isResolvedTraceOptions(value: unknown): value is ResolvedHarnessTraceOptions {
  return typeof value === "object" && value !== null && "enabled" in value;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}

function disabledTraceOptions(): ResolvedHarnessTraceOptions {
  return {
    enabled: false,
    schemaVersion: "lh.trace.v2",
    content: {
      previewBytes: 0,
      maxInlineBytes: 0,
      captureReasoning: false,
      captureModelMessages: false,
      captureToolInputs: false,
      captureToolOutputs: false,
    },
    fileDiffs: {
      enabled: false,
      maxInlineBytes: 0,
      maxBytesToDiff: 0,
    },
    redaction: {
      paths: [],
      metadataKeys: DEFAULT_REDACTED_KEYS,
    },
  };
}
