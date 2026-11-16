import type { FileData, FileWriter, ReadFileOptions } from "../types.js";

export const TRACE_CONTENT_PREFIX = "/.little-harness/trace/";
export const LEGACY_TRACE_CONTENT_PREFIX = "/artifacts/trace/";

export type TraceContentStore = {
  read(contentRef: string, options?: ReadFileOptions): Promise<FileData>;
  write(contentRef: string, text: string): Promise<void>;
};

// Internal host capability registry. Do not re-export from public package entry points.
// A first-party host with its own FileWriter reaches it through `@little-stack/harness/internals`.
const stores = new WeakMap<FileWriter, TraceContentStore>();
export function attachTraceContentStore(files: FileWriter, store: TraceContentStore): void {
  stores.set(files, store);
}
export function traceContentStoreFor(files: FileWriter): TraceContentStore | undefined {
  return stores.get(files);
}

export function traceContentRelativePath(ref: string): string {
  if (!ref.startsWith(TRACE_CONTENT_PREFIX)) throw new Error(`Invalid trace content reference: ${ref}`);
  const relative = ref.slice(TRACE_CONTENT_PREFIX.length);
  if (!relative || relative.split("/").some((part) => !part || part === "." || part === ".." || part.includes("\\") || part.includes("\0"))) {
    throw new Error(`Invalid trace content reference: ${ref}`);
  }
  return relative;
}

export function isTraceContentRef(ref: string): boolean {
  return ref.startsWith(TRACE_CONTENT_PREFIX) || ref.startsWith(LEGACY_TRACE_CONTENT_PREFIX);
}

export function createTraceContentStore(
  files: FileWriter,
  readBytes: (relative: string) => Promise<Uint8Array>,
  writeText: (relative: string, text: string) => Promise<void>,
): TraceContentStore {
  return {
    async read(ref, options) {
      if (ref.startsWith(LEGACY_TRACE_CONTENT_PREFIX)) return files.read(ref, options);
      const content = await readBytes(traceContentRelativePath(ref));
      return { path: ref, content, text: () => new TextDecoder().decode(content), json: () => JSON.parse(new TextDecoder().decode(content)) };
    },
    write: (ref, text) => writeText(traceContentRelativePath(ref), text),
  };
}
