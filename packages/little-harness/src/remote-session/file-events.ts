import type { ArtifactRef, FileRef, HarnessEvent, JsonObject } from "../types.js";
import { posix } from "node:path";

const MAX_EVENT_PATH_BYTES = 4_096;
const MAX_EVENT_LABEL_BYTES = 1_024;
const MAX_JSON_DOCUMENT_BYTES = 256 * 1_024;
const MAX_JSON_STRING_BYTES = 64 * 1_024;
const MAX_JSON_KEY_BYTES = 1_024;
const MAX_JSON_NODES = 10_000;
const MAX_JSON_DEPTH = 64;

export type HarnessFileContentVersion = Readonly<{
  bytes: number;
  sha256: string;
}>;

export type HarnessFileMutationKind = "created" | "updated" | "deleted";

export type HarnessFileMutationEventInput = Readonly<{
  /** One logical mutation identity, allocated before any event transport retry. */
  occurrenceId: string;
  kind: HarnessFileMutationKind;
  file: Pick<FileRef, "path" | "bytes" | "mediaType" | "sha256">;
  source?: string;
  /** Defaults to the first absolute path segment. */
  root?: string;
  /** Original adapter metadata is kept under the existing `metadata` field. */
  metadata?: JsonObject;
  before?: HarnessFileContentVersion;
  after?: HarnessFileContentVersion;
  diff: JsonObject;
  artifact?: ArtifactRef;
}>;

export type HarnessFileMutationEvent = Omit<
  HarnessEvent<
    | "harness.file.created"
    | "harness.file.updated"
    | "harness.file.deleted"
    | "harness.file.written_by_tool"
    | "harness.artifact.created"
  >,
  "timestamp" | "sessionId"
>;

/**
 * Canonical Harness file/artifact event serializer for trusted local and remote
 * adapters. Keeping this in Little Harness prevents remote runtimes from
 * inventing a subtly different metadata vocabulary.
 */
export function createHarnessFileMutationEvents(
  input: HarnessFileMutationEventInput,
): readonly HarnessFileMutationEvent[] {
  assertMutation(input);
  const root = input.root ?? rootFromPath(input.file.path);
  const metadata: JsonObject = {
    ...fileMetadata(input.file, input.source, input.metadata),
    ...(root === undefined ? {} : { root }),
    ...(input.before === undefined ? {} : { before: input.before }),
    ...(input.after === undefined ? {} : { after: input.after }),
    diff: input.diff,
  };
  assertJsonObject(metadata, "serialized metadata");
  const events: HarnessFileMutationEvent[] = [
    {
      type: `harness.file.${input.kind}` as
        | "harness.file.created"
        | "harness.file.updated"
        | "harness.file.deleted",
      occurrenceId: input.occurrenceId,
      metadata,
    },
  ];
  if (input.source === "tool" && input.kind !== "deleted") {
    events.push({ type: "harness.file.written_by_tool", occurrenceId: input.occurrenceId, metadata });
  }
  if (input.artifact !== undefined && input.kind !== "deleted") {
    const artifactMetadata: JsonObject = {
      ...fileMetadata(input.artifact, input.source, input.artifact.metadata),
      artifact: input.artifact,
    };
    assertJsonObject(artifactMetadata, "serialized artifact metadata");
    events.push({
      type: "harness.artifact.created",
      occurrenceId: input.occurrenceId,
      metadata: artifactMetadata,
    });
  }
  return events;
}

function assertMutation(input: HarnessFileMutationEventInput): void {
  if (
    typeof input.occurrenceId !== "string" ||
    input.occurrenceId.length === 0 ||
    Buffer.byteLength(input.occurrenceId, "utf8") > 512 ||
    /[\u0000-\u001f\u007f]/u.test(input.occurrenceId)
  ) {
    throw new Error("Harness file event occurrenceId must be bounded printable text.");
  }
  if (input.kind !== "created" && input.kind !== "updated" && input.kind !== "deleted") {
    throw new Error("Harness file event mutation kind is invalid.");
  }
  if (typeof input.file.path !== "string") {
    throw new Error("Harness file event path must be a string.");
  }
  assertBoundedString(input.file.path, "path", MAX_EVENT_PATH_BYTES);
  const inferredRoot = rootFromPath(input.file.path);
  if (
    !input.file.path.startsWith("/") ||
    input.file.path === "/" ||
    input.file.path.includes("\0") ||
    /[\u0001-\u001f\u007f]/u.test(input.file.path) ||
    posix.normalize(input.file.path) !== input.file.path ||
    inferredRoot === undefined
  ) {
    throw new Error("Harness file event path must be an absolute normalized NUL-free file path.");
  }
  if (input.root !== undefined && input.root !== inferredRoot) {
    throw new Error("Harness file event root must match its path.");
  }
  if (input.source !== undefined) {
    assertBoundedString(input.source, "source", MAX_EVENT_LABEL_BYTES);
  }
  if (input.file.mediaType !== undefined) {
    assertBoundedString(input.file.mediaType, "media type", MAX_EVENT_LABEL_BYTES);
  }
  assertVersion(input.before, "before");
  assertVersion(input.after, "after");
  assertOptionalFileVersion(input.file.bytes, input.file.sha256, "FileRef");
  assertJsonObject(input.diff, "diff");
  if (input.metadata !== undefined) assertJsonObject(input.metadata, "metadata");
  if (input.kind === "created" && (input.before !== undefined || input.after === undefined)) {
    throw new Error("A created Harness file event requires only an after version.");
  }
  if (input.kind === "updated" && (input.before === undefined || input.after === undefined)) {
    throw new Error("An updated Harness file event requires before and after versions.");
  }
  if (input.kind === "deleted" && (input.before === undefined || input.after !== undefined)) {
    throw new Error("A deleted Harness file event requires only a before version.");
  }
  const referencedVersion = input.kind === "deleted" ? input.before : input.after;
  if (
    referencedVersion !== undefined &&
    ((input.file.bytes !== undefined && input.file.bytes !== referencedVersion.bytes) ||
      (input.file.sha256 !== undefined && input.file.sha256 !== referencedVersion.sha256))
  ) {
    throw new Error(
      `Harness file event FileRef must match its ${input.kind === "deleted" ? "before" : "after"} version.`,
    );
  }
  if (input.artifact !== undefined && input.artifact.path !== input.file.path) {
    throw new Error("Harness artifact event path must match the file path.");
  }
  if (input.artifact !== undefined) {
    if (input.kind === "deleted") {
      throw new Error("A deleted Harness file event cannot create an artifact event.");
    }
    if (typeof input.artifact.id !== "string") {
      throw new Error("Harness artifact event id must be a string.");
    }
    assertBoundedString(input.artifact.id, "artifact id", MAX_EVENT_LABEL_BYTES);
    if (input.artifact.id.length === 0 || input.artifact.id.includes("\0")) {
      throw new Error("Harness artifact event id is invalid.");
    }
    if (input.artifact.mediaType !== undefined) {
      assertBoundedString(input.artifact.mediaType, "artifact media type", MAX_EVENT_LABEL_BYTES);
    }
    assertOptionalFileVersion(input.artifact.bytes, input.artifact.sha256, "ArtifactRef");
    if (
      input.after !== undefined &&
      ((input.artifact.bytes !== undefined && input.artifact.bytes !== input.after.bytes) ||
        (input.artifact.sha256 !== undefined && input.artifact.sha256 !== input.after.sha256))
    ) {
      throw new Error("Harness artifact event reference must match its after version.");
    }
    if (input.artifact.metadata !== undefined) {
      assertJsonObject(input.artifact.metadata, "artifact metadata");
    }
  }
}

function assertVersion(
  version: HarnessFileContentVersion | undefined,
  label: string,
): void {
  if (version === undefined) return;
  if (!Number.isSafeInteger(version.bytes) || version.bytes < 0) {
    throw new Error(`Harness file ${label} bytes must be a non-negative safe integer.`);
  }
  if (!/^[a-f0-9]{64}$/u.test(version.sha256)) {
    throw new Error(`Harness file ${label} sha256 must be lowercase hexadecimal.`);
  }
}

function assertOptionalFileVersion(
  bytes: number | undefined,
  sha256: string | undefined,
  label: string,
): void {
  if (bytes !== undefined && (!Number.isSafeInteger(bytes) || bytes < 0)) {
    throw new Error(`Harness file ${label} bytes must be a non-negative safe integer.`);
  }
  if (sha256 !== undefined && !/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new Error(`Harness file ${label} sha256 must be lowercase hexadecimal.`);
  }
}

function assertJsonObject(value: JsonObject, label: string): void {
  let remainingNodes = MAX_JSON_NODES;
  let remainingBytes = MAX_JSON_DOCUMENT_BYTES;
  const consumeBytes = (bytes: number): void => {
    remainingBytes -= bytes;
    if (remainingBytes < 0) {
      throw new Error(
        `Harness file event ${label} exceeds the ${MAX_JSON_DOCUMENT_BYTES}-byte JSON limit.`,
      );
    }
  };
  const visit = (candidate: unknown, depth: number): void => {
    remainingNodes -= 1;
    if (remainingNodes < 0 || depth > MAX_JSON_DEPTH) {
      throw new Error(`Harness file event ${label} exceeds JSON complexity limits.`);
    }
    if (candidate === null) {
      consumeBytes(4);
      return;
    }
    if (typeof candidate === "string") {
      assertBoundedString(candidate, `${label} string`, MAX_JSON_STRING_BYTES);
      consumeBytes(jsonStringEncodedByteLength(candidate));
      return;
    }
    if (typeof candidate === "boolean") {
      consumeBytes(candidate ? 4 : 5);
      return;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new Error(`Harness file event ${label} must contain finite JSON numbers.`);
      }
      consumeBytes(Buffer.byteLength(String(candidate), "utf8"));
      return;
    }
    if (typeof candidate !== "object") {
      throw new Error(`Harness file event ${label} must contain only JSON values.`);
    }
    if (Array.isArray(candidate)) {
      if (candidate.length > MAX_JSON_NODES) {
        throw new Error(`Harness file event ${label} exceeds JSON complexity limits.`);
      }
      consumeBytes(2);
      const ownKeys = Reflect.ownKeys(candidate);
      if (
        ownKeys.some(
          (key) =>
            typeof key !== "string" ||
            (key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key)),
        )
      ) {
        throw new Error(`Harness file event ${label} arrays cannot contain custom or symbol keys.`);
      }
      for (let index = 0; index < candidate.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.enumerable !== true
        ) {
          throw new Error(
            `Harness file event ${label} arrays must be dense enumerable data properties.`,
          );
        }
        if (index > 0) consumeBytes(1);
        visit(descriptor.value, depth + 1);
      }
      return;
    }
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`Harness file event ${label} must contain only plain JSON objects.`);
    }
    consumeBytes(2);
    const keys = Reflect.ownKeys(candidate);
    for (const [index, key] of keys.entries()) {
      if (typeof key !== "string") {
        throw new Error(`Harness file event ${label} cannot contain symbol keys.`);
      }
      assertBoundedString(key, `${label} key`, MAX_JSON_KEY_BYTES);
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw new Error(`Harness file event ${label} fields must be enumerable data properties.`);
      }
      if (index > 0) consumeBytes(1);
      consumeBytes(jsonStringEncodedByteLength(key) + 1);
      visit(descriptor.value, depth + 1);
    }
  };
  visit(value, 0);
}

function assertBoundedString(value: string, label: string, maxBytes: number): void {
  if (typeof value !== "string") {
    throw new Error(`Harness file event ${label} must be a string.`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`Harness file event ${label} exceeds the ${maxBytes}-byte limit.`);
  }
}

/** Returns the UTF-8 byte length JSON.stringify would use without allocating it. */
function jsonStringEncodedByteLength(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (
      codeUnit === 0x22 ||
      codeUnit === 0x5c ||
      codeUnit === 0x08 ||
      codeUnit === 0x09 ||
      codeUnit === 0x0a ||
      codeUnit === 0x0c ||
      codeUnit === 0x0d
    ) {
      bytes += 2;
    } else if (codeUnit <= 0x1f) {
      bytes += 6;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      bytes += 6;
    } else if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function rootFromPath(pathname: string): string | undefined {
  return pathname.split("/").filter(Boolean)[0];
}

function fileMetadata(
  ref: Pick<FileRef, "path" | "bytes" | "mediaType" | "sha256">,
  source: string | undefined,
  metadata: JsonObject | undefined,
): JsonObject {
  const out: JsonObject = { path: ref.path };
  if (ref.bytes !== undefined) out.bytes = ref.bytes;
  if (ref.mediaType !== undefined) out.mediaType = ref.mediaType;
  if (ref.sha256 !== undefined) out.sha256 = ref.sha256;
  if (source !== undefined) out.source = source;
  if (metadata !== undefined) out.metadata = metadata;
  return out;
}
