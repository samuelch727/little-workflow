# little-workflow

This package contains the v0.1.0-alpha Little Workflow TypeScript SDK.

The alpha surface includes workflow authoring helpers, OrchestrationRequest compilation, LWIR validation, Local World execution/replay, AI SDK-native model and tool integration, and the `little` CLI for compiled JSON artifacts.

## Install

```sh
pnpm add little-workflow
```

Little Workflow's Local World event store uses `better-sqlite3`. In pnpm v10 projects, approve that native build at the consuming app root before running workflows:

```yaml
# pnpm-workspace.yaml
onlyBuiltDependencies:
  - better-sqlite3
```

## Storage Note

The public World API is `appendEvent`, `listEvents`, and `materializeRunState`. The local alpha implementation stores events in `<dataDir>/events/events.db` using SQLite WAL mode; `little events <runId>` prints newline-delimited JSON for inspection, but raw event files are not part of the storage contract.

## License

Licensed under the [Apache License 2.0](./LICENSE).
