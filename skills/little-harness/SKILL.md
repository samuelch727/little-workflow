---
name: little-harness
description: "Use when working with the little-harness package, createHarness, streamHarness, generateHarness, localHost, inputType, skills, memory, persistent dirs, files, artifacts, trace events, durability replay, or the little-harness workflow-harness adapter."
---

# Little Harness

## Overview

Use this skill to build, debug, or explain Little Harness runtimes. Little Harness is the generic agent session runtime; Little Workflow consumes its workflow-harness adapter.

## Required Checks

1. Search the docs website content and package docs first: see [package-docs.md](references/package-docs.md).
2. Verify active APIs against source when editing code: see [source-map.md](references/source-map.md).
3. Use `pnpm` for package scripts in this repo.
4. Run the narrowest relevant check after edits, usually `pnpm --filter little-harness test`, `pnpm --filter little-harness typecheck`, or a targeted Vitest file.

## Quick Reference

| Need | Use |
| --- | --- |
| Create a local runtime | `createHarness({ host: localHost({ dataDir }), model, ... })` |
| Chat/UI streaming | `streamHarness({ harness, messages, session })` |
| One-shot jobs | `generateHarness({ harness, type, input, session })` |
| Typed job modes | `inputType({ description, inputSchema?, output?, toMessages? })` |
| Stage skills | `skills: [skill("./skills/name"), skill("https://github.com/org/repo", { skills: ["name"] })]` or inline skill objects |
| Durable memory | `memory({ sourceDir, commit?, tool? })` |
| Persistent files | `persistentDirs: [localDir({ harnessDir, sourceDir, commit })]` |
| Workflow adapter | `little-harness/workflow-harness` |
| Trace/debug | inspect `.little-harness/sessions/**/trace.ndjson` |

## Generic Harness Pattern

```ts
import { openai } from "@ai-sdk/openai";
import {
  createHarness,
  inputType,
  localHost,
  streamHarness,
} from "little-harness";
import { z } from "zod";

const harness = createHarness({
  host: localHost({ dataDir: ".little-harness" }),
  model: openai("gpt-5"),
  system: "Help users complete customer support work.",
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

export async function POST(req: Request) {
  const { messages, chatId } = await req.json();
  const result = streamHarness({ harness, messages, session: chatId });
  return result.toUIMessageStreamResponse();
}
```

## Workflow Harness Pattern

Use `little-harness/workflow-harness` only for Little Workflow-compatible harness work:

```ts
import { createWorkflowHarness } from "little-harness/workflow-harness";

export const customHarness = createWorkflowHarness({
  aiLoop: {
    async generate({ model, system, messages, tools, signal }) {
      return {
        output: "done",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  },
});
```

Return `{ kind: "delegate_to_default" }` when custom behavior should fall back to the default workflow harness.

## Implementation Notes

- `createHarness` requires `host` and `model`.
- `localHost()` defaults to `.little-harness` and stores sessions, artifacts, persistent checkouts, staged skills, turns, and traces.
- Developers can keep authored local skills in `./skills/<name>/`; the runtime materializes resolved skills read-only under `.agents/skills/<name>/` from the harness working directory.
- Remote skills must use explicit Git URLs, not shorthands like `org/repo` or `github:org/repo`. Omit `skills` to install all non-internal skills from the source; include a commit SHA/ref when version pinning matters because the cache is keyed by resolved commit SHA.
- Private remote skills can use per-source bearer auth or the host-level `LITTLE_SKILLS_GIT_TOKEN` plus `LITTLE_SKILLS_GIT_TOKEN_HOSTS` fallback.
- Risk gates are optional. Put `skillOidcToken` on `createHarness` or resolver defaults, and use `skillMaxRisk` globally or per source plus `skillRisk` for selected remote skill names.
- Remote Git skill failures are soft at runtime: unavailable repositories, missing selected skills, and failed remote audits skip that remote source and surface warnings. Local path/frontmatter errors remain strict.
- User tool names cannot be `bash`; the runtime injects `bash`.
- Tool handlers receive Little Harness context through AI SDK execute options: `session`, `files`, `artifacts`, `extraBody`, `abortSignal`, and replay/spooling helpers.
- When bash and JavaScript are enabled, configured tools are also exposed inside `js-exec` through the Runtime Tool Bridge as `tools.<name>(args)`. Use this for batched or programmatically assembled tool calls; events use `caller: "runtime"`.
- Disable runtime bridge exposure with `runtime: { toolBridge: false }`, or by disabling `javascript`/`bash`. It is not advertised when per-call `activeTools` or `prepareStep` hides `bash`.
- `streamHarness` returns a UI message stream that can be consumed once; await `finished` for trace, artifacts, persistence, and warnings.
- Directory skills must have `SKILL.md` frontmatter with `name` and `description`.

## Common Mistakes

- Do not omit `host: localHost(...)` in local code.
- Do not use Little Harness directly for ordinary Little Workflow authoring; use `little-workflow`.
- Do not update package docs without checking whether `apps/little-harness-doc/content/docs/v0.1.0-alpha/` needs the same change.
- Do not tell the model to read author-source `./skills/...` paths inside the harness. Prompt-visible bodies are under `.agents/skills/<name>/SKILL.md`.
- Do not use GitHub/GitLab shorthand skill sources. `skill(...)` accepts local paths, local markdown files, inline files, or explicit Git URLs.
- Do not register user tools named `bash`, `constructor`, `prototype`, or `__proto__`.
- Do not assume an undefined `type` fails. It runs and returns an `undefined_input_type` warning.
- Do not rely on trace files for secrets unless redaction settings cover the sensitive paths/metadata.
