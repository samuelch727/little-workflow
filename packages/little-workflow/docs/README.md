# little-workflow Docs

This directory ships with the `little-workflow` npm package so agents and tools can inspect the SDK docs from `node_modules/little-workflow/docs`.

These files mirror the v0.1.0-alpha docs used by the docs app. Start with:

- `quickstart.mdx` for authoring and running a workflow.
- `reference/api-reference.mdx` for exported SDK APIs.
- `reference/lwir-reference.mdx` for the compiled workflow JSON contract.
- `reference/cli.mdx` for the `little` CLI.
- `author-workflows/` for authoring patterns such as tools, skills, memory, orchestrators, and AI SDK-native model usage.
- `implementation/` for compiler, runtime, event log, replay, harness, and storage internals.

When working inside the monorepo, also verify behavior against `packages/little-workflow/src/` and nearby tests because source may be ahead of these docs.
