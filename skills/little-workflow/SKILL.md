---
name: little-workflow
description: "Use when working with the little-workflow package, Little Workflow SDK, defineWorkflow, createLittleWorkflow, runWorkflow, asHarnessWorkflow, loadWorkflow, localWorld, LWIR, workflow authoring, composing workflows into a Little Harness agent, tool registries, the deprecated orchestrator, skills, memory, replay, run costs, workflow durability, or the little CLI."
---

# Little Workflow

## Overview

Use this skill to build, debug, or explain Little Workflow apps. Treat local docs and source as authoritative; the package is still moving and model memory is likely stale.

Current release: `0.2.0-alpha.0`. It requires Node.js 22+ and **AI SDK 7**, and `ai` is a peer dependency (`^7.0.0`). Install with `pnpm add little-workflow@alpha ai@^7 zod @ai-sdk/<provider>`. pnpm 10 apps must allow the `better-sqlite3` build (`"pnpm": { "onlyBuiltDependencies": ["better-sqlite3"] }`); `little init` writes this setting.

## Required Checks

1. Search package docs first: see [package-docs.md](references/package-docs.md).
2. Verify active APIs against source when editing code: see [source-map.md](references/source-map.md).
3. Use `pnpm` for package scripts in this repo.
4. Run the narrowest relevant check after edits, usually `pnpm --filter little-workflow test`, `pnpm --filter little-workflow typecheck`, or a targeted Vitest file.

## Quick Reference

| Need | Use |
| --- | --- |
| Define a workflow (front door) | `defineWorkflow({ id, model, input?, output?, tools?, planner?, ... })`; run with `.run(input)` or 2-arg `runWorkflow(def, input)` |
| Define a workflow (full config) | `createLittleWorkflow({ id, inputSchema, output/outputSchema, models, planner, ... })` |
| Register execution model options | `model(aiSdkModel, { id?, description? })` |
| Attach planner/worker skills | Local `skill("./skills/name")` or remote `skill("https://github.com/org/repo", { skills: ["name"] })` in role skills |
| Run locally (options form) | `runWorkflow({ world: localWorld({ dataDir }), workflows, input, tools?, mcp?, permissions? })` |
| Register tools | `createToolRegistry({ name: aiSdkTool })`; reference names from `globalTools` |
| Gate tool calls at runtime | `permissions: { ruleset: [{ tool, action: "allow"\|"deny"\|"ask" }], onAsk? }` — `tool` is a glob over the tool name (`"*"`, `"delete_*"`, `"bash*"`); `ask` without `onAsk` fails closed |
| MCP servers | Prefer `runWorkflow({ mcp })`; default gateway tools are `mcp_list_tools` and `mcp_call_tool` |
| Compose workflows (agent tools) | `asHarnessWorkflow(def, { definitionIdentity })` → `createHarness({ host, model, workflows: [...] })` (little-harness). Each workflow becomes one tool (`billing.refund` → `billing_refund`). Bound fan-out with `workflowBudgets.maxConcurrentWorkflowRuns` / `maxQueuedWorkflowRuns` |
| Folder workflows | `little-workflow.json` + `workflows/<name>/workflow.ts` (+ `instructions.md`, `tools/*.ts`, `skills/`); `loadWorkflow(folder, { executionMode? })` returns a ready Harness workflow with derived `definitionIdentity` plus `.run(input)` |
| Multi-workflow orchestration (deprecated) | `runWorkflow({ workflows: [...], orchestrator })` still works but emits `LWF_DEP_ORCHESTRATOR`; prefer `asHarnessWorkflow` |
| Run cost | `result.usage.costUsd` (`null` = unpriced, not free); `runReport(await materializeRunState(world, runId))` + `formatRunReport`; `priceModelCall` |
| Enable model-authored one-shot plans on a harness | `dynamicWorkflows()` → pass to `createHarness({ dynamicWorkflows })` (little-harness) |
| CLI | `little init [name] [--with-harness]`, `little add workflow <name>` / `little add harness`, `little validate <lwir.json>`, `little run <lwir.json> --input <in.json> [--run-id <id>]`, `little test <folder-or-name> --input <in.json>`, `little events <runId>`, `little replay <runId>`, `little report <runId> [--table]`; `--data-dir` defaults to `.little-workflow` |
| Validate compiled JSON | Read `docs/reference/lwir-reference.mdx` and `src/lwir.ts` |

## Authoring Pattern (front door: defineWorkflow)

```ts
import { tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { defineWorkflow, runWorkflow } from "little-workflow";

const summarizeTicket = defineWorkflow({
  id: "support.summarize-ticket",
  description: "Summarize a support ticket and classify severity.",
  input: z.object({ ticketId: z.string(), transcript: z.string() }),
  output: z.object({
    summary: z.string(),
    severity: z.enum(["low", "medium", "high"]),
  }),                                  // plain schema — output mode is inferred
  model: openai("gpt-4o-mini"),        // ONE model; models[] tuple synthesized
  planner: openai("gpt-5"),            // optional; bare model lifted to PlannerConfig
  tools: {                             // inline, keyed by name; no registry needed
    lookupCustomer: tool({
      description: "Look up customer metadata.",
      inputSchema: z.object({ accountId: z.string() }),
      execute: async ({ accountId }) => ({ accountId, plan: "enterprise" }),
    }),
  },
});

// 2-arg form defaults world to localWorld() and auto-wires inline tools:
const result = await runWorkflow(summarizeTicket, {
  ticketId: "TCK-123",
  transcript: "Customer reports intermittent billing export failures...",
});
// Equivalent: await summarizeTicket.run({ ... })
```

For the full-config surface — explicit `models` tuple, `model(...)` slots, `PlannerConfig`, standalone `createToolRegistry` referenced via `globalTools`, and the options-object `runWorkflow({ world, workflows, input, tools })` (where `world` is required) — use `createLittleWorkflow`; see `docs/authoring/advanced-createlittleworkflow.mdx`.

## Implementation Notes

- `defineWorkflow` normalizes to the same engine shape: single `model` → one-slot `models` tuple, bare `planner` model → `PlannerConfig` (defaults to `model`), inline `tools` → registry + `globalTools`, plain `output` schema → inferred output mode. Everything except `id` and `model` is optional.
- `planner.model` is the model that designs LWIR. `models` lists execution model slots the planner may choose for steps.
- `worker` is optional; Little Workflow defaults to the SDK `workflowHarness`. The default worker harness (`workflowHarness` / `createWorkflowHarness()`) **always throws on `code.run` steps** ("cannot safely execute code.run in the default workflow harness"). `code.run` only runs under a custom `worker.harness` that implements `execute_step`; prefer `tool.call` / `ai.generate` steps.
- `asHarnessWorkflow` takes a `defineWorkflow` result directly (no cast). `definitionIdentity` is required: a stable string (e.g. a version tag or `getWorkflowDefinitionHash(def)`) or `{ notApplicable: true, reason? }`. `executionMode` is `"inline"` (default) or `"durable"`. Any `runWorkflow` option (`tools`, `mcp`, `timeout`, `world`, …) passes through as a run default.
- A workflow tool returns `{ status, runId, outputSummary?, outputPath? }` to the calling model, not the typed output. `outputSummary` is a deterministic rendering capped at 4096 characters. Failures add `causeCode` and `message`.
- Harness-composed workflow runs are stored at `<harness dataDir>/sessions/<session>/workflows` (default dataDir `.little-harness`); inspect with `little events <runId> --data-dir <that dir>`.
- Workflow `input`/`output` schemas must fit the LWIR subset. These are accepted: `.describe()`/`title`/`examples`, `min`/`max`, enums, `z.record(z.string()|z.enum([...]), V)`. These are rejected: `.positive()`/`.gt()` (exclusive bounds), `.regex()`, `.email()`/`format`, `.default()`, `z.record(z.number(), V)`. LWIR also rejects non-empty `permissions.secrets`/`permissions.network`, `repair.mode: "escalate"`, `repair.model`, and step `cache` (`schema.unimplemented_field`).
- A parallel step fans out over at most 100 items (`maxBranches` ≤ 100); more fails the run.
- When writing direct AI SDK 7 calls in examples, use `instructions` (not `system`) for `generateText`/`streamText`, `isStepCount` (not `stepCountIs`), `onStepEnd`/`onEnd`, and the `context` tool-execute option (not `experimental_context`). Little Workflow's own option names (`planner.system`, `orchestrator.system`) are unchanged.
- Use registry model ids in examples so `costUsd` is non-null (for example `openai/gpt-4o-mini`, `openai/gpt-5`, `anthropic/claude-sonnet-4-6`, `anthropic/claude-opus-4-7`, `deepseek/deepseek-v4-flash`); see `src/model-registry.json`.
- `output` is the newer output mode surface; `outputSchema` is still accepted by the current authoring types.
- `globalTools` names must exist in the `ToolRegistry` passed to compile/run time.
- Runtime `permissions` ship in alpha: a rule's `tool` is a glob over the tool name (`*` = any run of characters, so `"delete_*"` gates `delete_record`), a matching `deny` beats `ask` and `allow`, and `ask` without an `onAsk` callback fails closed. Budget enforcement is post-alpha.
- Declarative MCP is preferred for ordinary users: pass `mcp` to `runWorkflow`, include `mcp_list_tools` / `mcp_call_tool` in `globalTools` when workflow steps need MCP, and let Little Harness manage server clients and cleanup.
- Manual `ToolRegistry.attachMcpTools(...)` remains supported for callers that already manage MCP client lifetime. Use current `@ai-sdk/mcp` imports in docs, not stale `experimental_createMCPClient` or `ai/mcp-stdio` examples.
- MCP is not a parallel execution API. Gateway tools are normal tools, callable by the model or programmatically from `code.run` bodies via the `{ input, tools }` proxy. In workflow events the tool caller is exactly `"model"` or `"code"` — there is no `"runtime"` caller in workflow runs (the Runtime Tool Bridge is a little-harness session feature).
- MCP guide skills are staged under `.agents/skills/<server-id>-mcp/SKILL.md` for model contexts, but they are guidance only and do not grant access. Capability comes from `mcp`, ToolRegistry, and workflow `globalTools`.
- MCP capability manifests are hashed into workflow identities; oversized MCP results use normal Little Harness tool result spooling and artifact paths.
- The Bash tool is SDK-injected for harness sessions. Do not put it in the Tool Registry.
- Developers can keep authored local skills in `./skills/<name>/`; planner, worker, orchestrator, and fixer sessions read materialized bodies from `.agents/skills/<name>/SKILL.md`.
- Remote skills must use explicit Git URLs. Omit `skills` to install all non-internal skills from the source; selected names match `npx skills add URL --skill name`.
- Remote skill cache entries are keyed by resolved commit SHA. Pin with a SHA/ref in the URL/source options when reproducibility matters.
- Private remote skills can pass per-source bearer auth or use the host-level `LITTLE_SKILLS_GIT_TOKEN` plus `LITTLE_SKILLS_GIT_TOKEN_HOSTS` fallback.
- Remote Git skill failures are soft at role startup and surface warnings; local skill path/frontmatter errors remain strict.
- `skillMaxRisk` can be set globally, per role, or per source. `skillRisk` overrides selected remote skill names, and `skillOidcToken` belongs on workflow/run role config defaults rather than per-skill options.
- Completed steps are durable and should not re-execute on resume.

## Common Mistakes

- Do not use or document `createRuntime()`; it is not exported from `little-workflow`.
- Do not document `pnpm add @little-workflow/littledb` as working; that package is not published and needs a non-public littleDB service.
- `dynamicWorkflows()` is exported from `little-workflow` (not `little-harness`) on purpose: it injects the plan-lowering factory the harness cannot import (circular dep). It returns `{ enabled: true, factory, exclude?, limits? }` for `createHarness({ dynamicWorkflows })`. The lowered one-shot plan is a frozen LWIR run once via `executeWorkflowVersion` (pass-through planner, no re-planning).
- Do not rely on old docs without checking `packages/little-workflow/src/index.ts`.
- Standalone workflow apps only need `little-workflow`. Import `little-harness` (`createHarness`, `localHost`, `streamHarness`/`generateHarness`) when composing workflows into an agent or customizing harness behavior.
- Do not change tool descriptors casually; descriptor hashes are part of workflow identity and resume safety.
- Do not document declarative MCP by asking users to import `@ai-sdk/mcp`; only the manual `attachMcpTools(...)` path needs direct MCP client imports.
- Do not recommend the orchestrator (`runWorkflow({ workflows: [...], orchestrator })`, `plan_workflow`/`run_workflow`/`start_workflow`, `createOrchestratorTools`, `workflowSnapshotsForOrchestrator`) for new code; it is deprecated (`LWF_DEP_ORCHESTRATOR`). Compose with `defineWorkflow` → `asHarnessWorkflow` → `createHarness({ workflows })`. The one exception is plan once, run many, which has no Harness equivalent yet (prepared runs are not implemented).
- Do not tell agents to read source `./skills/...` during runtime; inside the role working directory, prompt-visible skill bodies are under `.agents/skills/...`.
- Do not use `org/repo`, `github:org/repo`, or `gitlab:org/repo` shorthand skill sources.
