# Package Docs

Read package docs before relying on memory:

1. Docs website source in this monorepo: `apps/little-harness-doc/content/docs/v0.1.0-alpha/`
2. Package docs in this monorepo: `packages/little-harness/docs/`
3. Installed package docs: `node_modules/little-harness/docs/`
4. If docs are missing or disagree, inspect `packages/little-harness/src/` or `node_modules/little-harness/dist/index.d.ts`.

When changing docs, keep the docs website and package docs aligned unless the difference is deliberate. The website is the user-facing reference; package docs are the installable agent-readable reference.

Useful searches:

```bash
rg "createHarness|streamHarness|generateHarness|inputType|mcp_list_tools|mcp_call_tool|chatSdkConnector|webRichConnector|loadChatSdkConnector|loadWebRichConnector" apps/little-harness-doc/content/docs/v0.1.0-alpha packages/little-harness/docs packages/little-harness/src
rg "localHost|persistentDirs|memory|remember|toolResultSpooling" apps/little-harness-doc/content/docs/v0.1.0-alpha packages/little-harness/docs packages/little-harness/src
rg "workflowHarness|createWorkflowHarness|runWorkflowHarnessWithSession" apps/little-harness-doc/content/docs/v0.1.0-alpha packages/little-harness/docs packages/little-harness/src
rg "dynamicWorkflows|run_ad_hoc_plan|search_authored_plans|capability_not_allowed" apps/little-harness-doc/content/docs/v0.1.0-alpha packages/little-harness/docs packages/little-harness/src
rg "HarnessEvent|harness.model|harness.tool_call|trace|durability|priorEvents" apps/little-harness-doc/content/docs/v0.1.0-alpha packages/little-harness/docs packages/little-harness/src
rg "sessionLog|HarnessSessionLog|remoteSessionLog|startSessionLogServer|createFileSessionLog" apps/little-harness-doc/content/docs/v0.1.0-alpha packages/little-harness/docs packages/little-harness/src
rg "executionEnvironment|subprocessSandbox|tieredExecutionEnvironment|classifyCommand|detectEmulationGap|tier0CapabilityMatrix|TIER_REFUSED_EXIT_CODE|defenseInDepthForAdapter" apps/little-harness-doc/content/docs/v0.1.0-alpha packages/little-harness/docs packages/little-harness/src
rg "outcome\.reported|reportHarnessOutcome|createHarnessOutcomeReporter|aggregateLocalOutcomes|reactions|attachments" apps/little-harness-doc/content/docs/v0.1.0-alpha packages/little-harness/docs packages/little-harness/src
rg "asHarnessWorkflow|workflowBudgets|outputSummary|discoverWorkflows|definitionIdentity" apps/little-harness-doc/content/docs/v0.1.0-alpha packages/little-harness/docs packages/little-harness/src
```

High-value docs:

| Need | Read |
| --- | --- |
| Website reference index | `apps/little-harness-doc/content/docs/v0.1.0-alpha/reference/api-reference.mdx` |
| Website event reference | `apps/little-harness-doc/content/docs/v0.1.0-alpha/reference/events.mdx` |
| Dynamic workflows guide | `apps/little-harness-doc/content/docs/v0.1.0-alpha/build-agents/dynamic-workflows.mdx` (+ the `dynamicWorkflows` block in `reference/create-harness.mdx`) |
| Workflow integration guide | `apps/little-harness-doc/content/docs/v0.1.0-alpha/build-agents/workflows.mdx` |
| Execution environments, modes, and the subprocess sandbox | `apps/little-harness-doc/content/docs/v0.1.0-alpha/runtime/execution-environments.mdx` |
| Execution tiers and command classification | `apps/little-harness-doc/content/docs/v0.1.0-alpha/runtime/execution-tiers.mdx` |
| Tier-0 security contract | `apps/little-harness-doc/content/docs/v0.1.0-alpha/runtime/isolation-and-security.mdx`, `docs/api-reference.md` ("The Tier-0 security contract") |
| Outcome capture | `apps/little-harness-doc/content/docs/v0.1.0-alpha/build-agents/outcomes.mdx` |
| Chat connectors (attachments, reactions) | `apps/little-harness-doc/content/docs/v0.1.0-alpha/build-agents/chat-connectors.mdx` |
| Foundations (sessions, files, persistent dirs, tracing) | `apps/little-harness-doc/content/docs/v0.1.0-alpha/foundations/` |
| Generic runtime API | `docs/api-reference.md` |
| Little Workflow adapter | `docs/workflow-harness.md` |
| Trace events and replay | `docs/trace-and-durability.md` |
| Package overview | `README.md` |
