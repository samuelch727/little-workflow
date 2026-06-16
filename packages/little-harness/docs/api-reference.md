# little-harness API Reference

Little Harness is the agent runtime package underneath Little Workflow. Use it directly when you need a generic agent session runtime with tools, skills, local files, artifacts, trace events, persistent directories, and AI SDK-compatible streaming.

## Entry Points

```ts
import {
  createHarness,
  generateHarness,
  inputType,
  localHost,
  memory,
  skill,
  streamHarness,
} from "little-harness";
```

Use `little-harness/workflow-harness` only when implementing or customizing the Little Workflow-compatible harness contract.

## Minimal Harness

```ts
import { openai } from "@ai-sdk/openai";
import { createHarness, localHost, streamHarness } from "little-harness";

const harness = createHarness({
  host: localHost({ dataDir: ".little-harness" }),
  model: openai("gpt-5"),
  system: "Help the user complete document-heavy work.",
  tools: {
    // AI SDK tools go here.
  },
});

export async function POST(req: Request) {
  const { messages, chatId } = await req.json();

  const result = streamHarness({
    harness,
    messages,
    session: chatId,
  });

  return result.toUIMessageStreamResponse();
}
```

`createHarness` requires a `host` and `model`. For local development, use `localHost({ dataDir })`; it stores sessions under `.little-harness/` by default.

## `createHarness(...)`

```ts
const harness = createHarness({
  host,
  model,
  system,
  tools,
  skills,
  inputTypes,
  persistentDirs,
  memory,
  chat,
  runtime,
  toolResultSpooling,
  trace,
  durability,
  onEvent,
  onTraceError,
  onPersistenceError,
});
```

Important fields:

| Field | Purpose |
| --- | --- |
| `host` | Session and runtime host. Use `localHost()` for filesystem-backed local sessions. |
| `model` | AI SDK language model used by `generateHarness` and `streamHarness`. |
| `system` | Optional system prompt as a string or model messages. |
| `tools` | AI SDK `ToolSet`; user tool names must match `[A-Za-z_][A-Za-z0-9_-]{0,63}` and cannot be `bash`. |
| `skills` | Skill directories, inline skill files, or `skill(...)` values staged under `.agents/skills/<name>/`. |
| `inputTypes` | Named input adapters created with `inputType(...)`. |
| `persistentDirs` | Developer-backed directories mounted under `/persistent/...`. |
| `memory` | Convenience wrapper that creates a persistent memory dir and optional `remember` tool. |
| `runtime` | Enables or restricts Bash runtime capabilities such as Python, JavaScript, network, and Runtime Tool Bridge exposure. |
| `trace` | Trace capture/redaction options or `false` to disable persisted traces. |
| `durability` | Durable event sink used for replaying model and tool calls. |

## Harness Events

`onEvent` callbacks receive a `HarnessEvent`. A harness event is the trace/callback envelope for something that happened during a session turn: session start/completion, model calls, tool calls, runtime commands, file writes, artifact creation, persistent dir commits, and related failures.

```ts
type HarnessEvent<TEventType extends string = HarnessEventType> = {
  schemaVersion?: "lh.trace.v2";
  eventId?: string;
  sequence?: number;
  occurrenceId?: string;
  type: TEventType;
  sessionId: string;
  turnId?: string;
  stepId?: string;
  parentEventId?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
};
```

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Trace schema version. Local traces currently use `lh.trace.v2`. |
| `eventId` | Unique id for this emitted trace/callback event. |
| `sequence` | Monotonic sequence number within the local trace file. |
| `occurrenceId` | Correlation id for one logical occurrence, such as a specific model call or tool call. Durable replay events use the same occurrence id. |
| `type` | Dotted event name, for example `harness.model.called` or `harness.tool_call.succeeded`. |
| `sessionId` | Harness session id. Pass a stable `session` to group multiple turns. |
| `turnId` | Turn id for the current `generateHarness` or `streamHarness` call. |
| `stepId` | Optional model step id for multi-step model/tool loops. |
| `parentEventId` | Optional parent event id for nested event relationships. |
| `timestamp` | ISO timestamp for when the event was emitted. |
| `metadata` | Event-specific details, redacted according to trace options. |

`HarnessEvent` does not carry the durable replay payload directly. Durable replay uses `DurableHarnessEventInput`, which has `{ type, runId, occurrenceId?, payload }`. Trace/callback events expose event details through `metadata`; durable events store replay-matching data in `payload`.

## `generateHarness(...)`

Use `generateHarness` for one-shot work, jobs, tests, server actions, and Little Workflow nodes.

```ts
import { z } from "zod";
import { inputType, generateHarness } from "little-harness";

const harness = createHarness({
  host: localHost(),
  model,
  inputTypes: {
    "support.ticket_triage": inputType({
      description: "Triage one support ticket.",
      inputSchema: z.object({ id: z.string(), body: z.string() }),
      toMessages: ({ input }) => [
        { role: "user", content: `Triage ticket ${input.id}:\n\n${input.body}` },
      ],
    }),
  },
});

const result = await generateHarness({
  harness,
  type: "support.ticket_triage",
  input: { id: "TCK-1", body: "Customer cannot export invoices." },
  session: "ticket:TCK-1",
});

console.log(result.text);
console.log(result.output);
console.log(result.trace.path);
```

If `type` is not defined in `inputTypes`, the run still proceeds and returns an `undefined_input_type` warning.

## `streamHarness(...)`

Use `streamHarness` for chat routes and UI message streaming.

```ts
const result = streamHarness({
  harness,
  messages,
  session: chatId,
});

return result.toUIMessageStreamResponse();
```

The returned UI message stream can be consumed once. Await `result.finished` for session, artifacts, trace, persistence, and warnings after streaming completes.

## Input Types

`inputType(...)` defines reusable typed work modes. A type can validate input, provide default structured output, add instructions, and convert host input into model messages.

```ts
inputType({
  description: "Summarize one uploaded contract.",
  inputSchema,
  output,
  instructions: "Prefer exact clause references.",
  toMessages: async ({ input, files, session, extraBody }) => [
    { role: "user", content: `Summarize ${input.contractName}.` },
  ],
});
```

## Skills

Skills can be passed as directory paths or inline file sets.

```ts
createHarness({
  host: localHost(),
  model,
  skills: [
    skill("./skills/customer-research"),
    skill("https://github.com/anthropics/skills", {
      skills: ["frontend-design"],
    }),
    {
      name: "inline-policy",
      description: "Use when applying the current policy.",
      files: {
        "SKILL.md": "---\nname: inline-policy\ndescription: Use when applying the current policy.\n---\n\nFollow policy.",
      },
    },
  ],
});
```

Directory skills must contain `SKILL.md` with `name` and `description` frontmatter. Resolved skills are staged read-only under `.agents/skills/<name>/` before input types run.

Remote skills must use explicit Git URLs, including GitHub URLs, GitLab tree URLs, generic HTTPS Git URLs, SSH URLs, and scp-style Git URLs. Shorthands such as `org/repo`, `github:org/repo`, and `gitlab:org/repo` are rejected. The `skills` option selects skill names like `npx skills add URL --skill frontend-design`; when omitted, every non-internal skill in the source is installed. The cache is keyed by resolved commit SHA, so include a commit SHA or ref when you need a specific version.

Private Git sources can pass `auth: { type: "bearer", token: process.env.GIT_TOKEN }`. As a host-level fallback, set `LITTLE_SKILLS_GIT_TOKEN` and restrict where it is sent with `LITTLE_SKILLS_GIT_TOKEN_HOSTS`. Risk gates are optional; when configured, pass `skillOidcToken: process.env.VERCEL_OIDC_TOKEN`. `skillMaxRisk` can be configured globally, at harness or role level, or per `skill(...)`, and `skillRisk` can set policy for selected remote skill names inside a `skill(...)` call.

## Tools, Files, and Artifacts

The runtime exposes user tools plus an injected `bash` tool. Tool `execute` handlers receive Little Harness context through the AI SDK tool execution options:

```ts
execute: async (input, ctx: any) => {
  await ctx.files.writeText("/session/result.txt", "hello");
  const ref = await ctx.files.writeJSON("/artifacts/query/result.json", input, {
    artifact: true,
  });
  const readBack = await ctx.artifacts.read(ref.path);
  return { artifactPath: ref.path, bytes: readBack.content.byteLength };
}
```

### Runtime Tool Bridge

When the built-in just-bash runtime has JavaScript enabled, Little Harness also exposes configured tools inside `js-exec` as `tools.<name>(args)`. This Runtime Tool Bridge is enabled by default for non-`bash` tools when `bash` is visible to the model:

```bash
js-exec -c 'const rows = await tools.queryCustomers({ plan: "enterprise" }); console.log(rows.path ?? JSON.stringify(rows))'
```

Use this path when the model needs to batch many similar tool calls, build complex inputs programmatically, or combine tool output with scripts before returning a compact answer. The model can still call tools directly through the provider. The bridge adds a lower-token path through the same configured tool registry.

Bridge calls share the same tool execution context, oversized result spooling, trace capture, abort signal, and durability replay as ordinary tool calls. Trace and durable payloads use `caller: "runtime"` and scope replay by the parent `bash` tool call id, so repeated identical `tools.x(args)` calls inside different bash commands do not collide.

Disable the bridge with:

```ts
createHarness({
  host,
  model,
  tools,
  runtime: { toolBridge: false },
});
```

The bridge is also unavailable when `runtime.javascript === false`, when `runtime.bash === false`, or when a per-call `activeTools` / `prepareStep` setting hides `bash` from the provider.

Oversized tool results are automatically spooled to `/artifacts/tool-results`
unless disabled with `toolResultSpooling: false`. The compact response includes
the artifact path, byte count, media type, preview, line/character counts, and a
bounded JSON structure sketch when the stored content can be parsed as JSON.

Stable virtual paths:

- `/session/` private workspace for the current session.
- `/artifacts/` generated files and large tool outputs.
- `.agents/skills/` staged read-only skill directories. From the default shell cwd, use the relative `.agents/skills/...` path advertised in prompts.
- `/persistent/` opt-in persistent directories.

## Persistent Dirs and Memory

Use `persistentDirs` when your app owns persistence explicitly.

```ts
import { localDir, projectDir } from "little-harness";

createHarness({
  host: localHost({ dataDir: ".little-harness", projectRoot: process.cwd() }),
  model,
  persistentDirs: [
    localDir({
      harnessDir: "/persistent/project-notes",
      sourceDir: projectDir("notes"),
      commit: "manual",
    }),
  ],
});
```

Use `memory(...)` for the default memory pattern. It mounts `/persistent/memory`, maintains `MEMORY.md`, and adds a `remember` tool unless disabled.

```ts
createHarness({
  host: localHost(),
  model,
  memory: memory({
    sourceDir: "memory/customer-agent",
    commit: "after-turn",
  }),
});
```

Commit modes are `after-turn`, `manual`, and `read-only`.

## Common Mistakes

- Always provide `host: localHost(...)` when using `createHarness` locally.
- Do not register a user tool named `bash`; the runtime injects it.
- Do not consume `streamHarness().toUIMessageStream()` or `.toUIMessageStreamResponse()` more than once.
- Pass a stable `session` when a chat or job needs file continuity.
- Prefer `inputType(...)` for structured jobs; raw `type` strings without definitions run but warn.
- Keep skill directories small enough to stage into the session workspace.
