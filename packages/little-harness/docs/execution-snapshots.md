# Execution snapshots

The source branch adds `createHarnessSnapshotRegistry()` and the per-call
`executionSnapshot` option. This is an opt-in, local SDK seam; it does not enable
control-plane admission, promotion, deployment, or candidate executable code.
Existing calls without snapshots retain their current behavior.

Install actual AI SDK tools with canonical validators and fixed hook handlers in
code. The registry derives schema hashes from those validators, binds an owner
capability envelope, and admits JSON-only format-1 content. Candidate data may
select allowed tools and registered hook profiles, edit descriptions, and supply
bounded Markdown/data files. It cannot supply functions, validators or trusted
hash stamps. Use `ownerRules` for protected system text. `runtime` and
`accounting` identify owner-installed code; they are owner declarations, not
cryptographic attestation of arbitrary JavaScript closures. Numeric owner ceilings
are additionally bound into the runtime pin. Pass the same ceilings in
`createHarness`, or let the registry supply them.

```ts
import { createHarness, createHarnessSnapshotRegistry, generateHarness, localHost } from "@little-stack/harness";

const registry = await createHarnessSnapshotRegistry({
  runtime: INSTALLED_BUILD_SHA256, // "sha256:" plus 64 lowercase hex characters
  tools: {
    lookup_order: { tool: lookup_order, implementationHash: LOOKUP_BUILD_SHA256, effect: "read" },
  },
  turnLimits: { maxSteps: 8 },
  envelope: {
    allowedTools: ["lookup_order"], requiredTools: ["lookup_order"],
    defaultTools: ["lookup_order"], ownerRules: "Refunds require authorization.",
  },
  assertCurrent: async (snapshot) => checkCurrentPermissionAndInstallation(snapshot),
});
const admitted = registry.admit({ harnessFormat: 1, system: "Help with returns.", files: {} }).content;
const executionSnapshot = await registry.snapshot(admitted, {
  model, toolState: TOOL_STATE_SHA256, memorySnapshot: EMPTY_MEMORY_SHA256,
});
const harness = createHarness({
  host: localHost({ dataDir: ".little-harness" }), model,
  tools: { lookup_order }, executionRegistry: registry, runtime: { bash: false },
});
await generateHarness({ harness, session: "returns", prompt: "Help", executionSnapshot });
```

The first qualified route requires a concrete model and `bash:false`. Inline
skill files use a mandatory immutable `load_skill`; root references open from
exact pinned bundle bytes, without arbitrary filesystem reads or truncation.
Generate and stream get independent per-turn tools, descriptions, files and hook
parameters. Selected `prepareStep` and `compaction` handlers may prune an ordered
subset of existing messages and restrict optional tools; they cannot change the
model or protected system text. `stopWhen` adds a stop; `turnLimits` can only
lower installed numeric ceilings, preserving the installed accounting callbacks.
Per-call loop overrides and tool subsets are refused; put those decisions in the
admitted content/registered hooks before calculating the execution hash.

MCP, shell execution, workflows, agents, checkpoints, mutable memory, external
skill sources and typed-input routes are explicitly unqualified and refused.
Code tools can use the existing durable `ask`/answer flow with
`humanInput:{tool:false}`; the person's answer and existing invocation guards are
still required. The model-facing `ask_person` route remains unqualified. Snapshot
tools currently require one JSON output; async iterable output and transforming
output validators cannot produce a completed receipt.

The saved logical-turn pin retains the exact snapshot across a promotion or a
client/host restart. A missing installation, changed state identity, modified pin,
or current permission/deletion/revocation veto fails closed. Supply current
checks through `assertCurrent` and the existing `beforeInvocation`; the snapshot
is not a durable grant. A successful owner hook runs only after its output is
checked. Catalog/file/tool/hook/warning events bind the execution identity and
hashes, never file bodies or argument/output bodies in their new metadata. A
parked tool has an uncertain effect receipt until it actually finishes. Existing
trace content and redaction options continue to govern the normal model/tool
events. Replayed effects are not dispatched again by this seam.

The portable contract is mechanically prepared from the approved standalone
artifact at source `3688a27d865e765e80bbd2807fb650d3974d6c0c`, manifest SHA-256
`99158a3a8fafb0c48de7c8ebb9d9154d4214082bbe7b1f4171e81b382198dc55`.
It contains no LittleDB runtime/service import. Build/typecheck/test verify the
reviewable vendored manifest and every text payload hash before generation; changed generated files are
refused rather than silently overwritten. Both packages run the same conformance
vectors. Updating the pin requires an explicit reviewed artifact update.
