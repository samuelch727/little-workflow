import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createHarness,
  customDir,
  generateHarness,
  inputType,
  justBashRuntime,
  localDir,
  localHost,
  memory,
  projectDir,
  skill,
  streamHarness,
} from "./index.js";
import * as rootExports from "./index.js";

describe("public exports", () => {
  it("exports the documented alpha helpers", () => {
    expect(createHarness).toBeTypeOf("function");
    expect(generateHarness).toBeTypeOf("function");
    expect(streamHarness).toBeTypeOf("function");
    expect(localHost).toBeTypeOf("function");
    expect(localDir).toBeTypeOf("function");
    expect(projectDir).toBeTypeOf("function");
    expect(customDir).toBeTypeOf("function");
    expect(skill).toBeTypeOf("function");
    expect(inputType).toBeTypeOf("function");
    expect(memory).toBeTypeOf("function");
    expect(justBashRuntime).toBeTypeOf("function");
    expect(justBashRuntime({ network: true })).toEqual({ network: true });
  });

  it("keeps Workflow protocol constants on the workflow-harness subpath", () => {
    expect(rootExports).not.toHaveProperty("WORKFLOW_HARNESS_ID");
    expect(rootExports).not.toHaveProperty("workflowDurableHarnessEventTypes");
    expect(rootExports).not.toHaveProperty("isWorkflowDurableHarnessEventType");
  });

  it("keeps memory implementation helpers off the package root", () => {
    expect(rootExports).not.toHaveProperty("resolveHarnessMemory");
    expect(rootExports).not.toHaveProperty("buildMemorySystemContext");
    expect(rootExports).not.toHaveProperty("DEFAULT_MEMORY_HARNESS_DIR");
  });

  it("declares the Workflow harness adapter subpath export", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { exports?: Record<string, unknown> };
    const workflowHarness = await import("./workflow-harness/index.js");

    expect(packageJson.exports).toHaveProperty("./workflow-harness");
    expect(workflowHarness.createWorkflowRuntime).toBeTypeOf("function");
  });
});
