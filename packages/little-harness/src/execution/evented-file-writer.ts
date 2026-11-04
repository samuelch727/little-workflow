import type {
  ArtifactRef,
  FileContent,
  FileData,
  FileRef,
  FileWriter,
  HarnessArtifactAccessor,
  HarnessEvent,
  ReadFileOptions,
  WriteFileOptions,
} from "../types.js";
import { createEventId, sha256Hex } from "../ids.js";
import { createTraceDiff } from "../trace/diff.js";
import { redactionReasonForPath } from "../trace/redaction.js";
import type { ResolvedHarnessTraceOptions } from "../trace/types.js";
import { createHarnessFileMutationEvents } from "../remote-session/file-events.js";

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
    get limits() { return base.limits; },
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
        for (const event of createHarnessFileMutationEvents({
          occurrenceId: createEventId(),
          kind: "deleted",
          file: { path: deleted.path },
          ...(options.defaultSource === undefined ? {} : { source: options.defaultSource }),
          before: binaryMetadata(deleted.content),
          diff: { available: false, reason: "content_unavailable" },
        })) await emit(event);
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
  const afterVersion = binaryMetadata(after.content);
  const events = createHarnessFileMutationEvents({
    occurrenceId: createEventId(),
    kind: before ? "updated" : "created",
    file: ref,
    ...(source === undefined ? {} : { source }),
    ...(writeOptions.metadata === undefined ? {} : { metadata: writeOptions.metadata }),
    ...(before === undefined ? {} : { before: binaryMetadata(before.content) }),
    after: afterVersion,
    diff: redactionReasonForPath(ref.path, eventOptions.traceOptions)
      ? { available: false as const, reason: "redacted" as const }
      : await createTraceDiff(before?.content, after.content, eventOptions.traceOptions, {
          files: base,
          path: ref.path,
        }),
    ...(ref.artifact === undefined ? {} : { artifact: ref.artifact }),
  });
  for (const event of events) await emit(event);

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
