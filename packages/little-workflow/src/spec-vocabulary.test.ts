import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const specPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../spec.md",
);
const contextPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../CONTEXT.md",
);
const demoRealPlannerPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../apps/demo-real-planner/run.mjs",
);
const demoOrchestratorFanoutPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../apps/demo-orchestrator-fanout/run.mjs",
);
const toolRegistryPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "./tool-registry.ts",
);

const alphaStepTypes = [
  "ai.generate",
  "tool.call",
  "code.run",
  "parallel",
  "decision",
] as const;

const legacyStepTypes = [
  "ai.structured",
  "tool",
  "code.ts",
  "code.*",
] as const;

const legacyExecutableStepTypes = [
  "foreach",
  "choice",
] as const;

const legacyModelSlotIds = [
  "planner.reasoning",
  "worker.fast",
  "worker.reasoning",
  "worker.verifier",
] as const;

const legacyModelPolicyKeys = [
  "defaultPlannerModelSlot",
  "defaultWorkerModelSlot",
] as const;

const deprecatedAlphaTerms = [
  "qualityTier",
  "RuntimeAiAdapter",
  "RuntimeCodeRunner",
  "planner?: PlannerAdapter",
  "ai?: RuntimeAiAdapter",
  "codeRunner?: RuntimeCodeRunner",
] as const;

function quotedValues(source: string): string[] {
  return [...source.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function capabilityManifestStepTypes(spec: string): string[] {
  const match = spec.match(
    /"capabilityManifest":\s*\{[\s\S]*?"stepTypes":\s*\[([\s\S]*?)\]/,
  );
  expect(match?.[1]).toBeDefined();
  return quotedValues(match?.[1] ?? "");
}

function mvpAlphaStepTypeSentence(spec: string): string {
  const match = spec.match(/^5\. Step types: ([^\n]+)$/m);
  expect(match?.[1]).toBeDefined();
  return match?.[1] ?? "";
}

function stepBaseSemanticsSentence(spec: string): string {
  const match = spec.match(
    /^- `uses` is always the step type or capability family, such as ([^\n]+)$/m,
  );
  expect(match?.[1]).toBeDefined();
  return match?.[1] ?? "";
}

function customStepTypeFallbackSentence(spec: string): string {
  const match = spec.match(
    /^Custom step types are powerful and should be rare\.[^\n]+$/m,
  );
  expect(match?.[0]).toBeDefined();
  return match?.[0] ?? "";
}

function validationParallelRule(spec: string): string {
  const match = spec.match(/^- `parallel` has max item and concurrency limits$/m);
  expect(match?.[0]).toBeDefined();
  return match?.[0] ?? "";
}

function policyParallelRule(spec: string): string {
  const match = spec.match(/^Deny parallel concurrency > 1000 unless admin approved\.$/m);
  expect(match?.[0]).toBeDefined();
  return match?.[0] ?? "";
}

function fanOutParallelPseudocode(spec: string): string {
  const match = spec.match(/^parallel candidates\[0\.\.999999\]$/m);
  expect(match?.[0]).toBeDefined();
  return match?.[0] ?? "";
}

function telemetryParallelSpan(spec: string): string {
  const match = spec.match(/^- `little_workflow\.parallel\.shard`$/m);
  expect(match?.[0]).toBeDefined();
  return match?.[0] ?? "";
}

function stepTypeHeadings(spec: string): string[] {
  return [...spec.matchAll(/^### \d+(?:\.\d+)* `([^`]+)`/gm)].map(
    (match) => match[1],
  );
}

function jsonUsesValues(spec: string): string[] {
  return [...spec.matchAll(/"uses":\s*"([^"]+)"/g)].map(
    (match) => match[1],
  );
}

function jsonModelValues(spec: string): string[] {
  return [...spec.matchAll(/"model":\s*"([^"]+)"/g)].map(
    (match) => match[1],
  );
}

function quotedBareLegacyModelRefs(spec: string): string[] {
  return [...spec.matchAll(/"(planner|worker)\.[^"]*"/g)].map(
    (match) => match[0],
  );
}

describe.skipIf(!existsSync(specPath))("spec step-type vocabulary", () => {
  it("uses current alpha runtime step-type names in authoritative sections", async () => {
    const spec = await readFile(specPath, "utf8");
    const manifestStepTypes = capabilityManifestStepTypes(spec);
    const mvpSentence = mvpAlphaStepTypeSentence(spec);
    const stepBaseSentence = stepBaseSemanticsSentence(spec);
    const customStepSentence = customStepTypeFallbackSentence(spec);
    const validationRule = validationParallelRule(spec);
    const policyRule = policyParallelRule(spec);
    const fanOutPseudocode = fanOutParallelPseudocode(spec);
    const telemetrySpan = telemetryParallelSpan(spec);

    expect(manifestStepTypes).toEqual([...alphaStepTypes]);
    for (const stepType of alphaStepTypes) {
      expect(mvpSentence).toContain(`\`${stepType}\``);
    }
    for (const legacyStepType of legacyStepTypes) {
      expect(manifestStepTypes).not.toContain(legacyStepType);
      expect(mvpSentence).not.toContain(`\`${legacyStepType}\``);
    }
    for (const legacyStepType of legacyExecutableStepTypes) {
      expect(stepBaseSentence).not.toContain(`\`${legacyStepType}\``);
    }
    expect(customStepSentence).toContain("`parallel`");
    expect(customStepSentence).not.toContain("`foreach`");
    expect(validationRule).toContain("`parallel`");
    expect(validationRule).not.toContain("`foreach`");
    expect(policyRule).toContain("parallel");
    expect(policyRule).not.toContain("foreach");
    expect(fanOutPseudocode).toContain("parallel");
    expect(fanOutPseudocode).not.toContain("foreach");
    expect(telemetrySpan).toContain("parallel");
    expect(telemetrySpan).not.toContain("foreach");
  });

  it("uses current alpha runtime step-type names in headings and executable examples", async () => {
    const spec = await readFile(specPath, "utf8");
    const headings = stepTypeHeadings(spec);
    const usesValues = jsonUsesValues(spec);

    for (const stepType of alphaStepTypes) {
      expect(usesValues).toContain(stepType);
    }
    for (const legacyStepType of legacyStepTypes) {
      expect(headings).not.toContain(legacyStepType);
      expect(usesValues).not.toContain(legacyStepType);
    }
    for (const legacyStepType of legacyExecutableStepTypes) {
      expect(usesValues).not.toContain(legacyStepType);
    }
  });
});

describe.skipIf(!existsSync(specPath))("spec model vocabulary", () => {
  it("does not use pre-alpha model slot names or deprecated default model keys", async () => {
    const spec = await readFile(specPath, "utf8");

    for (const legacyToken of legacyModelSlotIds) {
      const escaped = legacyToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`(?<![\\w.])${escaped}(?![\\w.])`, "u");
      expect(pattern.test(spec)).toBe(false);
    }
    for (const legacyKey of legacyModelPolicyKeys) {
      const escaped = legacyKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`"${escaped}"\\s*:`, "u");
      expect(pattern.test(spec)).toBe(false);
    }
    expect(spec).toContain("model.planner");
    expect(spec).toContain("model.worker");
  });

  it("uses model.* slot ids for JSON step model references", async () => {
    const spec = await readFile(specPath, "utf8");
    const modelValues = jsonModelValues(spec);

    expect(modelValues.length).toBeGreaterThan(0);
    for (const modelValue of modelValues) {
      expect(modelValue.startsWith("model.")).toBe(true);
    }
  });

  it("does not contain quoted bare planner.* or worker.* model refs in JSON snippets", async () => {
    const spec = await readFile(specPath, "utf8");
    expect(quotedBareLegacyModelRefs(spec)).toEqual([]);
  });

  it("does not document deprecated alpha model/runtime adapter terms", async () => {
    const spec = await readFile(specPath, "utf8");

    for (const term of deprecatedAlphaTerms) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`(?<![\\w.])${escaped}(?![\\w.])`, "u");
      expect(pattern.test(spec)).toBe(false);
    }
  });

  it("does not use the deprecated planner:model(...) authoring shape", async () => {
    const spec = await readFile(specPath, "utf8");
    const pattern = /(?<![\w$])planner\s*:\s*model\s*\(/u;
    expect(pattern.test(spec)).toBe(false);
  });
});

describe.skipIf(!existsSync(contextPath))("context vocabulary", () => {
  it("uses current alpha runtime step-type names", async () => {
    const context = await readFile(contextPath, "utf8");

    for (const stepType of ["ai.generate", "tool.call", "code.run", "parallel"] as const) {
      expect(context).toContain(`\`${stepType}\``);
    }
    for (const legacyStepType of ["ai.structured", "tool", "code.ts"] as const) {
      expect(context).not.toContain(`\`${legacyStepType}\``);
    }
  });

  it("uses harness-based planner terminology, not legacy planner adapter wording", async () => {
    const context = await readFile(contextPath, "utf8");
    expect(context).toContain("workflow.planner.harness");
    expect(context).not.toContain("PlannerAdapter.draft()");
    expect(context).not.toContain("PlannerAdapter");
    expect(context).not.toContain("Declared on `WorkflowDefinition.planner` as a `ModelSlot`");
  });
});

describe("demo tool-registry usage", () => {
  it("uses AI SDK tool() registration shape in demos (no imperative registry.register)", async () => {
    const realPlanner = await readFile(demoRealPlannerPath, "utf8");
    const orchestratorFanout = await readFile(demoOrchestratorFanoutPath, "utf8");

    expect(realPlanner).not.toContain(".register(");
    expect(orchestratorFanout).not.toContain(".register(");
    expect(realPlanner.includes("tool(") || realPlanner.includes("ai.tool(")).toBe(true);
    expect(orchestratorFanout.includes("tool(") || orchestratorFanout.includes("ai.tool(")).toBe(true);
  });
});

describe("tool-registry vocabulary", () => {
  it("does not expose legacy descriptor/handler API surface", async () => {
    const source = await readFile(toolRegistryPath, "utf8");

    expect(source).not.toContain("export type ToolDescriptor");
    expect(source).not.toContain("export type RegisteredTool");
    expect(source).not.toContain("descriptor(name:");
    expect(source).not.toContain("handler(name:");
  });
});
