import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as rootExports from "./index.js";
import * as hostExports from "./host.js";
import * as internalsExports from "./internals.js";
import * as sandboxExports from "./sandbox.js";

describe("public exports", () => {
  it("exports exactly the documented app API from the root", () => {
    // Every name here is an alpha promise. Add to the root only what an app needs to build
    // and run an agent; everything else belongs on /sandbox, /host, /events or /internals.
    expect(Object.keys(rootExports).sort()).toEqual([
      "HarnessConcurrencyError",
      "HarnessInputError",
      "HarnessPathError",
      "HarnessPersistenceError",
      "HarnessTerminalStageError",
      "HarnessTurnLimitError",
      "LittleHarnessError",
      "aggregateLocalOutcomes",
      "aggregateOutcomes",
      "answerInputRequest",
      "createHarness",
      "createHarnessOutcomeReporter",
      "createHarnessSnapshotRegistry",
      "customDir",
      "defineSchedule",
      "foldOutcomeReports",
      "generateHarness",
      "harnessToolContext",
      "inputType",
      "justBashSandbox",
      "listInputRequests",
      "loadHarness",
      "loadWorkspace",
      "localDir",
      "localHost",
      "memory",
      "once",
      "projectDir",
      "reportHarnessOutcome",
      "resumeParked",
      "skill",
      "streamHarness",
      "subprocessSandbox",
      "tieredSandbox",
      "tryHarnessToolContext",
      "virtualHost",
    ]);
    expect(rootExports.justBashSandbox()).toBeTypeOf("function");
  });

  it("moves sandbox, host and Workflow/Compute plumbing to their subpaths", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { exports?: Record<string, unknown> };
    for (const subpath of ["./sandbox", "./host", "./internals"]) {
      expect(packageJson.exports).toHaveProperty(subpath);
    }
    expect(sandboxExports.createShellRuntime).toBeTypeOf("function");
    expect(sandboxExports.classifyCommand).toBeTypeOf("function");
    expect(hostExports.createInMemoryOrchestrationServices).toBeTypeOf("function");
    expect(hostExports.sessionKeyToPathKey).toBeTypeOf("function");
    expect(internalsExports.stableHash).toBeTypeOf("function");
    expect(internalsExports.justBashNodeExport).toBeTypeOf("function");
    expect(internalsExports.SubtreeFs).toBeTypeOf("function");
    expect(internalsExports.resolveHarnessWorkflowTools).toBeTypeOf("function");
    const events = await import("./events/occurrence.js");
    expect(events.HARNESS_EVENT_TYPES).toBeDefined();
    expect(events.isHarnessEventType).toBeTypeOf("function");
    // One import path per symbol.
    const homes = [rootExports, sandboxExports, hostExports, internalsExports, events];
    const seen = new Map<string, number>();
    homes.forEach((home, index) => {
      for (const name of Object.keys(home)) {
        expect(seen.get(name), `${name} is exported from two entry points`).toBeUndefined();
        seen.set(name, index);
      }
    });
  });

  it("gives each symbol one home: session-log, event and Agent Group plumbing stay on their subpaths", () => {
    for (const name of [
      "remoteSessionLog",
      "fileSessionLog",
      "startSessionLogServer",
      "canonicalHarnessEventRequestDigest",
      "HarnessAppendIdempotencyConflictError",
      "createCheckpointTools",
      "HARNESS_CHECKPOINT_TOOL_NAMES",
      "HarnessAgentGroupCursorError",
      "HARNESS_AGENT_GROUPS_PROTOCOL_VERSION",
    ]) {
      expect(rootExports).not.toHaveProperty(name);
    }
  });

  it("has no pre-rename aliases", () => {
    // Spelled in pieces so the repo's rename codemod leaves the old names alone.
    for (const name of [
      "justBash" + "Runtime",
      "createJustBash" + "Runtime",
      "tieredExecution" + "Environment",
      "createFile" + "SessionLog",
      "createInMemory" + "SessionLog",
    ]) {
      expect(rootExports).not.toHaveProperty(name);
    }
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

  it("declares connector discovery as a subpath and keeps loading and streaming on the root only", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { exports?: Record<string, unknown> };
    const discovery = await import("./connectors/discovery.js");

    expect(packageJson.exports).toHaveProperty("./connectors/discovery");
    expect(discovery.loadConnectorDescriptor).toBeTypeOf("function");
    // One import path per symbol: these used to duplicate the root.
    expect(packageJson.exports).not.toHaveProperty("./workspace");
    expect(packageJson.exports).not.toHaveProperty("./execution");
    expect(rootExports.loadHarness).toBeTypeOf("function");
    expect(rootExports.streamHarness).toBeTypeOf("function");
    expect(rootExports.generateHarness).toBeTypeOf("function");
  });
});
