# Package Docs

Read package docs before relying on memory:

1. Docs website source in this monorepo: `apps/little-workflow-doc/content/docs/v0.1.0-alpha/`
2. Package docs in this monorepo: `packages/little-workflow/docs/`
3. In an installed project: `node_modules/little-workflow/docs/`
4. If docs are missing or disagree, inspect `packages/little-workflow/src/` or `node_modules/little-workflow/dist/index.d.ts`.

The package docs mirror the website's `v0.1.0-alpha` tree (same section paths; the path name is kept for stable links while the content tracks the current alpha release). When changing docs, keep the docs website and the package mirror aligned.

Useful searches:

```bash
rg "defineWorkflow|createLittleWorkflow|runWorkflow|localWorld|createToolRegistry|mcp_list_tools|mcp_call_tool" packages/little-workflow/docs packages/little-workflow/src
rg "lwir|ai.generate|tool.call|code.run|parallel|decision" packages/little-workflow/docs packages/little-workflow/src
rg "asHarnessWorkflow|loadWorkflow|definitionIdentity|workflowBudgets|outputSummary" packages/little-workflow/docs packages/little-workflow/src
rg "orchestrator|run_workflow|start_workflow|workflowVersionReuse|permissions" packages/little-workflow/docs packages/little-workflow/src
```

High-value docs:

| Need | Read |
| --- | --- |
| First workflow | `docs/getting-started/quickstart.mdx` |
| Ergonomic authoring front door | `docs/authoring/define-a-workflow.mdx` |
| Compose workflows into a Little Harness agent (`asHarnessWorkflow`, `loadWorkflow`) | `docs/authoring/compose-with-harness.mdx` |
| Full-config authoring | `docs/authoring/advanced-createlittleworkflow.mdx` |
| Public API | `docs/reference/api-reference.mdx` |
| LWIR JSON contract | `docs/reference/lwir-reference.mdx` |
| CLI commands | `docs/reference/cli.mdx` |
| Run options + permissions | `docs/running/run-a-workflow.mdx` |
| Planner lifecycle | `docs/foundations/planner-lifecycle.mdx` |
| Tools and MCP | `docs/authoring/tools-and-capabilities.mdx` |
| Skills | `docs/authoring/skills.mdx` |
| Memory | `docs/authoring/memory.mdx` |
| Orchestration (deprecated) | `docs/authoring/orchestrating-workflows.mdx` |
| What changed in this release | `docs/reference/changelog.mdx` |
| Runtime and replay internals | `docs/internals/runtime-execution.mdx`, `docs/internals/replay.mdx` |
| Recipes from runnable demos | `docs/cookbook/` (demos live at repo `demos/`) |
| Post-alpha direction | `docs/roadmap.mdx` |
