---
name: little-workflow
description: "Use when working with the little-workflow package, Little Workflow SDK, defineWorkflow, runWorkflow, fixed-plan workflows, asHarnessWorkflow, loadWorkflow, localWorld, LWIR, workflow authoring, composing workflows into a Little Harness agent, tool registries, the deprecated orchestrator, skills, memory, replay, run costs, workflow durability, or the little CLI."
---

# Little Workflow

## Overview

Use this skill to build, debug, or explain Little Workflow apps. Treat local docs and source as authoritative; the package is still moving and model memory is likely stale.

This release: `@little-stack/workflow@0.2.0-alpha.3`. Harness and Workflow share the `@little-stack` scope and version line. It requires Node.js 22+ and **AI SDK 7**, and `ai` is a peer dependency (`^7.0.0`). Install with `pnpm add @little-stack/workflow@alpha ai@^7 zod @ai-sdk/<provider>`. pnpm 10 apps must allow the `better-sqlite3` build (`"pnpm": { "onlyBuiltDependencies": ["better-sqlite3"] }`); `little init` writes this setting.

## Required Checks

1. Search package docs first: see [package-docs.md](references/package-docs.md).
2. Verify active APIs against source when editing code: see [source-map.md](references/source-map.md).
3. Use `pnpm` for package scripts in this repo.
4. Run the narrowest relevant check after edits, usually `pnpm --filter @little-stack/workflow test`, `pnpm --filter @little-stack/workflow typecheck`, or a targeted Vitest file.

## Unified setup

Prefer `npx @little-stack/workflow@alpha setup` for new standalone/Next projects and additive existing Next (`--here --template existing-next --plan`). `--here` only means the current directory; the existing-app mode is reached only through `--template existing-next`, and new-project templates (`node` default, `next`) need an empty target. The default provider is `openai` (as in `little init` and `little-harness init`). Harness is mandatory; `--workflow` wires a durable keyless example, a fixed-plan `starter_echo` workflow with no model, loaded into the agent with `loadWorkflow`. Install requires `--install`; Workflow native build requires `--allow-native-build`. `--verify` forces keyless smoke. Preserve conflicts and user edits; no blanket force, major upgrades, browser userId auth, paid provisioning or deployment. Recover an interrupted run with `setup <same-dir> --rollback` (or `--here` inside it); it reports nothing-to-recover, rolled-back, completed-cleanup or manual-recovery-required, and `recoverSetup()` returns that status. Compute and LittleDB are not published on npm. See `packages/little-workflow/docs/setup.md`.

## Quick Reference

| Need | Use |
| --- | --- |
| Define a workflow | `defineWorkflow({ id, model, input?, output?, tools?, planner?, ... })`; run with `runWorkflow(workflow, input, options?)` or `workflow.run(input, options?)` |
| Define a workflow (full config) | `defineWorkflow({ id, input, output, models: [model(...), ...], planner: { model, system, skills }, tools, toolSelection?, workflowVersionReuseStrategy?, worker?, memory?, bash? })` |
| Fixed plan, no model | `defineWorkflow({ id, input, tools, plan: { steps: [...] } })`; `{ steps }` is completed from the definition, or pass a complete LWIR document |
| Register execution model options | `model(aiSdkModel, { id?, description? })` |
| Attach planner/worker skills | Local `skill("./skills/name")` or remote `skill("https://github.com/org/repo", { skills: ["name"] })` in role skills |
| Run locally | `runWorkflow(workflow, input, { world?, tools?, mcp?, permissions?, runId?, timeout?, trigger? })`; `world` defaults to `localWorld()`, `tools` to the workflow's inline tools |
| Run without disk | `virtualWorld({ fs, dataDir?, maxConcurrentSteps? })` exposes `World.files` and keeps events/artifacts/run files in a just-bash filesystem (`dataDir` defaults `/`, POSIX). One process owns it. Locks/chains share the exact filesystem object and normalized root; separate filesystem wrappers have separate identity. Persistence and atomic moves come from the filesystem, with no in-flight recovery promise. Folder/remote skills are refused. Harness `dynamicWorkflows()`, `asHarnessWorkflow` and `versionedHarnessWorkflow` share this default when the run context supplies `persistence.fs`; version pins use that World, explicit Worlds/factories are preserved, and custom dynamic World callbacks receive `fs` too. See `running/virtual-world.mdx`. |
| Catch a failed run | `isRunFailedError(err)` narrows to `RunFailedError` (`runId`, `causeCode`, `failedStepPath?`); prefer it to `instanceof` or `err.name` checks |
| Register tools | Inline `tools: { name: tool(...) }` on `defineWorkflow`, or `createToolRegistry({ name: aiSdkTool })` passed as the run's `tools` with the names in `defineWorkflow({ tools: ["name"] })` |
| Gate tool calls at runtime | `permissions: { ruleset: [{ tool, action: "allow"\|"deny"\|"ask" }], onAsk? }` — `tool` is a glob over the tool name (`"*"`, `"delete_*"`, `"bash*"`); `ask` without `onAsk` fails closed |
| MCP servers | Prefer `runWorkflow(workflow, input, { mcp })`; default gateway tools are `mcp_list_tools` and `mcp_call_tool` |
| Compose workflows (agent tools) | `asHarnessWorkflow(def, { definitionIdentity })` → `createHarness({ host, model, workflows: [...] })` (little-harness). Each workflow becomes one tool (`billing.refund` → `billing_refund`). Bound fan-out with `workflowBudgets.maxConcurrentWorkflowRuns` / `maxQueuedWorkflowRuns` |
| Folder workflows | `little-workflow.json` + `workflows/<name>/workflow.ts` (+ `instructions.md`, `tools/*.ts`, `skills/`); `loadWorkflow(folder, { executionMode? })` returns a ready Harness workflow with derived `definitionIdentity` plus `.run(input)` |
| Multi-workflow orchestration (deprecated) | `runOrchestration({ workflows: [...], orchestrator, input })` still works but emits `LWF_DEP_ORCHESTRATOR`; prefer `asHarnessWorkflow` |
| Run cost | `result.usage.costUsd` (`null` = unpriced, not free); `runReport(await materializeRunState(world, runId))` + `formatRunReport` and `priceModelCall` from `@little-stack/workflow/internals` |
| Rules every model step follows | `defineWorkflow({ policy: "..." })`: added word for word to every `ai.generate` system prompt at run time (not stored in the plan); prefer it to rules in `description` |
| Grade a run | `gradeRun(world, runId, { verdict: "pass" \| "fail", reason?, gradedBy? })`; a `"fail"` grade sends that run's plan back to the planner, with the reason, on the next run. `listRunGrades(world, { runId?, workflowVersionId? })` |
| A step reads another step's output | List it in `needs`. A planner's draft gets missing same-list `needs` added at compile time; a fixed `plan` must list them itself |
| Which plan ran | `result.plan`: `{ kind: "drafted" \| "kept" \| "adapted" \| "fixed", plannerCalled, workflowVersionId, previousWorkflowVersionId?, rationale? }`; read its steps with `readWorkflowVersion(world, id)` (never read `workflow-versions/*.json`). `workflowVersionReuseStrategy`: `"planner_reviewed"` (default; keeps the plan with no planner call when only input values change), `"planner_reviews_each_run"` (input values change the plan), `"always_fresh"` |
| Entry points | Root: define/run/replay/compose. `/lwir`: `validateLwir`, `assertValidLwir`, `registerWorkflowVersion`. `/eval`: eval sets. `/scaffold`: setup/init generators. `/internals`: unstable plumbing (`createLittleWorkflow`, runtime, world storage functions, `workflowHarness`, pricing) |
| Enable model-authored one-shot plans and agent-defined workflows on a harness | `dynamicWorkflows()` → pass to `createHarness({ dynamicWorkflows })` (little-harness); `define_workflow` builds a `defineWorkflow` from the agent's description, planned by the agent's model |
| Control which agent-defined workflows a turn offers, or where their runs are stored | `dynamicWorkflows({ registry: { defined?, resolve? }, world })`: `defined(record, { sessionId, turnId })` may return `{ note?, metadata? }` after `define_workflow` stores a revision; `resolve(records, ctx)` returns the turn's offers (throwing = none offered, with a warning). `world` is a World or `(run) => World`, `run` = `{ kind: "defined" \| "ad_hoc", workflowId, handle, runId, dataDir, sessionId, turnId, toolCallId, definition?, revision?, metadata? }`; default `localWorld` at `run.dataDir`. Types: `DynamicWorkflowWorld`, `DynamicWorkflowWorldContext` |
| Trace runs to LittleDB (private, unpublished; needs a non-public LittleDB server) | `createLittleDB({ url, apiKey })` from `@little-stack/littledb`; `db.tracingWorld(innerWorld, { workflow, origin?, resolution?, harness?, sessionId? })` wraps any World (the inner World stays the source of truth) and sends each run as one trace, with how it started: `runWorkflow(..., { trigger })` (`RunTrigger`: `{ kind, source?, from?, label?, sessionId?, turnId?, toolCallId? }`, on the top-level `RunStarted` only); `asHarnessWorkflow` and dynamic workflow runs set `{ kind: "harness", sessionId, turnId, toolCallId }`, so the trace takes the session and points at the turn's trace and tool span (`sessionId` is only an override), and a sub-run points at its parent run; `db.resolve({ kind: "workflow", slug, bootstrap })` picks a version; `db.agentWorkflowRegistry({ harness })` as the `registry` makes each `define_workflow` a draft version with a proposal a person approves; `db.evalWorker({ subjects, run })` runs experiments in the app, and `db.workflowEvalWorker({ workflow, world, run, grade })` runs one workflow's (each run's version content to build from, the item's input, a traced World); end users' thumbs, ratings and surveys go in as user feedback with `db.feedback({ traceId \| sessionId, ... })`, `db.feedbackHandler({ authorize, resolveTrace? })` (mounted on the app's backend for the browser) and `db.outcomeSink({ tracer })` (Harness outcomes and chat reactions). OTLP/HTTP at `<url>/v1/otlp/v1/traces` is the alternative. Docs: `apps/little-workflow-doc/content/docs/littledb/` (`feedback.mdx` for user feedback) |
| CLI | `little init [name \| --here] [--workflow-name <name>] [--with-harness]` (never prompts or installs; rejects `--yes`/`--no-install`), `little add workflow <name>` / `little add harness [--workflow-name <name> \| --new-workflow <name>]`, `little validate <lwir.json>`, `little run <lwir.json> --input <in.json> [--run-id <id>]`, `little test <folder-or-name> --input <in.json>`, `little events <runId>`, `little replay <runId>`, `little report <runId> [--table]`; `--data-dir` defaults to `.little-workflow` |
| Validate compiled JSON | Read `docs/reference/lwir-reference.mdx` and `src/lwir.ts` |

## Authoring Pattern (front door: defineWorkflow)

```ts
import { tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { defineWorkflow, runWorkflow } from "@little-stack/workflow";

const summarizeTicket = defineWorkflow({
  id: "support.summarize-ticket",
  description: "Summarize a support ticket and classify severity.",
  input: z.object({ ticketId: z.string(), transcript: z.string() }),
  output: z.object({
    summary: z.string(),
    severity: z.enum(["low", "medium", "high"]),
  }),                                  // plain schema — output mode is inferred
  model: openai("gpt-4o-mini"),        // one model; use models: [...] for several slots
  planner: openai("gpt-5"),            // optional; bare model lifted to PlannerConfig
  tools: {                             // inline, keyed by name; no registry needed
    lookupCustomer: tool({
      description: "Look up customer metadata.",
      inputSchema: z.object({ accountId: z.string() }),
      execute: async ({ accountId }) => ({ accountId, plan: "enterprise" }),
    }),
  },
});

// world defaults to localWorld(); inline tools are wired in:
const result = await runWorkflow(summarizeTicket, {
  ticketId: "TCK-123",
  transcript: "Customer reports intermittent billing export failures...",
});
// Equivalent: await summarizeTicket.run({ ... })
```

The same call takes the full config: several `model(...)` slots under `models`, a `PlannerConfig` under `planner`, tool names supplied by a run-time `createToolRegistry`, `toolSelection`, `workflowVersionReuseStrategy`, `worker`, `memory` and `bash`; see `docs/authoring/advanced-createlittleworkflow.mdx` (titled Workflow Config). A fixed `plan` replaces the planner; see `docs/authoring/define-a-workflow.mdx#a-fixed-plan`.

## Implementation Notes

- `defineWorkflow` normalizes to the engine shape: `model` → one model slot (or `models` → several; not both), bare `planner` model → `PlannerConfig` (defaults to the first model), inline `tools` → registry + declared tool names, plain `output` schema → inferred output mode, `plan` → a fixed-plan planner that makes no model call. A workflow needs `id` plus `model`, `models` or `plan`; `plan` and `planner` are exclusive.
- `planner.model` is the model that designs LWIR. `models` lists execution model slots the planner may choose for steps.
- `worker` is optional; Little Workflow defaults to the SDK `workflowHarness`. The default worker harness (`workflowHarness` / `createWorkflowHarness()`) **always throws on `code.run` steps** ("cannot safely execute code.run in the default workflow harness"). `code.run` only runs under a custom `worker.harness` that implements `execute_step`; prefer `tool.call` / `ai.generate` steps.
- An `ai.generate` step is one model call. System prompt = the worker's system prompt and skill list, then `with.system` after a blank line; one user message = `with.prompt` + `"\n\nInput:\n"` + the resolved step input (`input`, else `with.args`, else the workflow input or parallel item). `{{ }}` in `with.prompt` / `with.system` resolves at run time with the same roots as `input`, always to text (a template-only object/array value is JSON-stringified). The default worker harness offers `ai.generate` no tools and no bash, whatever the output mode; tool use is an explicit `tool.call` step (there is no `with.tools`). A custom `worker.harness` still receives the tools in its context.
- `asHarnessWorkflow` takes a `defineWorkflow` result directly (no cast). `definitionIdentity` is required: a stable string (e.g. a version tag or `getWorkflowDefinitionHash(def)`) or `{ notApplicable: true, reason? }`. `executionMode` is `"inline"` (default) or `"durable"`. Any `runWorkflow` option (`tools`, `mcp`, `timeout`, `world`, …) passes through as a run default.
- For LittleDB-managed content, `versionedHarnessWorkflow(managed, build)` writes the run's content/version pin before its first step and rebuilds from that pin on resume without selecting latest. A missing or malformed run pin fails rather than silently changing versions. A managed Harness turn that parks separately retains its own prompt and model descriptor/payer through `turnOptions`; do not replace that pin with a fresh `resolve` when continuing a workflow's caller.
- A workflow tool returns `{ status, runId, outputSummary?, outputPath? }` to the calling model, not the typed output. `outputSummary` is a deterministic rendering capped at 4096 characters. Failures add `causeCode` and `message`.
- Harness-composed workflow runs are stored at `<harness dataDir>/sessions/<session>/workflows` (default dataDir `.little-harness`); inspect with `little events <runId> --data-dir <that dir>`.
- Workflow `input`/`output` schemas must fit the LWIR subset. These are accepted: `.describe()`/`title`/`examples`, `min`/`max`, enums, `z.record(z.string()|z.enum([...]), V)`. These are rejected: `.positive()`/`.gt()` (exclusive bounds), `.regex()`, `.email()`/`format`, `.default()`, `z.record(z.number(), V)`. LWIR also rejects non-empty `permissions.secrets`/`permissions.network`, `repair.mode: "escalate"`, `repair.model`, and step `cache` (`schema.unimplemented_field`).
- A parallel step fans out over at most 100 items (`maxBranches` ≤ 100); more fails the run.
- When writing direct AI SDK 7 calls in examples, use `instructions` (not `system`) for `generateText`/`streamText`, `isStepCount` (not `stepCountIs`), `onStepEnd`/`onEnd`, and the `context` tool-execute option (not `experimental_context`). Little Workflow's own option names (`planner.system`, `orchestrator.system`) are unchanged.
- Use registry model ids in examples so `costUsd` is non-null (for example `openai/gpt-4o-mini`, `openai/gpt-5`, `anthropic/claude-sonnet-4-6`, `anthropic/claude-opus-4-7`, `deepseek/deepseek-v4-flash`); see `src/model-registry.json`.
- `output` takes a plain schema (array/object/text inferred) or an explicit `output.*` mode.
- Tool names declared with `tools: ["name"]` must exist in the `ToolRegistry` passed as the run's `tools`.
- Runtime `permissions` ship in alpha: a rule's `tool` is a glob over the tool name (`*` = any run of characters, so `"delete_*"` gates `delete_record`), a matching `deny` beats `ask` and `allow`, and `ask` without an `onAsk` callback fails closed. Budget enforcement is post-alpha.
- Declarative MCP is preferred for ordinary users: pass `mcp` to `runWorkflow`, include `mcp_list_tools` / `mcp_call_tool` in the workflow's `tools` when workflow steps need MCP, and let Little Harness manage server clients and cleanup.
- Manual `ToolRegistry.attachMcpTools(...)` remains supported for callers that already manage MCP client lifetime. Use current `@ai-sdk/mcp` imports in docs, not stale `experimental_createMCPClient` or `ai/mcp-stdio` examples.
- MCP is not a parallel execution API. Gateway tools are normal tools, callable by the model or programmatically from `code.run` bodies via the `{ input, tools }` proxy. In workflow events the tool caller is exactly `"model"` or `"code"` — there is no `"runtime"` caller in workflow runs (the Runtime Tool Bridge is a little-harness session feature).
- MCP guide skills are staged under `.agents/skills/<server-id>-mcp/SKILL.md` for model contexts, but they are guidance only and do not grant access. Capability comes from `mcp`, ToolRegistry, and the workflow's `tools`.
- MCP capability manifests are hashed into workflow identities; oversized MCP results use normal Little Harness tool result spooling and artifact paths.
- The Bash tool is SDK-injected for harness sessions. Do not put it in the Tool Registry.
- Developers can keep authored local skills in `./skills/<name>/`; planner, worker, orchestrator, and fixer sessions read materialized bodies from `.agents/skills/<name>/SKILL.md`.
- Remote skills must use explicit Git URLs. Omit `skills` to install all non-internal skills from the source; selected names match `npx skills add URL --skill name`.
- Remote skill cache entries are keyed by resolved commit SHA. Pin with a SHA/ref in the URL/source options when reproducibility matters.
- Private remote skills can pass per-source bearer auth or use the host-level `LITTLE_SKILLS_GIT_TOKEN` plus `LITTLE_SKILLS_GIT_TOKEN_HOSTS` fallback.
- Remote Git skill failures are soft at role startup and surface warnings; local skill path/frontmatter errors remain strict.
- `skillMaxRisk` can be set globally, per role, or per source. `skillRisk` overrides selected remote skill names, and `skillOidcToken` belongs on workflow/run role config defaults rather than per-skill options.
- Completed steps are durable and should not re-execute on resume.
- Custom harness durability adapters must preserve the caller-generated
  `appendIdempotencyKey`. Little Workflow stores that key and its canonical
  request digest in Local World; identical retries return the original event,
  while key reuse with different content fails closed.

## Common Mistakes

- Do not use or document `createRuntime()`; it is not exported from `@little-stack/workflow`.
- Do not document `pnpm add @little-stack/littledb` as working; that package is not published and needs a non-public LittleDB server.
- `dynamicWorkflows()` is exported from `@little-stack/workflow` (not `@little-stack/harness`) on purpose: it injects the plan-lowering factory the harness cannot import (circular dep). It returns `{ enabled: true, factory, exclude?, limits?, models?, define?, registry? }` for `createHarness({ dynamicWorkflows })`; `world` goes into the factory. The lowered one-shot plan is a frozen LWIR run once via `executeWorkflowVersion` (pass-through planner, no re-planning).
- Do not rely on old docs without checking `packages/little-workflow/src/index.ts` (the explicit root export list, pinned by `src/index.test.ts`).
- Do not import `createLittleWorkflow`, `listEvents`, `materializeRunState`, `workflowHarness` or other plumbing from the root; they live on `@little-stack/workflow/internals` (unstable). `runWorkflow` takes `(workflow, input, options?)`; the options-object form was removed.
- Standalone workflow apps only need `@little-stack/workflow`. Import `@little-stack/harness` (`createHarness`, `localHost`, `streamHarness`/`generateHarness`) when composing workflows into an agent or customizing harness behavior.
- Do not change tool descriptors casually; descriptor hashes are part of workflow identity and resume safety.
- Do not document declarative MCP by asking users to import `@ai-sdk/mcp`; only the manual `attachMcpTools(...)` path needs direct MCP client imports.
- Do not recommend the orchestrator (`runOrchestration({ workflows: [...], orchestrator })`, `plan_workflow`/`run_workflow`/`start_workflow`, `createOrchestratorTools`, `workflowSnapshotsForOrchestrator`) for new code; it is deprecated (`LWF_DEP_ORCHESTRATOR`). Compose with `defineWorkflow` → `asHarnessWorkflow` → `createHarness({ workflows })`. The one exception is plan once, run many, which has no Harness equivalent yet (prepared runs are not implemented).
- Do not tell agents to read source `./skills/...` during runtime; inside the role working directory, prompt-visible skill bodies are under `.agents/skills/...`.
- Do not use `org/repo`, `github:org/repo`, or `gitlab:org/repo` shorthand skill sources.

- Harness configured, discovered and MCP `start_*` tools are allowed unless their exact name collides with a generated workflow launcher. Workflow handles still cannot begin with `start_`.

## Managed Harness snapshots (private source draft)

`managedHarness({execution:{registry,model,state}})` maps admitted format-1 content
onto the neutral Harness snapshot, using the same registry as `createHarness`.
This first slice refuses workflow/dynamic/agent tools in snapshot mode; ordinary
Workflow and legacy managed Harness calls keep their existing behavior. Evaluations
need the exact claimed content/version and isolated tool/memory state per run; no
bootstrap/fallback may be scored as the candidate. Read the LittleDB Harness guide's
format-1 section before opting in. No implementation from candidate data is executed.
