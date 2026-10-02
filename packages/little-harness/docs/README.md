# little-harness Docs

This directory ships with the `little-harness` npm package so agents and tools can inspect runtime docs from `node_modules/little-harness/docs`.

Start with:

- `api-reference.md` for `createHarness`, `localHost`, `generateHarness`, `streamHarness`, `inputType`, `skill`, `memory`, files, artifacts, persistent dirs, callbacks, workflows as tools, chat connectors (attachments, reactions), outcome capture, and execution environments (modes, the Tier-0 security contract, command classification, tiered execution).
- `workflow-harness.md` for the Little Workflow adapter exported from `little-harness/workflow-harness`.
- `trace-and-durability.md` for trace files, event names (including `outcome.reported`), the session log and durability replay, and redaction settings.

The docs site (https://little-harness.dev/docs) carries the same material as guides. When working inside the monorepo, verify current behavior against `packages/little-harness/src/` and tests because source can be ahead of docs.
