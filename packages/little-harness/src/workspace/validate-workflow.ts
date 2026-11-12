import { HarnessInputError } from "../errors.js";
import type { HarnessWorkflow } from "../workflows.js";

export function validateDiscoveredWorkflow(value: unknown, modulePath: string): HarnessWorkflow {
  if (!isRecord(value)) {
    throw new HarnessInputError("Discovered workflow must default-export a workflow object.", { modulePath });
  }
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new HarnessInputError("Discovered workflow must include an id.", { modulePath });
  }
  if (value.executionMode !== "inline" && value.executionMode !== "durable") {
    throw new HarnessInputError("Discovered workflow must include executionMode.", { modulePath, workflowId: value.id });
  }
  if (typeof value.runForHarness !== "function") {
    throw new HarnessInputError("Discovered workflow must include runForHarness.", { modulePath, workflowId: value.id });
  }
  if (!isDefinitionIdentity(value.definitionIdentity)) {
    throw new HarnessInputError("Discovered workflow must include a workflow definition identity.", {
      modulePath,
      workflowId: value.id,
    });
  }
  return value as HarnessWorkflow;
}

function isDefinitionIdentity(value: unknown): boolean {
  return typeof value === "string" ||
    (isRecord(value) && value.notApplicable === true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
