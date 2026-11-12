import { asSchema, jsonSchema, tool, zodSchema, type LanguageModel, type ToolSet } from "ai";
import { z } from "zod";
import * as contract from "./harness-contract-v1/harness.js";
import { HarnessInputError } from "./errors.js";
import { isParkedToolOutput } from "./execution/park-resume.js";
import type { HarnessTurnLimits } from "./execution/turn-limits.js";

export type SnapshotDigest = contract.Digest;
export type SnapshotContent = contract.AdmittedHarnessContent;
export type SnapshotHookSlot = contract.HookSlot;
export type SnapshotParameters = Record<string, contract.Parameter>;
export type SnapshotEvent = {
  type:
    | "harness.snapshot.catalog_presented"
    | "harness.snapshot.file_opened"
    | "harness.snapshot.tool_effect"
    | "harness.snapshot.hook"
    | "harness.snapshot.warning";
  metadata: Record<string, contract.Json>;
};
export type SnapshotEmitter = (event: SnapshotEvent) => Promise<void>;
export type SnapshotHookDefinition = {
  implementationHash: SnapshotDigest;
  parameters: Record<string, contract.ParameterSpec>;
  defaults: SnapshotParameters;
  order: number;
  staticHints: string;
  /** Installed code only. The slot determines and bounds the accepted return value. */
  handler: (parameters: Readonly<SnapshotParameters>, input: unknown) => unknown | Promise<unknown>;
};
export type SnapshotToolDefinition = {
  tool: ToolSet[string];
  implementationHash: SnapshotDigest;
  effect: "read" | "write" | "unknown";
  parameterDescriptionPaths?: string[];
};
export type HarnessExecutionSnapshot = {
  format: 1;
  content: SnapshotContent;
  registryHash: SnapshotDigest;
  envelopeHash: SnapshotDigest;
  pins: Record<(typeof contract.EXECUTION_PIN_KEYS)[number], SnapshotDigest>;
  executionHash: SnapshotDigest;
  modelDecision: contract.Json;
  warnings: contract.HarnessWarning[];
};
export type SnapshotContext = {
  model: LanguageModel;
  modelDecision?: contract.Json;
  toolState: SnapshotDigest;
  memorySnapshot: SnapshotDigest;
};
type NativeTool = {
  definition: SnapshotToolDefinition;
  execute: ToolSet[string]["execute"];
  inputRef: ToolSet[string]["inputSchema"];
  outputRef: ToolSet[string]["outputSchema"];
  input: ReturnType<typeof asSchema>;
  output?: ReturnType<typeof asSchema>;
  schemaHash: SnapshotDigest;
  approvalRef: ToolSet[string]["needsApproval"];
  outputRendererRef: ToolSet[string]["toModelOutput"];
  typeRef: ToolSet[string]["type"];
};
const registryBrand = new WeakSet<object>();
const loadSchema = z
  .object({
    name: z.string().min(1).max(128),
    file: z.string().min(1).max(512).optional(),
  })
  .strict();
const loadDescription =
  "Open an available skill's SKILL.md or a listed reference from this turn's immutable bundle.";
function fail(message: string): never {
  throw new HarnessInputError(message);
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
// Zod attaches a non-enumerable Standard Schema adapter to its JSON Schema.
// Match the provider's JSON projection, without invoking getters or toJSON code.
function schemaData(value: unknown): contract.Json {
  if (Array.isArray(value)) return value.map(schemaData);
  if (value && typeof value === "object") {
    const out: Record<string, contract.Json> = {};
    for (const [key, property] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!property.enumerable && key === "~standard") continue;
      if (!property.enumerable || property.get || property.set)
        fail("Invalid canonical schema metadata.");
      Object.defineProperty(out, key, { value: schemaData(property.value), enumerable: true });
    }
    return contract.json(out);
  }
  return contract.json(value);
}
export function snapshotModelIdentity(model: LanguageModel): contract.Json {
  return typeof model === "string"
    ? { provider: "gateway", modelId: model }
    : { provider: model.provider, modelId: model.modelId };
}
export function assertSnapshotRegistry(value: unknown): asserts value is HarnessSnapshotRegistry {
  if (!value || typeof value !== "object" || !registryBrand.has(value))
    fail(
      "Execution snapshots require an owner-installed registry, not serialized functions or validators.",
    );
}

/** Install actual tools and fixed hook code. No candidate-supplied implementation is accepted. */
export async function createHarnessSnapshotRegistry(options: {
  tools: Record<string, SnapshotToolDefinition>;
  hooks?: Partial<Record<SnapshotHookSlot, Record<string, SnapshotHookDefinition>>>;
  envelope: Record<string, unknown>;
  runtime: SnapshotDigest;
  renderer?: SnapshotDigest;
  accounting?: SnapshotDigest;
  /** Installed ceilings. Function identity is covered by the owner runtime/accounting digest. */
  turnLimits?: HarnessTurnLimits;
  exactCounter?: (
    parts: Record<string, contract.StaticPart>,
  ) => contract.ExactAccounting | Promise<contract.ExactAccounting>;
  assertCurrent?: (snapshot: HarnessExecutionSnapshot) => void | Promise<void>;
}) {
  contract.hash(options.runtime, "/runtime");
  const exactCounter = options.exactCounter;
  const assertCurrent = options.assertCurrent;
  const ownerLimits = Object.freeze({ maxSteps: 20, ...options.turnLimits });
  if ((exactCounter || ownerLimits.price || ownerLimits.refusedBeforeEffect) && !options.accounting)
    fail("Custom counters or accounting callbacks require an installed accounting digest.");
  const numericLimits = Object.fromEntries(
    ["maxSteps", "maxCostUsd", "deadlineMs", "accounting"]
      .filter((key) => ownerLimits[key as keyof HarnessTurnLimits] !== undefined)
      .map((key) => [key, ownerLimits[key as keyof HarnessTurnLimits]]),
  );
  const definitions = { ...options.tools };
  if (Object.hasOwn(definitions, "load_skill"))
    fail("load_skill is reserved by the immutable snapshot loader.");
  definitions.load_skill = {
    tool: tool({
      description: loadDescription,
      inputSchema: zodSchema(loadSchema),
      execute: async (_input: z.infer<typeof loadSchema>): Promise<unknown> =>
        fail("Snapshot loader requires a turn context."),
    }),
    implementationHash: options.runtime,
    effect: "read",
    parameterDescriptionPaths: ["/properties/name", "/properties/file"],
  };
  const native = new Map<string, NativeTool>();
  const rawTools: Record<string, unknown> = {};
  for (const name of Object.keys(definitions).sort()) {
    const definition = definitions[name]!;
    contract.object(definition, `/tools/${name}`, [
      "tool",
      "implementationHash",
      "effect",
      "parameterDescriptionPaths",
    ]);
    if (typeof definition.tool.execute !== "function")
      fail(`Snapshot tool ${name} has no installed execute function.`);
    if (definition.tool.type === "provider")
      fail("Provider-executed tools are not qualified by the installed local tool fence.");
    if (
      definition.tool.onInputStart ||
      definition.tool.onInputDelta ||
      definition.tool.onInputAvailable
    )
      fail("Snapshot tools cannot install unfenced input lifecycle callbacks.");
    const input = asSchema(definition.tool.inputSchema);
    const output =
      definition.tool.outputSchema === undefined
        ? undefined
        : asSchema(definition.tool.outputSchema);
    if (typeof input.validate !== "function" || (output && typeof output.validate !== "function"))
      fail(`Snapshot tool ${name} needs real canonical validators.`);
    const inputSchema = schemaData(await input.jsonSchema);
    const outputSchema = output ? schemaData(await output.jsonSchema) : null;
    const schemaHash = contract.digest({ inputSchema, outputSchema });
    Object.freeze(input);
    if (output) Object.freeze(output);
    native.set(name, {
      definition,
      execute: definition.tool.execute,
      inputRef: definition.tool.inputSchema,
      outputRef: definition.tool.outputSchema,
      input,
      ...(output ? { output } : {}),
      schemaHash,
      approvalRef: definition.tool.needsApproval,
      outputRendererRef: definition.tool.toModelOutput,
      typeRef: definition.tool.type,
    });
    rawTools[name] = {
      implementationHash: definition.implementationHash,
      inputSchema,
      outputSchema,
      description: definition.tool.description ?? "",
      parameterDescriptionPaths: definition.parameterDescriptionPaths ?? [],
      effect: definition.effect,
    };
  }
  const handlers = new Map<string, SnapshotHookDefinition["handler"]>();
  const rawHooks: Record<string, unknown> = {};
  for (const slot of contract.HOOK_SLOTS) {
    const profiles: Record<string, unknown> = {};
    for (const [name, definition] of Object.entries(options.hooks?.[slot] ?? {})) {
      contract.object(definition, `/hooks/${slot}/${name}`, [
        "handler",
        "implementationHash",
        "parameters",
        "defaults",
        "order",
        "staticHints",
      ]);
      if (typeof definition.handler !== "function")
        fail(`Snapshot hook ${slot}/${name} has no installed handler.`);
      const { handler, ...descriptor } = definition;
      handlers.set(`${slot}/${name}`, handler);
      profiles[name] = descriptor;
    }
    if (Object.keys(profiles).length) rawHooks[slot] = profiles;
  }
  const descriptor = freeze(contract.json({ format: 1, tools: rawTools, hooks: rawHooks }));
  const registryHash = contract.normalizeHarnessRegistry(descriptor).registryHash;
  const withLoader = (value: unknown) => {
    if (value === undefined) return ["load_skill"];
    if (!Array.isArray(value)) fail("Owner capability lists must be arrays.");
    return value.includes("load_skill") ? [...value] : [...value, "load_skill"];
  };
  const envelope = freeze(
    contract.json({
      ...options.envelope,
      format: 1,
      registryHash,
      allowedTools: withLoader(options.envelope.allowedTools),
      requiredTools: withLoader(options.envelope.requiredTools),
      defaultTools: withLoader(options.envelope.defaultTools),
    }),
  );
  const owner = freeze(contract.harnessOwner(descriptor, envelope));
  const fixedPins = freeze({
    runtime: contract.digest({
      build: options.runtime,
      route: "inline-no-bash-json-v1",
      limits: numericLimits,
    }),
    renderer:
      options.renderer ??
      contract.digest({ renderer: "snapshot-inline-no-bash-v1", runtime: options.runtime }),
    accounting:
      options.accounting ??
      contract.digest({ accounting: "utf8-static-v1", runtime: options.runtime }),
  });
  for (const [key, value] of Object.entries(fixedPins)) contract.hash(value, `/pins/${key}`);
  const refine = async (content: unknown) => {
    if (!exactCounter) return undefined;
    const parts = contract.resolveHarnessContent(content, owner, true).parts;
    try {
      return await exactCounter(parts);
    } catch {
      return undefined;
    }
  };
  const read = (input: unknown): HarnessExecutionSnapshot => {
    const raw = contract.object(contract.json(input), "/snapshot", [
      "format",
      "content",
      "registryHash",
      "envelopeHash",
      "pins",
      "executionHash",
      "modelDecision",
      "warnings",
    ]);
    if (raw.format !== 1) fail("Unsupported execution snapshot format.");
    if (!Array.isArray(raw.warnings) || raw.warnings.length > 128)
      fail("Invalid snapshot warnings.");
    for (const warning of raw.warnings) {
      const value = contract.object(warning, "/warnings", ["event", "path", "reason"]);
      if (value.event !== "harness_selector_warning") fail("Invalid snapshot warning event.");
      contract.text(value.path, "/warnings/path", 1024);
      contract.text(value.reason, "/warnings/reason", 128);
    }
    return raw as unknown as HarnessExecutionSnapshot;
  };
  const api = {
    descriptor,
    envelope,
    registryHash: owner.registryHash,
    envelopeHash: owner.envelopeHash,
    fixedPins,
    ownerLimits,
    current: async (snapshot: HarnessExecutionSnapshot) => {
      await assertCurrent?.(snapshot);
    },
    requiredTools: owner.envelope.requiredTools,
    admit: (request: unknown) => contract.admitHarnessContent(request, descriptor, envelope),
    serve: (content: unknown) => contract.serveHarnessContent(content, descriptor, envelope),
    validate: (content: unknown) => contract.validateHarnessContent(content, descriptor, envelope),
    async snapshot(
      content: unknown,
      context: SnapshotContext,
      warnings: contract.HarnessWarning[] = [],
    ): Promise<HarnessExecutionSnapshot> {
      const modelDecision = context.modelDecision ?? null;
      const pins = {
        ...fixedPins,
        model: contract.digest({
          model: snapshotModelIdentity(context.model),
          decision: modelDecision,
        }),
        toolState: contract.hash(context.toolState, "/pins/toolState"),
        memorySnapshot: contract.hash(context.memorySnapshot, "/pins/memorySnapshot"),
      };
      const refinement = await refine(content);
      const normalized = contract.validateHarnessContent(content, descriptor, envelope, refinement);
      const identity = contract.harnessExecutionIdentity(
        normalized.content,
        descriptor,
        envelope,
        pins,
        refinement,
      );
      return freeze(
        read({
          format: 1,
          content: normalized.content,
          registryHash: owner.registryHash,
          envelopeHash: owner.envelopeHash,
          pins,
          executionHash: identity.executionHash,
          modelDecision,
          warnings,
        }),
      );
    },
    async verify(input: unknown, model: LanguageModel) {
      const snapshot = read(input);
      if (
        snapshot.registryHash !== owner.registryHash ||
        snapshot.envelopeHash !== owner.envelopeHash
      )
        fail("The pinned snapshot installation or owner policy is unavailable.");
      for (const key of ["runtime", "renderer", "accounting"] as const)
        if (snapshot.pins?.[key] !== fixedPins[key]) fail(`Snapshot ${key} pin mismatch.`);
      const expectedModel = contract.digest({
        model: snapshotModelIdentity(model),
        decision: snapshot.modelDecision,
      });
      if (snapshot.pins.model !== expectedModel) fail("Snapshot model pin mismatch.");
      const refinement = await refine(snapshot.content);
      const identity = contract.harnessExecutionIdentity(
        snapshot.content,
        descriptor,
        envelope,
        snapshot.pins,
        refinement,
      );
      if (identity.executionHash !== snapshot.executionHash)
        fail("Snapshot execution identity mismatch.");
      await assertCurrent?.(snapshot);
      return {
        snapshot: freeze(snapshot),
        ...contract.validateHarnessContent(snapshot.content, descriptor, envelope, refinement),
      };
    },
    async assertTools(tools: ToolSet) {
      for (const [name, registered] of native) {
        if (name === "load_skill") continue;
        const actual = tools[name];
        if (
          !actual ||
          actual.execute !== registered.execute ||
          actual.inputSchema !== registered.inputRef ||
          actual.outputSchema !== registered.outputRef ||
          actual.needsApproval !== registered.approvalRef ||
          actual.toModelOutput !== registered.outputRendererRef ||
          actual.type !== registered.typeRef ||
          actual.onInputStart ||
          actual.onInputDelta ||
          actual.onInputAvailable
        )
          fail(`Installed snapshot tool ${name} changed or is missing.`);
        const inputSchema = schemaData(await asSchema(actual.inputSchema).jsonSchema);
        const outputSchema =
          actual.outputSchema === undefined
            ? null
            : schemaData(await asSchema(actual.outputSchema).jsonSchema);
        if (contract.digest({ inputSchema, outputSchema }) !== registered.schemaHash)
          fail(`Canonical validator/schema for ${name} changed.`);
      }
    },
    async hook(
      snapshot: HarnessExecutionSnapshot,
      slot: SnapshotHookSlot,
      input: unknown,
      emit: SnapshotEmitter,
      validate?: (output: unknown) => unknown,
    ) {
      const selection = snapshot.content.hooks[slot];
      if (!selection) return undefined;
      const registered = owner.registry.hooks[slot]?.[selection.profile];
      const handler = handlers.get(`${slot}/${selection.profile}`);
      if (!registered || !handler)
        fail(`Installed hook ${slot}/${selection.profile} is unavailable.`);
      const parameters = freeze(
        contract.hookParameters(registered.parameters, selection.parameters, `/hooks/${slot}`),
      );
      try {
        await assertCurrent?.(snapshot);
        const output = await handler(parameters, freeze(contract.json(input)));
        const checked = validate ? validate(output) : output;
        await emit({
          type: "harness.snapshot.hook",
          metadata: {
            executionHash: snapshot.executionHash,
            slot,
            profile: selection.profile,
            implementationHash: registered.implementationHash,
            parameterHash: contract.digest(parameters),
            outcome: "applied",
          },
        });
        return checked;
      } catch (error) {
        await emit({
          type: "harness.snapshot.hook",
          metadata: {
            executionHash: snapshot.executionHash,
            slot,
            profile: selection.profile,
            outcome: "denied",
          },
        });
        throw error;
      }
    },
    render(snapshot: HarnessExecutionSnapshot) {
      const data = contract.resolveHarnessContent(snapshot.content, owner, true);
      return Object.values(data.parts)
        .filter((part) => part.category !== "tools")
        .map((part) => part.text)
        .filter(Boolean)
        .join("\n\n");
    },
    async tools(
      snapshot: HarnessExecutionSnapshot,
      emit: SnapshotEmitter,
      tools: ToolSet,
    ): Promise<ToolSet> {
      await api.assertTools(tools);
      const out: ToolSet = {};
      for (const name of owner.envelope.allowedTools) {
        const selection = snapshot.content.tools[name]!;
        if (!selection.enabled) continue;
        const registered = native.get(name)!;
        const canonical = owner.registry.tools[name]!;
        const display = contract.overlayParameterDescriptions(
          canonical.inputSchema,
          selection.parameterDescriptions,
          canonical.parameterDescriptionPaths,
        );
        const original = name === "load_skill" ? snapshotLoader(snapshot, emit) : tools[name]!;
        const receipts = new Map<unknown, string>();
        const outputReceipts = new Map<unknown, { hash: string; count: number }>();
        const checkedInput = async (input: unknown) => {
          const result = await registered.input.validate!(input);
          if (result.success) receipts.set(result.value, contract.digest(result.value));
          else
            await emit({
              type: "harness.snapshot.tool_effect",
              metadata: {
                executionHash: snapshot.executionHash,
                tool: name,
                outcome: "denied",
                stage: "input",
              },
            });
          return result;
        };
        // AI SDK retains canonical validation. Display metadata never replaces its real validator.
        out[name] = {
          ...original,
          description: selection.description,
          inputSchema: jsonSchema(display.schema, { validate: checkedInput }),
          ...(registered.output
            ? {
                outputSchema: jsonSchema(canonical.outputSchema as Record<string, unknown>, {
                  validate: async (value: unknown) => {
                    const receipt = outputReceipts.get(value);
                    if (receipt && receipt.hash === contract.digest(value)) {
                      if (--receipt.count === 0) outputReceipts.delete(value);
                      return { success: true, value };
                    }
                    return registered.output!.validate!(value);
                  },
                }),
              }
            : {}),
          execute: async (
            input: unknown,
            context: Parameters<NonNullable<ToolSet[string]["execute"]>>[1],
          ) => {
            const metadata = {
              executionHash: snapshot.executionHash,
              registryHash: owner.registryHash,
              envelopeHash: owner.envelopeHash,
              tool: name,
              toolCallId: context.toolCallId,
              implementationHash: canonical.implementationHash,
              schemaHash: canonical.schemaHash,
              effect: canonical.effect,
            };
            let dispatched = false;
            await emit({
              type: "harness.snapshot.tool_effect",
              metadata: { ...metadata, outcome: "attempted" },
            });
            try {
              await api.current(snapshot);
              await api.assertTools(tools);
              const stamp = contract.digest(input);
              if (receipts.get(input) !== stamp) {
                const checked = await checkedInput(input);
                if (!checked.success) throw checked.error;
                input = checked.value;
              }
              receipts.delete(input);
              dispatched = true;
              const execute = name === "load_skill" ? original.execute! : registered.execute!;
              const result = await execute(input, context);
              // Streaming tool outputs need a separate consumption receipt. Never certify one here.
              if (result && typeof result === "object" && Symbol.asyncIterator in result)
                fail(
                  "Snapshot tools currently require a single JSON output, not an async iterable.",
                );
              contract.json(result);
              if (registered.output) {
                const checked = await registered.output.validate!(result);
                if (!checked.success) throw checked.error;
                // Keep the SDK's output validator authoritative; transformed outputs are not
                // certified by this first slice because a second parse may change them again.
                if (contract.digest(checked.value) !== contract.digest(result))
                  fail("Snapshot output validators must preserve the JSON output.");
                const receipt = outputReceipts.get(result);
                outputReceipts.set(result, {
                  hash: contract.digest(result),
                  count: (receipt?.count ?? 0) + 1,
                });
              }
              await emit({
                type: "harness.snapshot.tool_effect",
                metadata: {
                  ...metadata,
                  outcome: isParkedToolOutput(result) ? "uncertain" : "completed",
                  inputHash: contract.digest(input),
                  outputHash: contract.digest(result),
                },
              });
              return result;
            } catch (error) {
              await emit({
                type: "harness.snapshot.tool_effect",
                metadata: { ...metadata, outcome: dispatched ? "uncertain" : "denied" },
              });
              throw error;
            }
          },
        } as ToolSet[string];
      }
      return out;
    },
    skills(snapshot: HarnessExecutionSnapshot) {
      return contract.parseHarnessFiles(snapshot.content.files).skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        harnessDir: `.agents/skills/snapshots/${snapshot.executionHash.slice(7)}/${skill.name}`,
        files: Object.fromEntries(
          Object.entries(snapshot.content.files)
            .filter(([path]) => path.startsWith(`skills/${skill.name}/`))
            .map(([path, value]) => [
              path.slice(`skills/${skill.name}/`.length),
              new TextEncoder().encode(value),
            ]),
        ),
      }));
    },
  };
  registryBrand.add(api);
  return Object.freeze(api);
}
export type HarnessSnapshotRegistry = Awaited<ReturnType<typeof createHarnessSnapshotRegistry>>;

function snapshotLoader(
  snapshot: HarnessExecutionSnapshot,
  emit: SnapshotEmitter,
): ToolSet[string] {
  const parsed = contract.parseHarnessFiles(snapshot.content.files);
  return tool({
    description: loadDescription,
    inputSchema: zodSchema(loadSchema),
    execute: async ({ name, file }) => {
      const skill = parsed.skills.find((s) => s.name === name);
      if (!skill) fail("Unknown snapshot skill.");
      let path = file ?? skill.path;
      if (!Object.hasOwn(parsed.files, path)) {
        const parts = skill.path.split("/").slice(0, -1);
        for (const segment of path.split("/")) {
          if (segment === "..") parts.pop();
          else if (segment !== ".") parts.push(segment);
        }
        path = parts.join("/");
      }
      const content = Object.hasOwn(parsed.files, path) ? parsed.files[path] : undefined;
      if (content === undefined) fail("Unknown snapshot file.");
      const manifest = parsed.manifest.find((f) => f.path === path)!;
      await emit({
        type: "harness.snapshot.file_opened",
        metadata: {
          executionHash: snapshot.executionHash,
          skill: name,
          path,
          hash: manifest.hash,
          bytes: manifest.bytes,
          complete: true,
          entry: path === skill.path,
        },
      });
      return {
        name,
        file: path,
        content,
        otherFiles: parsed.manifest.map((f) => f.path).filter((p) => p !== path),
      };
    },
  });
}
