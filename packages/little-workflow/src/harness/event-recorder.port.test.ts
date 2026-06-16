import { describe, it, expect, vi } from "vitest";
import { createHarnessEventRecorder } from "./event-recorder.js";
import type { World } from "../world-port.js";

describe("event recorder uses the World port", () => {
  it("calls world.appendEvent, not a module function", async () => {
    const appendEvent = vi.fn().mockResolvedValue({
      eventId: "evt_x", runId: "run_a", sequence: 1,
      type: "HarnessModelResponded", recordedAt: "2026-05-26T00:00:00.000Z", payload: {},
    });
    const listEvents = vi.fn().mockResolvedValue([]);
    const world = {
      kind: "fake", dataDir: ".x", appendEvent, listEvents,
      writeArtifact: vi.fn(), readArtifact: vi.fn(), readArtifactManifest: vi.fn(),
    } satisfies World;
    const recorder = createHarnessEventRecorder({ world: world as never, runId: "run_a", skipManifestDriftCheck: true });
    await recorder.append({ type: "HarnessModelResponded", payload: {
      turn: 1, response: { usage: { inputTokens: 1, outputTokens: 1 } },
    } } as never);
    expect(appendEvent).toHaveBeenCalledOnce();
    expect(appendEvent).toHaveBeenCalledWith("run_a", {
      type: "harness.model.responded",
      payload: {
        turn: 1,
        response: { usage: { inputTokens: 1, outputTokens: 1 } },
      },
    });
  });
});
