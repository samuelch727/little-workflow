# Package Docs

Read package docs before relying on memory:

1. In this monorepo: `packages/little-workflow/docs/`
2. In an installed project: `node_modules/little-workflow/docs/`
3. If docs are missing, inspect `packages/little-workflow/src/` or `node_modules/little-workflow/dist/index.d.ts`.

Useful searches:

```bash
rg "createLittleWorkflow|runWorkflow|localWorld|createToolRegistry" packages/little-workflow/docs packages/little-workflow/src
rg "lwir|ai.generate|tool.call|code.run|parallel|decision" packages/little-workflow/docs packages/little-workflow/src
rg "orchestrator|run_workflow|start_workflow|workflowVersionReuse" packages/little-workflow/docs packages/little-workflow/src
```

High-value docs:

| Need | Read |
| --- | --- |
| First workflow | `docs/quickstart.mdx` |
| Public API | `docs/reference/api-reference.mdx` |
| LWIR JSON contract | `docs/reference/lwir-reference.mdx` |
| CLI commands | `docs/reference/cli.mdx` |
| Planner lifecycle | `docs/mental-model/planner-lifecycle.mdx` |
| Tools and MCP | `docs/author-workflows/tools-capabilities.mdx` |
| Skills | `docs/author-workflows/skills.mdx` |
| Memory | `docs/author-workflows/memory.mdx` |
| Orchestration | `docs/author-workflows/orchestrator.mdx` |
| Runtime and replay | `docs/implementation/runtime-execution.mdx`, `docs/implementation/replay.mdx` |
