# Source Map

Use source and tests to verify docs when behavior matters.

| Task | Source files |
| --- | --- |
| Public exports | `packages/little-workflow/src/index.ts` |
| Authoring types and factories | `packages/little-workflow/src/authoring.ts` |
| Run workflow and execute workflow versions | `packages/little-workflow/src/runtime.ts` |
| Planner compile loop and validation | `packages/little-workflow/src/compiler.ts` |
| LWIR schema and canonicalization | `packages/little-workflow/src/lwir.ts`, `packages/little-workflow/src/canonical.ts` |
| Tool registry and MCP attachment | `packages/little-workflow/src/tool-registry.ts` |
| Skills | `packages/little-workflow/src/skills.ts` |
| Memory mounts | `packages/little-workflow/src/memory.ts` |
| Scratch mounts | `packages/little-workflow/src/scratch.ts` |
| Harness integration | `packages/little-workflow/src/harness/`, `packages/little-workflow/src/runtime.ts` |
| Orchestrator tools | `packages/little-workflow/src/orchestrator.ts` |
| Replay and run state | `packages/little-workflow/src/replay.ts`, `packages/little-workflow/src/run-state.ts` |
| CLI | `packages/little-workflow/src/cli-core.ts`, `packages/little-workflow/src/cli.ts` |

Tests are often the fastest examples. Use:

```bash
rg "createLittleWorkflow|runWorkflow|createToolRegistry|workflowVersionReuse" packages/little-workflow/src -g '*.test.ts'
```
