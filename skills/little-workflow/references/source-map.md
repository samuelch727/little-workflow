# Source Map

Use source and tests to verify docs when behavior matters.

| Task | Source files |
| --- | --- |
| Public exports | `packages/little-workflow/src/index.ts` |
| Authoring types and factories (`defineWorkflow`, `createLittleWorkflow`, `runWorkflow`, `RunWorkflowOptions`) | `packages/little-workflow/src/authoring.ts` |
| Run workflow and execute workflow versions | `packages/little-workflow/src/runtime.ts` |
| Little Harness adapter (`asHarnessWorkflow`, `outputSummary` cap) | `packages/little-workflow/src/harness-workflow.ts` |
| Folder workflows (`loadWorkflow`, tool/skill discovery, import-graph identity, `little test` name resolution) | `packages/little-workflow/src/workspace/` (`load-workflow.ts`, `discover-tools.ts`, `discover-skills.ts`, `import-graph.ts`, `resolve-workflow-reference.ts`) |
| Planner compile loop and validation | `packages/little-workflow/src/compiler.ts` |
| LWIR schema, schema subset, and canonicalization | `packages/little-workflow/src/lwir.ts`, `packages/little-workflow/src/canonical.ts`, `packages/little-workflow/src/schema.ts` |
| LWIR input-cone hashing (`inputConeHash`) | `packages/little-workflow/src/lwir-input-cone.ts` |
| Dynamic-workflow lowering + factory (`dynamicWorkflows()`) | `packages/little-workflow/src/dynamic-workflow.ts` (helper), `dynamic-workflow-plan.ts` (parse), `dynamic-workflow-lower.ts` (lower + subset check), `dynamic-workflow-factory.ts` (compile/freeze/run-once) |
| Cost: pricing, registry, reports | `packages/little-workflow/src/pricing.ts` (`priceModelCall`), `packages/little-workflow/src/model-registry.ts` + `model-registry.json`, `packages/little-workflow/src/run-report.ts` (`runReport`, `formatRunReport`) |
| Eval-set bundles (experimental) | `packages/little-workflow/src/eval-set.ts`, `packages/little-workflow/src/eval-set-store.ts` |
| Tool registry and MCP attachment | `packages/little-workflow/src/tool-registry.ts` |
| Skills | `packages/little-workflow/src/skills.ts` |
| Memory mounts | `packages/little-workflow/src/memory.ts` |
| Scratch mounts | `packages/little-workflow/src/scratch.ts` |
| Harness integration | `packages/little-workflow/src/harness/`, `packages/little-workflow/src/runtime.ts`; default worker harness (incl. `code.run` refusal) in `packages/little-harness/src/workflow-harness/workflow-harness.ts` |
| Harness-side workflow tools (tool naming, result compaction, `workflowBudgets` gate) | `packages/little-harness/src/workflows.ts`, `packages/little-harness/src/utils/workflow-concurrency.ts` |
| Orchestrator tools (deprecated) | `packages/little-workflow/src/orchestrator.ts` |
| Replay and run state | `packages/little-workflow/src/replay.ts`, `packages/little-workflow/src/run-state.ts` |
| CLI | `packages/little-workflow/src/cli-core.ts` (dispatch, `validate`/`run`/`test`/`events`/`replay`/`report`), `packages/little-workflow/src/cli/workflow-commands.ts` + `workflow-scaffold.ts` (`init`/`add`), `packages/little-workflow/src/cli.ts` |

Tests are often the fastest examples. Use:

```bash
rg "defineWorkflow|asHarnessWorkflow|loadWorkflow|runWorkflow|createToolRegistry|workflowVersionReuse" packages/little-workflow/src -g '*.test.ts'
```
