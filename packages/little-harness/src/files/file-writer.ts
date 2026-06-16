import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { sha256Hex } from "../ids.js";
import type { LocalSessionPaths } from "../local-host/paths.js";
import type {
  ArtifactRef,
  FileContent,
  FileData,
  FileEntry,
  FileRef,
  FileWriter,
  ListFilesOptions,
  ReadFileOptions,
  RemoveFileOptions,
  WriteFileOptions,
} from "../types.js";
import { fileSize } from "./diff.js";
import { resolveHarnessPath, toHarnessPath, type ManagedRoot } from "./path-policy.js";

export type LocalFileWriterOptions = {
  getReadOnlyPersistentDirs?: () => readonly string[];
  bypassReadOnlyPersistentDirs?: boolean;
};

export function createLocalFileWriter(
  paths: LocalSessionPaths,
  options: LocalFileWriterOptions = {},
): FileWriter {
  return {
    write: (targetPath, content, writeOptions) =>
      writeFileAt(paths, targetPath, content, options, writeOptions),
    writeText: (targetPath, text, writeOptions) =>
      writeFileAt(paths, targetPath, text, options, writeOptions),
    writeJSON: (targetPath, value, writeOptions) =>
      writeFileAt(paths, targetPath, JSON.stringify(value, null, 2), options, {
        ...writeOptions,
        mediaType: writeOptions?.mediaType ?? "application/json",
      }),
    read: (targetPath, options) => readFileAt(paths, targetPath, options),
    list: (targetPath, options) => listFilesAt(paths, targetPath, options),
    remove: (targetPath, removeOptions) => removeFileAt(paths, targetPath, options, removeOptions),
  };
}

async function writeFileAt(
  paths: LocalSessionPaths,
  targetPath: string,
  content: FileContent,
  fileWriterOptions: LocalFileWriterOptions,
  options: WriteFileOptions = {},
): Promise<FileRef> {
  const resolved = resolveHarnessPath(paths, targetPath, "write", {
    readOnlyPersistentDirs: fileWriterOptions.getReadOnlyPersistentDirs?.() ?? [],
    bypassReadOnly: fileWriterOptions.bypassReadOnlyPersistentDirs,
  });
  const bytes = await toUint8Array(content);

  await mkdir(path.dirname(resolved.realPath), { recursive: true });
  await writeFile(resolved.realPath, bytes);

  const sha256 = sha256Hex(bytes);
  const ref: FileRef = {
    path: resolved.harnessPath,
    bytes: bytes.byteLength,
    sha256,
  };

  if (options.mediaType !== undefined) {
    ref.mediaType = options.mediaType;
  }

  if (resolved.root === "artifacts" || options.artifact) {
    const artifact: ArtifactRef = {
      id: resolved.harnessPath,
      path: resolved.harnessPath,
      bytes: bytes.byteLength,
      sha256,
    };

    if (options.mediaType !== undefined) {
      artifact.mediaType = options.mediaType;
    }

    const metadata = typeof options.artifact === "object" ? options.artifact.metadata : options.metadata;
    if (metadata !== undefined) {
      artifact.metadata = metadata;
    }

    ref.artifact = artifact;
  }

  return ref;
}

async function readFileAt(
  paths: LocalSessionPaths,
  targetPath: string,
  _options: ReadFileOptions = {},
): Promise<FileData> {
  const resolved = resolveHarnessPath(paths, targetPath, "read");
  const content = await readFile(resolved.realPath);

  return {
    path: resolved.harnessPath,
    content,
    text: () => new TextDecoder().decode(content),
    json: <T>() => JSON.parse(new TextDecoder().decode(content)) as T,
  };
}

async function listFilesAt(
  paths: LocalSessionPaths,
  targetPath: string,
  options: ListFilesOptions = {},
): Promise<FileEntry[]> {
  const resolved = resolveHarnessPath(paths, targetPath, "list");
  const out: FileEntry[] = [];
  await collect(resolved.realPath, resolved.root, resolved.relativePath, out, options.recursive ?? false);
  return out;
}

async function removeFileAt(
  paths: LocalSessionPaths,
  targetPath: string,
  fileWriterOptions: LocalFileWriterOptions,
  options: RemoveFileOptions = {},
): Promise<void> {
  const resolved = resolveHarnessPath(paths, targetPath, "delete", {
    readOnlyPersistentDirs: fileWriterOptions.getReadOnlyPersistentDirs?.() ?? [],
    bypassReadOnly: fileWriterOptions.bypassReadOnlyPersistentDirs,
  });
  await rm(resolved.realPath, { recursive: options.recursive ?? false, force: false });
}

async function collect(
  realDir: string,
  root: ManagedRoot,
  relativeDir: string,
  out: FileEntry[],
  recursive: boolean,
): Promise<void> {
  const entries = await readdir(realDir, { withFileTypes: true });

  for (const entry of entries) {
    const relative = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
    const entryPath = toHarnessPath(root, relative);
    const realPath = path.join(realDir, entry.name);

    if (entry.isDirectory()) {
      out.push({ path: entryPath, kind: "directory" });
      if (recursive) {
        await collect(realPath, root, relative, out, recursive);
      }
    } else if (entry.isFile()) {
      const bytes = await fileSize(realPath);
      out.push(
        bytes === undefined
          ? { path: entryPath, kind: "file" }
          : { path: entryPath, kind: "file", bytes },
      );
    }
  }
}

async function toUint8Array(content: FileContent): Promise<Uint8Array> {
  if (typeof content === "string") {
    return new TextEncoder().encode(content);
  }

  if (content instanceof Uint8Array) {
    return content;
  }

  if (content instanceof ArrayBuffer) {
    return new Uint8Array(content);
  }

  const chunks: Uint8Array[] = [];
  const reader = content.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      chunks.push(value);
    }
  }

  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return out;
}
