import { readdir, readFile } from "node:fs/promises";
import { createLocalFileWriter } from "../files/file-writer.js";
import { resolveLocalHostPaths, sessionPaths } from "../local-host/paths.js";
import {
  LocalSessionStore,
  type LocalHarnessSession,
} from "../local-host/session-store.js";
import type { ArtifactRef, FileEntry, HarnessEvent, HarnessSessionStatus, JsonObject } from "../types.js";
import { validateTraceEvent, type HarnessTraceEventType } from "./validate.js";

const MANAGED_ROOTS = ["/session", "/artifacts", "/.agents", "/persistent"] as const;
const FAILURE_TYPES = new Set([
  "harness.session.failed",
  "harness.model.failed",
  "harness.tool_call.failed",
  "harness.persistent_dir.commit.failed",
  "harness.runtime.error",
]);

export type TraceEvent = HarnessEvent<HarnessTraceEventType> & {
  schemaVersion: "lh.trace.v2";
  eventId: string;
  sequence: number;
};

export type TraceReadError = {
  line: number;
  message: string;
};

export type DoctorSummary = {
  sessionId: string;
  eventCount: number;
  invalidEventCount: number;
  failureCount: number;
  spooledOutputCount: number;
  contentRefCount: number;
  largeTraceArtifactCount: number;
  redactionCount: number;
  failures: Array<Pick<TraceEvent, "eventId" | "sequence" | "type">>;
  invalidEvents: TraceReadError[];
};

export async function listLocalSessions(options: {
  dataDir: string;
  cwd?: string;
}): Promise<Array<HarnessSessionStatus & { tracePath: string; artifactCount: number }>> {
  const paths = resolveLocalHostPaths({ dataDir: options.dataDir }, options.cwd);
  const entries = await safeReaddir(paths.sessionsDir);
  const sessions: Array<HarnessSessionStatus & { tracePath: string; artifactCount: number }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const session = sessionPaths(paths, entry.name);
    const status = JSON.parse(await readFile(session.statusFile, "utf8")) as HarnessSessionStatus;
    const files = createLocalFileWriter(session);
    const artifacts = await files
      .list("/artifacts", { recursive: true })
      .catch(() => [] as FileEntry[]);
    sessions.push({
      ...status,
      tracePath: session.traceFile,
      artifactCount: artifacts.filter((artifact) => artifact.kind === "file").length,
    });
  }

  return sessions.sort((left, right) => left.id.localeCompare(right.id));
}

export async function readLocalTrace(options: {
  dataDir: string;
  sessionId: string;
  cwd?: string;
}): Promise<TraceEvent[]> {
  const session = await getSession(options);
  const result = await readTraceFile(session.paths.traceFile);
  if (result.errors.length > 0) {
    throw new Error(
      `Trace contains ${result.errors.length} invalid event(s). Run little-harness doctor ${options.sessionId}.`,
    );
  }
  return result.events;
}

export async function listLocalFiles(options: {
  dataDir: string;
  sessionId: string;
  cwd?: string;
}): Promise<FileEntry[]> {
  const session = await getSession(options);
  const entries: FileEntry[] = [];

  for (const root of MANAGED_ROOTS) {
    const listed = await session.files
      .list(root, { recursive: true })
      .catch(() => [] as FileEntry[]);
    entries.push(...listed);
  }

  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export async function listLocalArtifacts(options: {
  dataDir: string;
  sessionId: string;
  cwd?: string;
}): Promise<ArtifactRef[]> {
  const session = await getSession(options);
  return session.artifacts.list();
}

export async function latestDiffForPath(options: {
  dataDir: string;
  sessionId: string;
  path: string;
  cwd?: string;
}): Promise<{ eventId: string; sequence: number; path: string; diff: unknown } | undefined> {
  const session = await getSession(options);
  const trace = await readLocalTrace(options);

  for (const event of [...trace].reverse()) {
    const metadata = event.metadata;
    if (!isFileMutationEvent(event.type) || metadata?.path !== options.path) {
      continue;
    }

    return {
      eventId: event.eventId,
      sequence: event.sequence,
      path: options.path,
      diff: await hydrateDiffContent(metadata.diff, session),
    };
  }

  return undefined;
}

export async function doctorSession(options: {
  dataDir: string;
  sessionId: string;
  cwd?: string;
}): Promise<DoctorSummary> {
  const session = await getSession(options);
  const trace = await readTraceFile(session.paths.traceFile);
  const failures = trace.events.filter((event) => isFailureEvent(event.type));
  const contentRefs = trace.events.flatMap((event) => collectContentRefs(event.metadata));
  const traceArtifactRefs = contentRefs.filter((ref) => ref.startsWith("/artifacts/trace/"));

  return {
    sessionId: session.id,
    eventCount: trace.events.length,
    invalidEventCount: trace.errors.length,
    failureCount: failures.length,
    spooledOutputCount: trace.events.filter(hasSpooledToolOutput).length,
    contentRefCount: contentRefs.length,
    largeTraceArtifactCount: traceArtifactRefs.length,
    redactionCount: trace.events.filter((event) => hasRedaction(event.metadata)).length,
    failures: failures.map((event) => ({
      eventId: event.eventId,
      sequence: event.sequence,
      type: event.type,
    })),
    invalidEvents: trace.errors,
  };
}

async function getSession(options: {
  dataDir: string;
  sessionId: string;
  cwd?: string;
}): Promise<LocalHarnessSession> {
  const paths = resolveLocalHostPaths({ dataDir: options.dataDir }, options.cwd);
  const session = await new LocalSessionStore(paths).get(options.sessionId);
  if (!session) {
    throw new Error(`Session not found: ${options.sessionId}`);
  }
  return session;
}

async function readTraceFile(
  pathname: string,
): Promise<{ events: TraceEvent[]; errors: TraceReadError[] }> {
  const text = await readFile(pathname, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  const events: TraceEvent[] = [];
  const errors: TraceReadError[] = [];

  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === "") {
      continue;
    }

    try {
      events.push(validateTraceEvent(JSON.parse(line)) as TraceEvent);
    } catch (error) {
      errors.push({
        line: index + 1,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { events, errors };
}

async function hydrateDiffContent(
  diff: unknown,
  session: LocalHarnessSession,
): Promise<unknown> {
  if (!isObject(diff) || diff.available !== true || typeof diff.contentRef !== "string") {
    return diff;
  }
  if (!diff.contentRef.startsWith("/artifacts/trace/")) {
    return diff;
  }

  const content = (await session.files.read(diff.contentRef)).text();
  return { ...diff, content };
}

function isFileMutationEvent(type: string): boolean {
  return type === "harness.file.created" || type === "harness.file.updated" || type === "harness.file.deleted";
}

function isFailureEvent(type: string): boolean {
  return FAILURE_TYPES.has(type) || type.endsWith(".failed");
}

function hasRedaction(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasRedaction);
  }
  if (!isObject(value)) {
    return false;
  }
  if (value.redacted === true) {
    return true;
  }
  return Object.values(value).some(hasRedaction);
}

function collectContentRefs(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectContentRefs);
  }
  if (!isObject(value)) {
    return [];
  }

  const refs: string[] = [];
  if (typeof value.contentRef === "string") {
    refs.push(value.contentRef);
  }
  for (const child of Object.values(value)) {
    refs.push(...collectContentRefs(child));
  }
  return refs;
}

function hasSpooledToolOutput(event: TraceEvent): boolean {
  if (!event.type.startsWith("harness.tool_call.")) {
    return false;
  }
  const spooled = event.metadata?.spooled;
  return isObject(spooled) && typeof spooled.path === "string";
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function safeReaddir(pathname: string) {
  try {
    return await readdir(pathname, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
