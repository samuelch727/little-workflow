# little-workflow Docs

This directory ships with the `little-workflow` npm package so agents and tools can inspect the SDK docs from `node_modules/little-workflow/docs`.

These files mirror the docs site's `v0.1.0-alpha` section. The path name is kept for stable links; the content describes the current alpha release (`0.2.0-alpha.0`: AI SDK 7, Node.js 22+). Start with:

- `getting-started/` for the overview and quickstart (install, then authoring and running a workflow with `defineWorkflow`).
- `authoring/` for authoring patterns: `define-a-workflow.mdx` (the ergonomic front door), `compose-with-harness.mdx` (`asHarnessWorkflow` / `loadWorkflow`, the supported way to compose workflows), tools and MCP, AI SDK-native model usage, memory, skills, the deprecated orchestrator, and the lower-level `createLittleWorkflow`.
- `running/` for `runWorkflow`, Local World, inspecting runs, replay and durability, and the littledb adapter (preview; not published).
- `reference/api-reference.mdx` for exported SDK APIs.
- `reference/lwir-reference.mdx` for the compiled workflow JSON contract and the schema subset.
- `reference/cli.mdx` for the `little` CLI.
- `reference/changelog.mdx` for what changed in this release.
- `foundations/` for the mental model and planner lifecycle.
- `cookbook/` for recipes grounded in the repo's runnable `demos/`.
- `internals/` for compiler, runtime, event log, replay, harness, and storage internals.
- `roadmap.mdx` for post-alpha direction.

Links of the form `/docs/v0.1.0-alpha/...` refer to the published docs site; inside this folder the same page lives at the matching relative path (e.g. `/docs/v0.1.0-alpha/authoring/skills` → `authoring/skills.mdx`).

When working inside the monorepo, also verify behavior against `packages/little-workflow/src/` and nearby tests because source may be ahead of these docs.
