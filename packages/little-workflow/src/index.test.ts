import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as root from "./index.js";
import * as evalEntry from "./entries/eval.js";
import * as internals from "./entries/internals.js";
import * as lwirEntry from "./entries/lwir.js";
import * as scaffold from "./scaffold.js";

// The root is the app-author surface. Adding a value here is an API decision: update this list
// on purpose, and document the new export in docs/reference/api-reference.mdx.
const ROOT_VALUES = [
  "RunFailedError",
  "agentWorkflow",
  "asHarnessWorkflow",
  "createToolRegistry",
  "defineWorkflow",
  "dynamicWorkflows",
  "gradeRun",
  "isRunFailedError",
  "listRunGrades",
  "loadWorkflow",
  "localWorld",
  "model",
  "output",
  "readWorkflowVersion",
  "replayRun",
  "runOrchestration",
  "runWorkflow",
  "skill",
  "versionedHarnessWorkflow",
  "virtualWorld",
];

const LWIR_VALUES = ["LwirValidationError", "assertValidLwir", "registerWorkflowVersion", "validateLwir"];

describe("package entry points", () => {
  it("pins the root's runtime values", () => {
    expect(Object.keys(root).sort()).toEqual(ROOT_VALUES);
  });

  it("pins the /lwir runtime values", () => {
    expect(Object.keys(lwirEntry).sort()).toEqual(LWIR_VALUES);
  });

  it("gives every runtime value one import path", () => {
    const seen = new Map<string, string>();
    for (const [entry, values] of Object.entries({ root, evalEntry, lwirEntry, internals })) {
      for (const name of Object.keys(values)) {
        expect(seen.get(name), `${name} is exported from both ${seen.get(name)} and ${entry}`).toBeUndefined();
        seen.set(name, entry);
      }
    }
  });

  it("keeps test helpers and duplicate names off every public entry", () => {
    for (const values of [root, evalEntry, lwirEntry, internals, scaffold]) {
      expect(values).not.toHaveProperty("closeEventStoresForTest");
      expect(values).not.toHaveProperty("truncateEventLogForTest");
      expect(values).not.toHaveProperty("createLocalWorld");
    }
  });

  it("maps every subpath in package.json to an entry with types and default conditions", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      readonly exports: Record<string, string | { readonly types: string; readonly default: string }>;
    };
    expect(Object.keys(pkg.exports).sort()).toEqual([
      ".",
      "./eval",
      "./internals",
      "./lwir",
      "./package.json",
      "./scaffold",
    ]);
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      if (subpath === "./package.json") continue;
      expect(target).toEqual({
        types: expect.stringMatching(/^\.\/dist\/.+\.d\.ts$/u),
        default: expect.stringMatching(/^\.\/dist\/.+\.js$/u),
      });
    }
  });

  it("builds a local world from the root", () => {
    const world = root.localWorld({ dataDir: "tmp" });
    expect(world.kind).toBe("local-world");
    expect(world.dataDir).toBe("tmp");
  });
});
