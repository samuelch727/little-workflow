import type {
  ArtifactRef,
  FileContent,
  FileData,
  FileRef,
  FileWriter,
  HarnessArtifactAccessor,
  HarnessEvent,
  JsonObject,
  ReadFileOptions,
  WriteFileOptions,
} from "../types.js";
import { sha256Hex } from "../ids.js";
import { createTraceDiff } from "../trace/diff.js";
import { redactionReasonForPath } from "../trace/redaction.js";
import type { ResolvedHarnessTraceOptions } from "../trace/types.js";

type TurnEvent = Omit<HarnessEvent, "timestamp" | "sessionId">;

export type EventedFileWriterOptions = {
  defaultSource?: string;
  traceOptions: ResolvedHarnessTraceOptions;
};

export function createEventedFileWriter(
  base: FileWriter,
  emit: (event: TurnEvent) => Promise<void>,
  options: EventedFileWriterOptions,
): FileWriter {
  return {
    write: (targetPath, content, writeOptions) =>
      writeWithEvents(base, emit, targetPath, content, options, writeOptions),
    writeText: (targetPath, text, writeOptions) =>
      writeWithEvents(base, emit, targetPath, text, options, writeOptions),
    writeJSON: (targetPath, value, writeOptions) =>
      writeWithEvents(base, emit, targetPath, JSON.stringify(value, null, 2), options, {
        ...writeOptions,
        mediaType: writeOptions?.mediaType ?? "application/json",
      }),
    read: (targetPath, readOptions) => base.read(targetPath, readOptions),
    list: (targetPath, listOptions) => base.list(targetPath, listOptions),
    remove: async (targetPath, removeOptions) => {
      const before = await deletedFileSnapshots(base, targetPath, removeOptions);
      await base.remove(targetPath, removeOptions);
      for (const deleted of before) {
        await emit({
          type: "harness.file.deleted",
          metadata: {
            path: deleted.path,
            root: rootFromPath(deleted.path),
            ...(options.defaultSource ? { source: options.defaultSource } : {}),
            before: binaryMetadata(deleted.content),
            diff: { available: false, reason: "content_unavailable" },
          },
        });
      }
    },
  };
}

export function createArtifactAccessor(
  files: FileWriter,
  artifacts: { list(): Promise<ArtifactRef[]> },
): HarnessArtifactAccessor {
  return {
    list: () => artifacts.list() as Promise<any[]>,
    read(artifactPath, options) {
      if (artifactPath !== "/artifacts" && !artifactPath.startsWith("/artifacts/")) {
        throw new Error(`Artifact paths must be inside /artifacts: ${artifactPath}`);
      }
      return files.read(artifactPath, options);
    },
  };
}

async function writeWithEvents(
  base: FileWriter,
  emit: (event: TurnEvent) => Promise<void>,
  targetPath: string,
  content: FileContent,
  eventOptions: EventedFileWriterOptions,
  writeOptions: WriteFileOptions = {},
): Promise<FileRef> {
  const before = await readOptional(base, targetPath);
  const ref = await base.write(targetPath, content, writeOptions);
  const after = await base.read(targetPath);
  const source = writeOptions.source ?? eventOptions.defaultSource;
  const metadata = {
    ...fileMetadata(ref, source, writeOptions.metadata),
    root: rootFromPath(ref.path),
    ...(before ? { before: binaryMetadata(before.content) } : {}),
    after: binaryMetadata(after.content),
    diff: redactionReasonForPath(ref.path, eventOptions.traceOptions)
      ? { available: false as const, reason: "redacted" as const }
      : await createTraceDiff(before?.content, after.content, eventOptions.traceOptions, {
          files: base,
          path: ref.path,
        }),
  };

  await emit({
    type: before ? "harness.file.updated" : "harness.file.created",
    metadata,
  });

  if (source === "tool") {
    await emit({
      type: "harness.file.written_by_tool",
      metadata,
    });
  }

  if (ref.artifact) {
    await emit({
      type: "harness.artifact.created",
      metadata: {
        ...fileMetadata(ref.artifact, source, ref.artifact.metadata),
        artifact: ref.artifact,
      },
    });
  }

  return ref;
}

async function readOptional(files: FileWriter, targetPath: string): Promise<FileData | undefined> {
  try {
    return await files.read(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    return undefined;
  }
}

async function deletedFileSnapshots(
  files: FileWriter,
  targetPath: string,
  removeOptions: Parameters<FileWriter["remove"]>[1],
): Promise<Array<{ path: string; content: Uint8Array }>> {
  const file = await readOptional(files, targetPath);
  if (file) {
    return [{ path: targetPath, content: file.content }];
  }

  if (!removeOptions?.recursive) {
    return [];
  }

  const entries = await files.list(targetPath, { recursive: true }).catch(() => []);
  const snapshots: Array<{ path: string; content: Uint8Array }> = [];
  for (const entry of entries) {
    if (entry.kind !== "file") {
      continue;
    }
    const child = await readOptional(files, entry.path);
    if (child) {
      snapshots.push({ path: entry.path, content: child.content });
    }
  }
  return snapshots.sort((left, right) => left.path.localeCompare(right.path));
}

function binaryMetadata(content: Uint8Array): { bytes: number; sha256: string } {
  return { bytes: content.byteLength, sha256: sha256Hex(content) };
}

function rootFromPath(pathname: string): string | undefined {
  return pathname.split("/").filter(Boolean)[0];
}

function fileMetadata(
  ref: FileRef,
  source: string | undefined,
  metadata: JsonObject | undefined,
): JsonObject {
  const out: JsonObject = {
    path: ref.path,
  };
  if (ref.bytes !== undefined) {
    out.bytes = ref.bytes;
  }
  if (ref.mediaType !== undefined) {
    out.mediaType = ref.mediaType;
  }
  if (ref.sha256 !== undefined) {
    out.sha256 = ref.sha256;
  }
  if (source !== undefined) {
    out.source = source;
  }
  if (metadata !== undefined) {
    out.metadata = metadata;
  }
  return out;
}
