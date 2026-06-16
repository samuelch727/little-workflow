# little-harness Docs

This directory ships with the `little-harness` npm package so agents and tools can inspect runtime docs from `node_modules/little-harness/docs`.

Start with:

- `api-reference.md` for `createHarness`, `localHost`, `generateHarness`, `streamHarness`, `inputType`, `skill`, `memory`, files, artifacts, persistent dirs, and callbacks.
- `workflow-harness.md` for the Little Workflow adapter exported from `little-harness/workflow-harness`.
- `trace-and-durability.md` for trace files, event names, durability replay, and redaction settings.

When working inside the monorepo, verify current behavior against `packages/little-harness/src/` and tests because source can be ahead of docs.
