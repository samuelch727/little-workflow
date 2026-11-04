import type { ComputeUsage, Environment, SpanInput, TraceInput, Trigger } from "../contract.js";
import type { Exporter, LittleDBErrorHandler } from "../exporter.js";
import type { MemoryLinks } from "../memory.js";
import type { Resolution } from "../resolve.js";
import {
  boundedId,
  clipText,
  contentText,
  contentTruncated,
  contentValue,
  environmentFor,
  errorInfo,
  isRecord,
  messageContent,
  providerName,
  sha256Hex,
  stringValue,
  toLittleDBCompute,
  toLittleDBUsage,
  toTrigger,
} from "../util.js";

/**
 * The parts of a harness event the tracer reads. `HarnessEvent` from `@little-stack/harness`
 * fits it, so `onEvent` can be handed straight to `createHarness` or `generateHarness`.
 */
export type HarnessEventLike = {
  readonly type: string;
  readonly sessionId: string;
  readonly turnId?: string | undefined;
  readonly stepId?: string | undefined;
  readonly occurrenceId?: string | undefined;
  readonly eventId?: string | undefined;
  readonly timestamp: string;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
};

export type HarnessTracerOptions = {
  /** The harness's slug in LittleDB, the same one you resolve. */
  readonly harness: string;
  /** What `resolve` returned for this session: its version id, and `trial` and `holdout` traffic is tagged as such. */
  readonly resolution?: Pick<Resolution, "versionId" | "mode"> | undefined;
  /**
   * What `resolve` returned for each session, for one tracer shared by many sessions on
   * different versions (`managedHarness` passes it). Asked when a turn begins; wins over `resolution`.
   */
  readonly resolutionFor?: ((sessionId: string) => Pick<Resolution, "versionId" | "mode"> | undefined) | undefined;
  /** The LittleDB version this session runs on, when you have it without a resolution. */
  readonly versionId?: string | null | undefined;
  /**
   * Default `production`: `trial` or `holdout` from the resolution, and `experiment` for a turn
   * inside an eval worker run (an agent the run's workflow calls).
   */
  readonly environment?: Environment | undefined;
  readonly userId?: string | undefined;
  /** Set by an eval worker run: the experiment and dataset item the trace belongs to. */
  readonly experimentId?: string | undefined;
  readonly datasetItemId?: string | undefined;
  /**
   * Put everything this tracer sees in ONE trace with this id, each turn a child of a root span.
   * An eval worker passes the claimed run's `traceId`, so a multi-turn episode is one trace.
   * Without it each turn is its own trace (see {@link turnTraceId}).
   */
  readonly traceId?: string | undefined;
  /** Your own id per turn, instead of {@link turnTraceId}. Ignored with `traceId`. */
  readonly traceIdFor?: ((sessionId: string, turnId: string) => string) | undefined;
  /** The trace and root span name. Default `turn` (`session` with `traceId`). */
  readonly name?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  /** Send prompts, messages, tool inputs and outputs. Default `true`. */
  readonly captureContent?: boolean | undefined;
};

export type HarnessTracer = {
  /** The harness `onEvent` hook. Never throws and never waits on the network. */
  readonly onEvent: (event: HarnessEventLike) => Promise<void>;
  /** The trace of the session's latest turn, to attach scores or feedback to. */
  traceIdFor(sessionId: string): string | undefined;
  /**
   * The trace this tracer writes (or wrote) for one turn: {@link turnTraceId} unless you gave it
   * `traceIdFor` or `traceId`. A turn's id is on every harness event (`event.turnId`).
   */
  traceIdForTurn(sessionId: string, turnId: string): string;
  /** Every trace this tracer wrote for the session, oldest first (bounded). */
  traceIdsFor(sessionId: string): readonly string[];
  /** Send what is queued now. */
  flush(): Promise<void>;
};

/** The default trace id of one harness turn: stable, so a replayed turn updates the same trace. */
export function turnTraceId(sessionId: string, turnId: string): string {
  return `lh_${sha256Hex(`${sessionId}\n${turnId}`).slice(0, 32)}`;
}

/**
 * Which trace each harness turn went to, shared by the tracers and tracing worlds of one client,
 * so a workflow run a tool call started finds its turn's trace even under `traceIdFor` or `traceId`.
 */
export type TurnTraceIds = {
  set(sessionId: string, turnId: string, traceId: string): void;
  get(sessionId: string, turnId: string): string | undefined;
};

const MAX_TURN_TRACE_IDS = 10_000;

export function createTurnTraceIds(): TurnTraceIds {
  const ids = new Map<string, string>();
  const key = (sessionId: string, turnId: string) => `${sessionId}\u0000${turnId}`;
  return {
    set(sessionId, turnId, traceId) {
      ids.delete(key(sessionId, turnId));
      ids.set(key(sessionId, turnId), traceId);
      while (ids.size > MAX_TURN_TRACE_IDS) {
        const oldest = ids.keys().next().value;
        if (oldest === undefined) break;
        ids.delete(oldest);
      }
    },
    get: (sessionId, turnId) => ids.get(key(sessionId, turnId)),
  };
}

/** What the person typed: a message's text parts, without images or tool parts. */
function userText(reference: unknown): string | undefined {
  if (isRecord(reference) && reference.captured === false) return undefined;
  // Harness events carry content as a reference whose preview is the JSON of the parts.
  const content = isRecord(reference) && typeof reference.preview === "string" ? contentValue(reference) : reference;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .filter((t) => t.length > 0)
    .join("\n");
  return text.length > 0 ? text : undefined;
}

type UnavailableContent = { unavailable: true; reason: "storage_limit"; bytes?: number; sha256?: string; storageLimitBytes?: number };

/** Non-null evidence of missing content also replaces stale values in merge-based stores. */
function unavailableContent(value: unknown): UnavailableContent | undefined {
  if (!isRecord(value) || value.captured !== false || value.unavailableReason !== "storage_limit") return undefined;
  return {
    unavailable: true,
    reason: "storage_limit",
    ...(typeof value.bytes === "number" ? { bytes: value.bytes } : {}),
    ...(typeof value.sha256 === "string" ? { sha256: value.sha256 } : {}),
    ...(typeof value.storageLimitBytes === "number" ? { storageLimitBytes: value.storageLimitBytes } : {}),
  };
}

function unavailablePreview(value: unknown): string | undefined {
  return isRecord(value) && value.unavailableReason === "storage_limit" && typeof value.preview === "string" ? clipText(value.preview, 512) : undefined;
}

function contentStatus(input: unknown, output: unknown, inputPreview?: string, outputPreview?: string): Record<string, unknown> {
  const missingInput = isRecord(input) && input.unavailable === true ? input : undefined;
  const missingOutput = isRecord(output) && output.unavailable === true ? output : undefined;
  return missingInput === undefined && missingOutput === undefined ? {} : {
    truncated: true,
    contentUnavailable: { ...(missingInput === undefined ? {} : { input: missingInput }), ...(missingOutput === undefined ? {} : { output: missingOutput }) },
    ...(inputPreview === undefined && outputPreview === undefined ? {} : { contentPreview: { ...(inputPreview === undefined ? {} : { input: inputPreview }), ...(outputPreview === undefined ? {} : { output: outputPreview }) } }),
  };
}

/** The trigger a turn's `harness.session.started` carries as `triggerKind`, `triggerSource`, ... metadata. */
function sessionTrigger(metadata: Readonly<Record<string, unknown>>): Trigger | undefined {
  return toTrigger({
    kind: metadata.triggerKind,
    source: metadata.triggerSource,
    from: metadata.triggerFrom,
    label: metadata.triggerLabel,
  });
}

type OpenSpan = {
  readonly id: string;
  readonly name: string;
  readonly type: "llm" | "tool";
  readonly startTime: string;
  readonly input?: unknown;
  readonly model?: string;
  readonly provider?: string;
  readonly attributes: Record<string, unknown>;
  /** A tool step's reads and writes in managed memory, sent as its `memoryAccess` attribute. */
  memory?: MemoryAccess;
};

// --- Memory files a step touched ------------------------------------------------------------------

/** A file in a managed memory a step read, wrote or deleted; a read names the revision it saw. */
type MemoryTouch = { harnessDir: string; layer: "org" | "user"; space: string; path: string; op: "read" | "write" | "delete"; revision?: string };
/**
 * What a tool step did with managed memory: exact for the memory file tools; for bash, read off
 * the command (and a search's output), while its writes come from the harness's file events.
 */
type MemoryAccess = { how: "tool" | "command"; files: MemoryTouch[]; listed: string[]; search: boolean };

const MEMORY_FILE_TOOLS: Readonly<Record<string, "read" | "list" | "write" | "delete">> = {
  read_file: "read",
  list_files: "list",
  write_file: "write",
  delete_file: "delete",
};
/** Commands whose output lines start with the paths they matched. */
const SEARCH_COMMAND = /(?:^|[\s;|&(])(?:grep|egrep|fgrep|rg|ag|ack)\s/u;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Absolute paths inside any of `dirs` named in some text (a command, a search's output), and whether a glob follows. */
function memoryPathsIn(text: string, dirs: readonly string[]): { path: string; glob: boolean }[] {
  const found: { path: string; glob: boolean }[] = [];
  for (const dir of dirs) {
    const pattern = new RegExp(`${escapeRegExp(dir)}(?=$|[/\\s'"\`;|&<>():*?])(?:/[^\\s'"\`;|&<>():*?]*)?`, "gu");
    for (const match of text.matchAll(pattern)) {
      const path = match[0].replace(/\/+$/u, "");
      const glob = text[match.index + match[0].length] === "*";
      if (!found.some((f) => f.path === path && f.glob === glob)) found.push({ path, glob });
    }
  }
  return found;
}

type Turn = {
  readonly sessionId: string;
  /** In every child span's id: turns can share a trace (`traceId`), and the same tool call id or memory may come up in each. */
  readonly turnId: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentId: string | null;
  readonly startTime: string;
  readonly versionId: string | undefined;
  readonly environment: Environment;
  input?: unknown;
  output?: string | UnavailableContent;
  inputPreview?: string | undefined;
  outputPreview?: string | undefined;
  trigger?: Trigger;
  /** What the turn ran on, from `harness.runtime.usage`; sent on the trace row. */
  compute?: ComputeUsage;
  readonly open: Map<string, OpenSpan>;
};

type SharedRoot = { readonly startTime: string; input?: unknown; inputPreview?: string | undefined; failed: boolean; unavailableWritten?: boolean };

const MAX_OPEN_TURNS = 1_000;
const MAX_SESSIONS = 10_000;
const MAX_TRACES_PER_SESSION = 200;

export function createHarnessTracer(
  options: HarnessTracerOptions,
  deps: { readonly exporter: Exporter; readonly onError: LittleDBErrorHandler; readonly turnTraceIds?: TurnTraceIds; readonly memoryLinks?: MemoryLinks },
): HarnessTracer {
  const capture = options.captureContent !== false;
  const fixedTrace = options.traceId;
  const name = clipText(options.name ?? (fixedTrace === undefined ? "turn" : "session"), 500);
  const turns = new Map<string, Turn>();
  const sessions = new Map<string, string[]>();
  let shared: SharedRoot | undefined;
  // With `traceId` every turn shares one trace, which keeps the trigger of the turn that began it.
  let sharedTriggered = false;

  const traceIdForTurn = (sessionId: string, turnId: string): string =>
    fixedTrace ?? options.traceIdFor?.(sessionId, turnId) ?? turnTraceId(sessionId, turnId);

  const send = (traces: TraceInput[], spans: SpanInput[]) => deps.exporter.enqueue({ traces, spans });

  /** Where an absolute path sits among the memories this session loaded. */
  function memoryAt(sessionId: string, path: string) {
    for (const { harnessDir, link } of deps.memoryLinks?.loadsOf(sessionId) ?? []) {
      if (path === harnessDir || path.startsWith(`${harnessDir}/`)) return { harnessDir, link, path: path.slice(harnessDir.length + 1) };
    }
    return undefined;
  }

  function touchMemory(access: MemoryAccess, sessionId: string, absolute: string, op: "read" | "list" | "write" | "delete", glob = false): void {
    const at = memoryAt(sessionId, absolute);
    if (at === undefined) return;
    const revisions = at.link.revisions ?? {};
    const known = Object.keys(revisions);
    const inside = (p: string) => at.path === "" || p.startsWith(`${at.path}/`);
    // A folder: listing or searching it isn't reading a file, but `cat folder/*` reads each one.
    const folder = at.path === "" || (revisions[at.path] === undefined && known.some(inside));
    if (op === "read" && folder) {
      if (glob) {
        for (const p of known.filter(inside)) touchMemory(access, sessionId, `${at.harnessDir}/${p}`, "read");
        return;
      }
      op = "list";
    }
    if (op === "list") {
      if (!access.listed.includes(at.link.space)) access.listed.push(at.link.space);
      return;
    }
    if (at.path === "") return;
    const existing = access.files.find((f) => f.harnessDir === at.harnessDir && f.path === at.path);
    if (existing !== undefined) {
      // A step that read a file and then changed it is remembered for the change.
      if (op !== "read") {
        existing.op = op;
        delete existing.revision;
      }
      return;
    }
    const revision = op === "read" ? revisions[at.path] : undefined;
    access.files.push({ harnessDir: at.harnessDir, layer: at.link.layer, space: at.link.space, path: at.path, op, ...(revision === undefined ? {} : { revision }) });
  }

  /** A tool step that starts in a session with managed memory: what its input says it reads. */
  function startMemoryAccess(sessionId: string, toolName: string, input: unknown): MemoryAccess | undefined {
    const loads = deps.memoryLinks?.loadsOf(sessionId) ?? [];
    if (loads.length === 0) return undefined;
    const op = MEMORY_FILE_TOOLS[toolName];
    const access: MemoryAccess = { how: op === undefined ? "command" : "tool", files: [], listed: [], search: false };
    if (op !== undefined) {
      const path = isRecord(input) ? stringValue(input.path) : undefined;
      if (path !== undefined) touchMemory(access, sessionId, path, op);
      else if (op === "list") for (const { harnessDir } of loads) touchMemory(access, sessionId, harnessDir, "list");
    } else if (toolName === "bash") {
      const command = isRecord(input) ? stringValue(input.command) : undefined;
      if (command !== undefined) {
        access.search = SEARCH_COMMAND.test(command);
        for (const { path, glob } of memoryPathsIn(command, loads.map((l) => l.harnessDir))) touchMemory(access, sessionId, path, "read", glob);
      }
    }
    return access;
  }

  /** A tool step's memory as its span sends it, and the steps that changed files, for the store. */
  function finishMemoryAccess(sessionId: string, open: OpenSpan, failed: boolean, output: unknown): Record<string, unknown> | undefined {
    const access = open.memory;
    if (access === undefined) return undefined;
    if (access.search && !failed) {
      // A search's hits are files it read: grep prints each match after its path.
      const out = contentValue(output);
      const stdout = isRecord(out) ? stringValue(out.stdout) : typeof out === "string" ? out : undefined;
      const dirs = (deps.memoryLinks?.loadsOf(sessionId) ?? []).map((l) => l.harnessDir);
      if (stdout !== undefined) for (const { path } of memoryPathsIn(stdout, dirs)) touchMemory(access, sessionId, path, "read");
    }
    // A failed step read nothing; what it changed on disk is still saved, so it still counts.
    const files = access.files.filter((f) => !failed || f.op !== "read");
    for (const f of files) if (f.op !== "read") deps.memoryLinks?.wrote(sessionId, f.harnessDir, f.path, open.id);
    if (files.length === 0 && access.listed.length === 0) return undefined;
    return {
      how: access.how,
      files: files.map(({ harnessDir: _dir, ...f }) => f),
      ...(access.listed.length === 0 ? {} : { listed: access.listed }),
    };
  }

  /** The version and environment of a turn that begins now, for this session. */
  const versionOf = (sessionId: string): { versionId: string | undefined; environment: Environment } => {
    const resolution = options.resolutionFor?.(sessionId) ?? options.resolution;
    const versionId = options.versionId ?? resolution?.versionId ?? undefined;
    return { versionId: versionId ?? undefined, environment: environmentFor(options.environment, resolution?.mode) };
  };

  const traceRow = (turn: Turn, trigger?: Trigger): TraceInput => ({
    id: turn.traceId,
    name,
    kind: options.experimentId === undefined ? "turn" : "experiment",
    harness: options.harness,
    ...(turn.versionId === undefined ? {} : { versionId: turn.versionId }),
    sessionId: turn.sessionId,
    ...(options.userId === undefined ? {} : { userId: options.userId }),
    environment: turn.environment,
    ...(options.experimentId === undefined ? {} : { experimentId: options.experimentId }),
    ...(options.datasetItemId === undefined ? {} : { datasetItemId: options.datasetItemId }),
    startTime: turn.startTime,
    ...(options.metadata === undefined ? {} : { metadata: { ...options.metadata } }),
    ...(options.tags === undefined ? {} : { tags: [...options.tags] }),
    ...(trigger === undefined ? {} : { trigger }),
    ...(turn.compute === undefined ? {} : { compute: turn.compute }),
  });

  const remember = (sessionId: string, traceId: string) => {
    const list = sessions.get(sessionId) ?? [];
    sessions.delete(sessionId);
    if (list.at(-1) !== traceId) list.push(traceId);
    if (list.length > MAX_TRACES_PER_SESSION) list.splice(0, list.length - MAX_TRACES_PER_SESSION);
    sessions.set(sessionId, list);
    while (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
  };

  /** The trigger this turn's trace row may carry: in a shared trace, only the first one. */
  function ownTrigger(trigger: Trigger | undefined): Trigger | undefined {
    if (trigger === undefined || fixedTrace === undefined) return trigger;
    if (sharedTriggered) return undefined;
    sharedTriggered = true;
    return trigger;
  }

  function beginTurn(event: HarnessEventLike, turnId: string, trigger?: Trigger): Turn {
    const key = `${event.sessionId}\u0000${turnId}`;
    const existing = turns.get(key);
    if (existing !== undefined) {
      // The turn began on an earlier event: send its row again, now with how it started.
      const late = existing.trigger === undefined ? ownTrigger(trigger) : undefined;
      if (late !== undefined) {
        existing.trigger = late;
        send([traceRow(existing, late)], []);
      }
      return existing;
    }
    const traceId = traceIdForTurn(event.sessionId, turnId);
    const turn: Turn = {
      sessionId: event.sessionId,
      turnId,
      traceId,
      spanId: fixedTrace === undefined ? "turn" : boundedId("turn", turnId),
      parentId: fixedTrace === undefined ? null : "root",
      startTime: event.timestamp,
      ...versionOf(event.sessionId),
      open: new Map(),
    };
    const own = ownTrigger(trigger);
    if (own !== undefined) turn.trigger = own;
    turns.set(key, turn);
    if (turns.size > MAX_OPEN_TURNS) {
      const [oldestKey, oldest] = turns.entries().next().value as [string, Turn];
      turns.delete(oldestKey);
      endTurn(oldest, oldest.startTime, "error", { message: "The tracer lost track of this turn." });
    }
    remember(event.sessionId, traceId);
    deps.turnTraceIds?.set(event.sessionId, turnId, traceId);
    // A memory this turn saves says which harness, trace and message it came from.
    deps.memoryLinks?.turn(event.sessionId, { subject: `harness:${options.harness}`, traceId });
    if (fixedTrace !== undefined && shared === undefined) {
      shared = { startTime: event.timestamp, failed: false };
    }
    send([traceRow(turn, turn.trigger)], []);
    return turn;
  }

  function turnOf(event: HarnessEventLike): Turn {
    return beginTurn(event, event.turnId ?? "turn");
  }

  function sharedRootSpan(turn: Turn, endTime: string | undefined, output: string | UnavailableContent | undefined): SpanInput {
    const root = shared!;
    return {
      traceId: turn.traceId,
      id: "root",
      name,
      type: "agent",
      status: root.failed ? "error" : endTime === undefined ? "running" : "ok",
      startTime: root.startTime,
      ...(endTime === undefined ? {} : { endTime }),
      ...(root.input === undefined ? {} : { input: root.input }),
      ...(output === undefined ? {} : { output }),
      attributes: { sessionId: turn.sessionId, ...contentStatus(root.input, output, root.inputPreview, turn.outputPreview) },
    };
  }

  function endTurn(turn: Turn, endTime: string, status: "ok" | "error", error?: { message: string; type?: string }) {
    const spans: SpanInput[] = [];
    for (const open of turn.open.values()) {
      spans.push(closedSpan(turn, open, endTime, "error", undefined, { message: "Unfinished when the turn ended." }));
    }
    turn.open.clear();
    spans.push({
      traceId: turn.traceId,
      id: turn.spanId,
      ...(turn.parentId === null ? {} : { parentId: turn.parentId }),
      name: fixedTrace === undefined ? name : "turn",
      type: "agent",
      status,
      startTime: turn.startTime,
      endTime,
      ...(turn.input === undefined ? {} : { input: turn.input }),
      ...(turn.output === undefined ? {} : { output: turn.output }),
      attributes: { sessionId: turn.sessionId, turnId: turn.turnId, ...contentStatus(turn.input, turn.output, turn.inputPreview, turn.outputPreview) },
      ...(error === undefined ? {} : { error }),
    });
    if (fixedTrace !== undefined && shared !== undefined) {
      if (status === "error") shared.failed = true;
      spans.push(sharedRootSpan(turn, endTime, turn.output));
    }
    const input = fixedTrace === undefined ? turn.input : shared?.input;
    if ((isRecord(input) && input.unavailable === true) || (isRecord(turn.output) && turn.output.unavailable === true) || shared?.unavailableWritten) {
      // Engines retain the first root-derived trace body. An explicit trace update is needed
      // to replace that cached body, and a later known shared output must replace the sentinel.
      if (shared !== undefined) shared.unavailableWritten = true;
      send([{ ...traceRow(turn), ...(input === undefined ? {} : { input }), ...(turn.output === undefined ? {} : { output: turn.output }) }], spans);
    } else send([], spans);
  }

  function closedSpan(
    turn: Turn,
    open: OpenSpan,
    endTime: string,
    status: "ok" | "error",
    extra: Partial<SpanInput> | undefined,
    error?: { message: string; type?: string },
  ): SpanInput {
    return {
      traceId: turn.traceId,
      id: open.id,
      parentId: turn.spanId,
      name: open.name,
      type: open.type,
      status,
      startTime: open.startTime,
      endTime,
      ...(open.model === undefined ? {} : { model: open.model }),
      ...(open.provider === undefined ? {} : { provider: open.provider }),
      ...(open.input === undefined ? {} : { input: open.input }),
      attributes: open.attributes,
      ...extra,
      ...(error === undefined ? {} : { error }),
    };
  }

  function handle(event: HarnessEventLike): void {
    const metadata = isRecord(event.metadata) ? event.metadata : {};
    switch (event.type) {
      case "harness.session.started": {
        beginTurn(event, event.turnId ?? "turn", sessionTrigger(metadata));
        return;
      }
      case "harness.model.called": {
        const turn = turnOf(event);
        const request = isRecord(metadata.request) ? metadata.request : {};
        const messages = Array.isArray(request.messages) ? request.messages : [];
        const model = isRecord(metadata.model) ? metadata.model : {};
        const key = event.occurrenceId ?? event.stepId ?? `step_${String(metadata.stepNumber ?? turn.open.size)}`;
        const truncated = contentTruncated(request.system) || messages.some((m) => isRecord(m) && contentTruncated(m.content));
        const missingRequest = unavailableContent(request.system) ?? messages.map((m) => isRecord(m) ? unavailableContent(m.content) : undefined).find((m) => m !== undefined);
        if (turn.input === undefined && capture) {
          const lastUser = [...messages].reverse().find((m) => isRecord(m) && m.role === "user");
          if (isRecord(lastUser)) {
            turn.input = unavailableContent(lastUser.content) ?? messageContent(lastUser.content);
            turn.inputPreview = unavailablePreview(lastUser.content);
          }
          const said = isRecord(lastUser) ? userText(lastUser.content) : undefined;
          if (said !== undefined && said.length > 0) deps.memoryLinks?.turn(event.sessionId, { said });
          if (fixedTrace !== undefined && shared !== undefined && shared.input === undefined) {
            shared.input = turn.input;
            shared.inputPreview = turn.inputPreview;
            send([], [sharedRootSpan(turn, undefined, undefined)]);
          }
        }
        const modelId = stringValue(model.modelId);
        const provider = providerName(model.provider);
        turn.open.set(key, {
          id: boundedId("llm", turn.turnId, key),
          name: clipText(modelId ?? "model", 500),
          type: "llm",
          startTime: event.timestamp,
          ...(modelId === undefined ? {} : { model: modelId }),
          ...(provider === undefined ? {} : { provider }),
          ...(capture
            ? {
                input: {
                  ...(request.system === undefined ? {} : { system: contentText(request.system) }),
                  messages: messages.map((m) => (isRecord(m) ? { role: m.role, content: messageContent(m.content) } : m)),
                },
              }
            : {}),
          attributes: {
            ...(typeof metadata.stepNumber === "number" ? { step: metadata.stepNumber } : {}),
            ...(truncated ? { truncated: true } : {}),
            ...(capture && missingRequest !== undefined ? { contentUnavailable: { input: missingRequest }, truncated: true } : {}),
          },
        });
        return;
      }
      case "harness.model.responded":
      case "harness.model.failed": {
        const turn = turnOf(event);
        const key = event.occurrenceId ?? event.stepId ?? `step_${String(metadata.stepNumber ?? 0)}`;
        const model = isRecord(metadata.model) ? metadata.model : {};
        const modelId = stringValue(model.modelId);
        const provider = providerName(model.provider);
        const open: OpenSpan = turn.open.get(key) ?? {
          id: boundedId("llm", turn.turnId, key),
          name: clipText(modelId ?? "model", 500),
          type: "llm",
          startTime: event.timestamp,
          attributes: {},
          ...(modelId === undefined ? {} : { model: modelId }),
          ...(provider === undefined ? {} : { provider }),
        };
        turn.open.delete(key);
        if (event.type === "harness.model.failed") {
          send([], [closedSpan(turn, open, event.timestamp, "error", undefined, errorInfo(metadata.error))]);
          return;
        }
        const text = contentText(metadata.text);
        const unavailable = unavailableContent(metadata.text);
        // A turn includes every narrated segment, separated exactly as the owner contract specifies.
        // Once any part is unavailable, later known text cannot make that whole turn complete.
        if (capture && unavailable !== undefined) {
          turn.output = unavailable;
          turn.outputPreview = unavailablePreview(metadata.text);
        } else if (capture && text !== undefined && text.trim().length > 0 && typeof turn.output !== "object") {
          turn.output = turn.output === undefined ? text : `${turn.output}\n\n${text}`;
          turn.outputPreview = undefined;
        }
        const toolCalls = Array.isArray(metadata.toolCalls)
          ? metadata.toolCalls.map((call) =>
              isRecord(call) ? { toolName: call.toolName, ...(capture ? { input: contentValue(call.input) } : {}) } : call,
            )
          : [];
        const usage = toLittleDBUsage(metadata.usage);
        send([], [
          closedSpan(turn, open, event.timestamp, "ok", {
            ...(modelId === undefined ? {} : { model: modelId }),
            ...(provider === undefined ? {} : { provider }),
            ...(capture ? { output: unavailable ?? { text: text ?? "", ...(toolCalls.length === 0 ? {} : { toolCalls }) } } : {}),
            ...(usage === undefined ? {} : { usage }),
            attributes: {
              ...open.attributes,
              ...(typeof metadata.finishReason === "string" ? { finishReason: metadata.finishReason } : {}),
              ...(contentTruncated(metadata.text) ? { truncated: true } : {}),
              ...(capture && unavailable !== undefined ? { contentUnavailable: unavailable } : {}),
              ...(capture && unavailablePreview(metadata.text) !== undefined ? { contentPreview: { output: unavailablePreview(metadata.text) } } : {}),
            },
          }),
        ]);
        return;
      }
      case "harness.tool_call.started": {
        const turn = turnOf(event);
        const callId = stringValue(metadata.toolCallId) ?? event.occurrenceId ?? `tool_${turn.open.size}`;
        const toolName = stringValue(metadata.toolName) ?? "tool";
        const open: OpenSpan = {
          id: boundedId("tool", turn.turnId, callId),
          name: clipText(toolName, 500),
          type: "tool",
          startTime: event.timestamp,
          ...(capture && metadata.input !== undefined ? { input: unavailableContent(metadata.input) ?? contentValue(metadata.input) } : {}),
          attributes: {
            toolCallId: callId,
            ...(typeof metadata.caller === "string" ? { caller: metadata.caller } : {}),
            ...(contentTruncated(metadata.input) ? { truncated: true } : {}),
          },
        };
        // Paths only, never content: the memory a step touched is traced even without captureContent.
        const memory = startMemoryAccess(event.sessionId, toolName, contentValue(metadata.input));
        if (memory !== undefined) open.memory = memory;
        turn.open.set(`tool:${callId}`, open);
        return;
      }
      case "harness.file.created":
      case "harness.file.updated":
      case "harness.file.deleted": {
        // A memory file changed while a step ran (the harness diffs the folders around each
        // command): that step wrote it.
        const path = stringValue(metadata.path);
        if (path === undefined || memoryAt(event.sessionId, path) === undefined) return;
        const turn = turns.get(`${event.sessionId}\u0000${event.turnId ?? "turn"}`);
        const running = turn === undefined ? undefined : [...turn.open.entries()].reverse().find(([k]) => k.startsWith("tool:"))?.[1];
        if (running === undefined) return;
        running.memory ??= { how: MEMORY_FILE_TOOLS[running.name] === undefined ? "command" : "tool", files: [], listed: [], search: false };
        touchMemory(running.memory, event.sessionId, path, event.type === "harness.file.deleted" ? "delete" : "write");
        return;
      }
      case "harness.tool_call.succeeded":
      case "harness.tool_call.failed": {
        const turn = turnOf(event);
        const callId = stringValue(metadata.toolCallId) ?? event.occurrenceId ?? "tool";
        const toolName = stringValue(metadata.toolName) ?? "tool";
        const open: OpenSpan = turn.open.get(`tool:${callId}`) ?? {
          id: boundedId("tool", turn.turnId, callId),
          name: clipText(toolName, 500),
          type: "tool",
          startTime: event.timestamp,
          ...(capture && metadata.input !== undefined ? { input: unavailableContent(metadata.input) ?? contentValue(metadata.input) } : {}),
          attributes: { toolCallId: callId },
        };
        turn.open.delete(`tool:${callId}`);
        const failed = event.type === "harness.tool_call.failed";
        const memoryAccess = finishMemoryAccess(event.sessionId, open, failed, metadata.output);
        send([], [
          closedSpan(
            turn,
            open,
            event.timestamp,
            failed ? "error" : "ok",
            {
              ...(capture && !failed && metadata.output !== undefined ? { output: unavailableContent(metadata.output) ?? contentValue(metadata.output) } : {}),
              attributes: {
                ...open.attributes,
                ...(typeof metadata.durationMs === "number" ? { durationMs: metadata.durationMs } : {}),
                ...(contentTruncated(metadata.output) ? { truncated: true } : {}),
                ...(memoryAccess === undefined ? {} : { memoryAccess }),
              },
            },
            failed ? errorInfo(metadata.error) : undefined,
          ),
        ]);
        return;
      }
      case "harness.persistent_dir.loaded": {
        // A managed memory (db.memory.*): which space, and exactly which revisions, this turn carried.
        const harnessDir = stringValue(metadata.harnessDir);
        const link = harnessDir === undefined ? undefined : deps.memoryLinks?.loadOf(event.sessionId, harnessDir);
        if (link === undefined || harnessDir === undefined) return;
        const turn = turnOf(event);
        send([], [
          {
            traceId: turn.traceId,
            id: boundedId("memory", turn.turnId, harnessDir),
            parentId: turn.spanId,
            name: clipText(`memory ${link.space}`, 500),
            type: "retrieval",
            status: "ok",
            startTime: event.timestamp,
            endTime: event.timestamp,
            attributes: {
              memory: {
                layer: link.layer,
                space: link.space,
                harnessDir,
                files: link.files,
                writable: link.writable,
                ...(link.spaceId === undefined ? {} : { spaceId: link.spaceId }),
                ...(link.snapshot === undefined ? {} : { snapshot: link.snapshot }),
                ...(link.review === undefined ? {} : { review: link.review }),
                ...(link.fallback === undefined ? {} : { fallback: link.fallback }),
              },
            },
          },
        ]);
        return;
      }
      case "harness.persistent_dir.commit.succeeded":
      case "harness.persistent_dir.commit.failed": {
        // What a managed memory's store did with this turn's changes: saved, or waiting for a person.
        const harnessDir = stringValue(metadata.harnessDir);
        const loaded = harnessDir === undefined ? undefined : deps.memoryLinks?.loadOf(event.sessionId, harnessDir);
        if (loaded === undefined || harnessDir === undefined) return;
        const failed = event.type === "harness.persistent_dir.commit.failed";
        const link = failed ? undefined : deps.memoryLinks?.storeOf(event.sessionId, harnessDir);
        const changes = isRecord(metadata.changes) ? metadata.changes : {};
        const pathsOf = (key: string) => (Array.isArray(changes[key]) ? changes[key] : []).map((f) => (isRecord(f) ? stringValue(f.path) : undefined)).filter((p): p is string => p !== undefined);
        // A turn that changed nothing in this memory saved nothing: no event.
        if (!failed && pathsOf("created").length + pathsOf("updated").length + pathsOf("deleted").length === 0) return;
        const turn = turnOf(event);
        send([], [
          {
            traceId: turn.traceId,
            id: boundedId("memory-save", turn.turnId, harnessDir),
            parentId: turn.spanId,
            name: clipText(`memory ${loaded.space} saved`, 500),
            type: "event",
            status: failed ? "error" : "ok",
            startTime: event.timestamp,
            endTime: event.timestamp,
            attributes: {
              memory: {
                layer: loaded.layer,
                space: loaded.space,
                harnessDir,
                status: failed ? "failed" : (link?.status ?? "saved"),
                ...(link?.change === undefined ? {} : { change: link.change }),
                created: pathsOf("created"),
                updated: pathsOf("updated"),
                deleted: pathsOf("deleted"),
              },
            },
            ...(failed ? { error: errorInfo(metadata.error) } : {}),
          },
        ]);
        return;
      }
      case "harness.runtime.usage": {
        // The tier the turn reached and what its sandbox used: on the trace row, so the engine
        // indexes it per turn. The harness emits it before the turn's terminal event; should an
        // older harness send it after, the row is still updated, without reopening the turn.
        const compute = toLittleDBCompute(metadata);
        if (compute === undefined) return;
        const turnId = event.turnId ?? "turn";
        const turn = turns.get(`${event.sessionId}\u0000${turnId}`);
        if (turn === undefined) {
          send([{ id: traceIdForTurn(event.sessionId, turnId), startTime: event.timestamp, compute }], []);
          return;
        }
        turn.compute = compute;
        send([traceRow(turn, turn.trigger)], []);
        return;
      }
      case "harness.session.completed":
      case "harness.session.failed": {
        const turnId = event.turnId ?? "turn";
        const key = `${event.sessionId}\u0000${turnId}`;
        const turn = turns.get(key) ?? beginTurn(event, turnId);
        turns.delete(key);
        if (event.type === "harness.session.failed") {
          endTurn(turn, event.timestamp, "error", errorInfo(metadata.error ?? "The turn failed."));
        } else {
          endTurn(turn, event.timestamp, "ok");
        }
        return;
      }
      default:
        return;
    }
  }

  return {
    onEvent: async (event) => {
      try {
        handle(event);
      } catch (error) {
        deps.onError(error, { operation: "trace" });
      }
    },
    traceIdFor(sessionId) {
      return sessions.get(sessionId)?.at(-1);
    },
    traceIdsFor(sessionId) {
      return [...(sessions.get(sessionId) ?? [])];
    },
    traceIdForTurn,
    flush() {
      return deps.exporter.flush();
    },
  };
}
