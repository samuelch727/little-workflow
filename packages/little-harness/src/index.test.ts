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
  mountedResultPath,
  modelFacingWorkflowRunStatus,
  projectDir,
  skill,
  streamHarness,
  createWorkflowInspectionTools,
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
    expect(mountedResultPath).toBeTypeOf("function");
    expect(modelFacingWorkflowRunStatus).toBeTypeOf("function");
    expect(createWorkflowInspectionTools).toBeTypeOf("function");
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

  it("declares the connectors subpath export without adding connector APIs to the root", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { exports?: Record<string, unknown> };
    const connectors = await import("./connectors/index.js");

    expect(packageJson.exports).toHaveProperty("./connectors");
    expect(connectors.chatSdkConnector).toBeTypeOf("function");
    expect(connectors.webRichConnector).toBeTypeOf("function");
    expect(connectors.discoverConnectors).toBeTypeOf("function");
    expect(connectors.loadChatSdkConnector).toBeTypeOf("function");
    expect(connectors.loadWebRichConnector).toBeTypeOf("function");
    expect(rootExports).not.toHaveProperty("chatSdkConnector");
    expect(rootExports).not.toHaveProperty("loadChatSdkConnector");
    expect(rootExports).not.toHaveProperty("webRichConnector");
    expect(rootExports).not.toHaveProperty("loadWebRichConnector");
  });

  it("declares a connector runtime subpath without discovery helpers", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { exports?: Record<string, unknown> };
    const runtime = await import("./connectors/runtime.js");

    expect(packageJson.exports).toHaveProperty("./connectors/runtime");
    expect(runtime.chatSdkConnector).toBeTypeOf("function");
    expect(runtime.webRichConnector).toBeTypeOf("function");
    expect(runtime.loadChatSdkConnector).toBeTypeOf("function");
    expect(runtime.loadWebRichConnector).toBeTypeOf("function");
    expect(runtime).not.toHaveProperty("discoverConnectors");
    expect(runtime).not.toHaveProperty("loadConnectorDescriptor");
  });

  it("declares workspace and connector discovery subpaths for lazy server imports", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { exports?: Record<string, unknown> };
    const workspace = await import("./workspace/index.js");
    const discovery = await import("./connectors/discovery.js");

    expect(packageJson.exports).toHaveProperty("./workspace");
    expect(packageJson.exports).toHaveProperty("./connectors/discovery");
    expect(workspace.loadHarness).toBeTypeOf("function");
    expect(discovery.loadConnectorDescriptor).toBeTypeOf("function");
  });

  it("declares the execution subpath export for server bundles that need streaming helpers only", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { exports?: Record<string, unknown> };
    const execution = await import("./execution/index.js");

    expect(packageJson.exports).toHaveProperty("./execution");
    expect(execution.streamHarness).toBeTypeOf("function");
    expect(execution.generateHarness).toBeTypeOf("function");
  });
});
