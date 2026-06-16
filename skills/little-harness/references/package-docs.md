# Package Docs

Read package docs before relying on memory:

1. Docs website source in this monorepo: `apps/little-harness-doc/content/docs/v0.1.0-alpha/`
2. Package docs in this monorepo: `packages/little-harness/docs/`
3. Installed package docs: `node_modules/little-harness/docs/`
4. If docs are missing or disagree, inspect `packages/little-harness/src/` or `node_modules/little-harness/dist/index.d.ts`.

When changing docs, keep the docs website and package docs aligned unless the difference is deliberate. The website is the user-facing reference; package docs are the installable agent-readable reference.

Useful searches:

```bash
rg "createHarness|streamHarness|generateHarness|inputType" apps/little-harness-doc/content/docs/v0.1.0-alpha packages/little-harness/docs packages/little-harness/src
rg "localHost|persistentDirs|memory|remember|toolResultSpooling" apps/little-harness-doc/content/docs/v0.1.0-alpha packages/little-harness/docs packages/little-harness/src
rg "workflowHarness|createWorkflowHarness|runWorkflowHarnessWithSession" apps/little-harness-doc/content/docs/v0.1.0-alpha packages/little-harness/docs packages/little-harness/src
rg "HarnessEvent|harness.model|harness.tool_call|trace|durability|priorEvents" apps/little-harness-doc/content/docs/v0.1.0-alpha packages/little-harness/docs packages/little-harness/src
```

High-value docs:

| Need | Read |
| --- | --- |
| Website reference index | `apps/little-harness-doc/content/docs/v0.1.0-alpha/reference/api-reference.mdx` |
| Website event reference | `apps/little-harness-doc/content/docs/v0.1.0-alpha/reference/events.mdx` |
| Generic runtime API | `docs/api-reference.md` |
| Little Workflow adapter | `docs/workflow-harness.md` |
| Trace events and replay | `docs/trace-and-durability.md` |
| Package overview | `README.md` |
