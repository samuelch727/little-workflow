# little-workflow

For a guided Next.js or standalone setup, including additive existing Next.js integration, use `npx little-workflow@alpha setup`. See [unified setup](../little-workflow/docs/setup.md).

Local-first TypeScript workflows that an AI planner designs for itself. You describe the goal, schemas, a model, and tools. The planner compiles a bounded workflow graph (LWIR), and Little Workflow validates it, runs it durably in a local event store, and lets you replay and inspect every step.

> **Alpha.** Breaking changes to the LWIR wire format, public APIs, and persistence formats are expected between alpha releases.

## Install

```sh
pnpm add little-workflow@alpha ai@^7 zod @ai-sdk/anthropic   # or any AI SDK 7 provider
```

- **Node.js 22 or later.**
- **AI SDK 7.** `ai` is a peer dependency (`^7.0.0`), so install it alongside the package.
- **pnpm 10** skips dependency build scripts unless allowed. The Local World event store needs `better-sqlite3`'s native build, so add this to your app's `package.json`:

  ```json
  { "pnpm": { "onlyBuiltDependencies": ["better-sqlite3"] } }
  ```

Or scaffold a project with pinned versions and this setting already in place: `npx little-workflow@alpha init my-app`.

## Example

```ts
import { anthropic } from "@ai-sdk/anthropic";
import { tool } from "ai";
import { z } from "zod";
import { defineWorkflow, runWorkflow } from "little-workflow";

const summarizeTicket = defineWorkflow({
  id: "support.summarize-ticket",
  description: "Summarize a support ticket and classify its severity.",
  input: z.object({ accountId: z.string(), transcript: z.string() }),
  output: z.object({
    summary: z.string(),
    severity: z.enum(["low", "medium", "high"]),
  }),
  model: anthropic("claude-sonnet-4-6"),
  tools: {
    lookupCustomer: tool({
      description: "Look up a customer's plan by account id.",
      inputSchema: z.object({ accountId: z.string() }),
      execute: async ({ accountId }) => ({ accountId, plan: "enterprise" }),
    }),
  },
});

const result = await runWorkflow(summarizeTicket, {
  accountId: "acct_42",
  transcript: "Billing exports fail intermittently since Tuesday...",
});

result.output;        // { summary, severity }, typed from the output schema
result.usage.costUsd; // real USD from the bundled model registry, or null if unpriced
result.runId;         // inspect with `little events <runId>` or `little report <runId> --table`
```

Runs are stored in `.little-workflow/` by default. Calling `runWorkflow` again with the same `runId` replays the recorded result without calling models or tools again.

To give workflows to an agent as typed tools, adapt them with `asHarnessWorkflow` and pass them to `createHarness({ workflows })` from [`little-harness`](https://github.com/samuelch727/little-workflow/tree/main/packages/little-harness).

## Docs

- Docs ship in the package under [`docs/`](./docs/README.md) (`node_modules/little-workflow/docs`).
- [Quickstart](./docs/getting-started/quickstart.mdx), [Compose With Little Harness](./docs/authoring/compose-with-harness.mdx), [API reference](./docs/reference/api-reference.mdx), [CLI](./docs/reference/cli.mdx), [Changelog](./docs/reference/changelog.mdx)
- Runnable demos: [`demos/`](https://github.com/samuelch727/little-workflow/tree/main/demos)
- Source and issues: [github.com/samuelch727/little-workflow](https://github.com/samuelch727/little-workflow)

## Storage Note

The public World API is `appendEvent`, `listEvents`, and `materializeRunState`. The local alpha implementation stores events in `<dataDir>/events/events.db` using SQLite WAL mode. `little events <runId>` prints newline-delimited JSON for inspection, but raw event files are not part of the storage contract.

## License

Licensed under the [Apache License 2.0](./LICENSE).
