import { describe, expect, it, vi } from "vitest";

import { createCheckpointTools } from "./tools.js";

describe("checkpoint tool", () => {
  it("forwards only agent annotation under a stable trusted call identity",
    async () => {
      const checkpoint = vi.fn(async (request) => ({
        protocolVersion: "little-harness.checkpoints.v1" as const,
        sessionId: request.sessionId,
        callIdentity: request.callIdentity,
        milestoneId: "ms_00000000000000000000000000",
        kind: request.kind,
        tier: "filesystem" as const,
        disposition: "created" as const,
      }));
      const tools = createCheckpointTools({
        sessionId: "session-1",
        originTurnId: "turn-1",
        checkpoints: { writer: { checkpoint } },
      });

      const first = await execute(tools.checkpoint, {
        label: "Checkout UI complete",
        kind: "goal_reached",
        rationale: "Ready for tests",
        evidenceArtifactIds: ["art_screenshot"],
      });
      const second = await execute(tools.checkpoint, {
        label: "Checkout UI complete",
        kind: "goal_reached",
        rationale: "Ready for tests",
        evidenceArtifactIds: ["art_screenshot"],
      });

      expect(first).toEqual({
        milestoneId: "ms_00000000000000000000000000",
        kind: "goal_reached",
        tier: "filesystem",
        disposition: "created",
      });
      expect(checkpoint).toHaveBeenCalledTimes(2);
      expect(checkpoint.mock.calls[0]![0]).toMatchObject({
        protocolVersion: "little-harness.checkpoints.v1",
        sessionId: "session-1",
        originTurnId: "turn-1",
        modelStepId: "step-1",
        sequenceIndex: 0,
        callIdentity: expect.stringMatching(/^ckpt_[0-9a-v]{40}$/u),
        label: "Checkout UI complete",
        kind: "goal_reached",
        evidenceArtifactIds: ["art_screenshot"],
      });
      expect(checkpoint.mock.calls[0]![0].callIdentity)
        .toBe(checkpoint.mock.calls[1]![0].callIdentity);
      expect(second).toEqual(first);
    });

  it("has no agent input shape for verified green or control-plane fields",
    async () => {
      const checkpoint = vi.fn();
      const tools = createCheckpointTools({
        sessionId: "session-1",
        originTurnId: "turn-1",
        checkpoints: { writer: { checkpoint } },
      });
      await expect(execute(tools.checkpoint, {
        label: "Trust me",
        kind: "verified_green",
      })).rejects.toThrow();
      await expect(execute(tools.checkpoint, {
        label: "Trust me",
        kind: "goal_reached",
        verdict: { status: "green" },
      })).rejects.toThrow();
      expect(checkpoint).not.toHaveBeenCalled();
    });

  it("rejects response substitution and missing execution identity", async () => {
    const tools = createCheckpointTools({
      sessionId: "session-1",
      originTurnId: "turn-1",
      checkpoints: {
        writer: {
          checkpoint: async (request) => ({
            protocolVersion: "little-harness.checkpoints.v1",
            sessionId: "other-session",
            callIdentity: request.callIdentity,
            milestoneId: "ms_00000000000000000000000000",
            kind: request.kind,
            tier: "tag",
            disposition: "created",
          }),
        },
      },
    });
    await expect(execute(tools.checkpoint, {
      label: "Point",
      kind: "goal_reached",
      evidenceArtifactIds: [],
    }))
      .rejects.toThrow(/does not match/i);
    await expect((tools.checkpoint as any).execute(
      { label: "Point", kind: "goal_reached", evidenceArtifactIds: [] },
      {},
    )).rejects.toThrow(/model position/i);
  });
});

async function execute(tool: unknown, input: unknown) {
  return await (tool as any).execute(input, {
    toolCallId: "tool-call-1",
    context: {
      modelStepId: "step-1",
      sequenceIndex: 0,
    },
  });
}
