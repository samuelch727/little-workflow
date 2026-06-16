import { describe, expect, it } from "vitest";
import { createLittleWorkflow, localWorld, model, type Harness } from "./index.js";

const testHarness: Harness = {
  async run() {
    return { kind: "plan", lwir: { apiVersion: "littleworkflow.dev/v0.1" } };
  },
};

describe("package exports", () => {
  it("exports alpha authoring stubs before implementation", () => {
    const workflow = createLittleWorkflow({
      id: "support.summarize",
      description: "Summarize support tickets.",
      models: [model({ provider: "test", modelId: "worker" })],
      planner: {
        model: { provider: "test", modelId: "planner" },
        harness: testHarness,
      },
    });

    expect(workflow.id).toBe("support.summarize");
    expect(localWorld({ dataDir: "tmp" }).kind).toBe("local-world");
    expect(localWorld({ dataDir: "tmp" }).dataDir).toBe("tmp");
  });
});
