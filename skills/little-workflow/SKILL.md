---
name: little-workflow
description: "Use when working with the little-workflow package, Little Workflow SDK, createLittleWorkflow, runWorkflow, localWorld, LWIR, workflow authoring, tool registries, orchestrators, skills, memory, replay, workflow durability, or the little CLI."
---

# Little Workflow

## Overview

Use this skill to build, debug, or explain Little Workflow apps. Treat local docs and source as authoritative; the package is still moving and model memory is likely stale.

## Required Checks

1. Search package docs first: see [package-docs.md](references/package-docs.md).
2. Verify active APIs against source when editing code: see [source-map.md](references/source-map.md).
3. Use `pnpm` for package scripts in this repo.
4. Run the narrowest relevant check after edits, usually `pnpm --filter little-workflow test`, `pnpm --filter little-workflow typecheck`, or a targeted Vitest file.

## Quick Reference

| Need | Use |
| --- | --- |
| Define a workflow | `createLittleWorkflow({ id, inputSchema, output/outputSchema, models, planner, ... })` |
| Register execution model options | `model(aiSdkModel, { id?, description? })` |
| Attach planner/worker skills | Local `skill("./skills/name")` or remote `skill("https://github.com/org/repo", { skills: ["name"] })` in role skills |
| Run locally | `runWorkflow({ world: localWorld({ dataDir }), workflows, input, tools? })` |
| Register tools | `createToolRegistry({ name: aiSdkTool })`; reference names from `globalTools` |
| Multi-workflow orchestration | Pass a workflow array and an `orchestrator` config to `runWorkflow` |
| Inspect stored runs | `little events <runId>`, `little replay <runId>` |
| Validate compiled JSON | Read `docs/reference/lwir-reference.mdx` and `src/lwir.ts` |

## Authoring Pattern

```ts
import { tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import {
  createLittleWorkflow,
  createToolRegistry,
  localWorld,
  model,
  runWorkflow,
} from "little-workflow";

const tools = createToolRegistry({
  lookupCustomer: tool({
    description: "Look up customer metadata.",
    inputSchema: z.object({ accountId: z.string() }),
    execute: async ({ accountId }) => ({ accountId, plan: "enterprise" }),
  }),
});

const summarizeTicket = createLittleWorkflow({
  id: "support.summarize-ticket",
  description: "Summarize a support ticket and classify severity.",
  inputSchema: z.object({ ticketId: z.string(), transcript: z.string() }),
  output: {
    kind: "object",
    schema: z.object({
      summary: z.string(),
      severity: z.enum(["low", "medium", "high"]),
    }),
  },
  models: [model(openai("gpt-4o-mini"))],
  planner: {
    model: openai("gpt-5"),
    system: "Design a concise support-ticket workflow.",
  },
  globalTools: ["lookupCustomer"],
});

const result = await runWorkflow({
  world: localWorld({ dataDir: ".little-workflow" }),
  workflows: summarizeTicket,
  tools,
  input: {
    ticketId: "TCK-123",
    transcript: "Customer reports intermittent billing export failures...",
  },
  timeout: "10m",
});
```

## Implementation Notes

- `planner.model` is the model that designs LWIR. `models` lists execution model slots the planner may choose for steps.
- `worker` is optional; Little Workflow defaults to the SDK `workflowHarness`.
- `output` is the newer output mode surface; `outputSchema` is still accepted by the current authoring types.
- `globalTools` names must exist in the `ToolRegistry` passed to compile/run time.
- The Bash tool is SDK-injected for harness sessions. Do not put it in the Tool Registry.
- Developers can keep authored local skills in `./skills/<name>/`; planner, worker, orchestrator, and fixer sessions read materialized bodies from `.agents/skills/<name>/SKILL.md`.
- Remote skills must use explicit Git URLs. Omit `skills` to install all non-internal skills from the source; selected names match `npx skills add URL --skill name`.
- Remote skill cache entries are keyed by resolved commit SHA. Pin with a SHA/ref in the URL/source options when reproducibility matters.
- Private remote skills can pass per-source bearer auth or use the host-level `LITTLE_SKILLS_GIT_TOKEN` plus `LITTLE_SKILLS_GIT_TOKEN_HOSTS` fallback.
- Remote Git skill failures are soft at role startup and surface warnings; local skill path/frontmatter errors remain strict.
- `skillMaxRisk` can be set globally, per role, or per source. `skillRisk` overrides selected remote skill names, and `skillOidcToken` belongs on workflow/run role config defaults rather than per-skill options.
- Completed steps are durable and should not re-execute on resume.

## Common Mistakes

- Do not use `createRuntime()` for alpha work; it intentionally throws.
- Do not rely on old docs without checking `packages/little-workflow/src/index.ts`.
- Do not import Little Harness directly unless you are customizing harness behavior; normal workflow apps should use `little-workflow`.
- Do not change tool descriptors casually; descriptor hashes are part of workflow identity and resume safety.
- Do not assume orchestration mode from one workflow. Passing an array of workflows requires an `orchestrator` config.
- Do not tell agents to read source `./skills/...` during runtime; inside the role working directory, prompt-visible skill bodies are under `.agents/skills/...`.
- Do not use `org/repo`, `github:org/repo`, or `gitlab:org/repo` shorthand skill sources.
