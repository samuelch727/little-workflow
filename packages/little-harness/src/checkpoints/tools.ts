import { tool, type ToolSet } from "ai";
import { z } from "zod";

import { HarnessInputError } from "../errors.js";
import { harnessExecutionContext } from "../tasks/types.js";
import { stableHash } from "../utils/canonical-hash.js";
import type {
  HarnessCheckpointResult,
  HarnessCheckpointsOptions,
  ResolvedHarnessCheckpoints,
} from "./types.js";

export const HARNESS_CHECKPOINT_TOOL_NAMES = ["checkpoint"] as const;

const CheckpointResultSchema = z.strictObject({
  protocolVersion: z.literal("little-harness.checkpoints.v1"),
  sessionId: z.string().min(1).max(512),
  callIdentity: z.string().min(1).max(512),
  milestoneId: z.string().min(1).max(512),
  kind: z.enum(["goal_reached", "pre_risky_op"]),
  tier: z.enum(["tag", "filesystem", "machine"]),
  disposition: z.enum(["created", "replayed", "coalesced"]),
  warning: z.string().min(1).max(2_048).optional(),
});

export function resolveCheckpointsOptions(
  options: HarnessCheckpointsOptions,
): ResolvedHarnessCheckpoints {
  if (typeof options?.writer?.checkpoint !== "function") {
    throw new HarnessInputError(
      "Harness checkpoints require a complete checkpoint writer port.",
    );
  }
  return Object.freeze({ writer: options.writer });
}

/**
 * The agent can annotate a point in its work, but cannot supply identity,
 * tier, state, time, author, verdict, cost, or retention. Those fields are
 * captured and enforced by the host/control-plane checkpoint writer.
 */
export function createCheckpointTools(config: Readonly<{
  sessionId: string;
  originTurnId: string;
  checkpoints: ResolvedHarnessCheckpoints;
  abortSignal?: AbortSignal;
}>): ToolSet {
  if (
    typeof config?.sessionId !== "string" || config.sessionId.length < 1 ||
    typeof config.originTurnId !== "string" || config.originTurnId.length < 1 ||
    typeof config.checkpoints?.writer?.checkpoint !== "function" ||
    (config.abortSignal !== undefined &&
      !(config.abortSignal instanceof AbortSignal))
  ) throw new HarnessInputError("Harness checkpoint tool configuration is invalid.");

  return {
    checkpoint: tool({
      description:
        "Request a durable milestone for the current workspace and session position. " +
        "The control plane chooses the checkpoint tier; this tool cannot claim verification.",
      inputSchema: z.strictObject({
        label: z.string().min(1).max(120),
        kind: z.enum(["goal_reached", "pre_risky_op"])
          .default("goal_reached"),
        rationale: z.string().max(4_096).optional(),
        evidenceArtifactIds: z.array(z.string().min(1).max(512))
          .max(64).default([]),
      }),
      execute: async (input, executionOptions) => {
        const execution = requiredExecutionIdentity(executionOptions);
        const callIdentity = `ckpt_${stableHash({
          domain: "little-harness.checkpoint-call.v1",
          sessionId: config.sessionId,
          originTurnId: config.originTurnId,
          toolCallId: execution.toolCallId,
          modelStepId: execution.modelStepId,
          sequenceIndex: execution.sequenceIndex,
          request: input,
        }, { format: "base32hex" }).slice(0, 40)}`;
        let result: HarnessCheckpointResult;
        try {
          const parsed = CheckpointResultSchema.parse(
            await config.checkpoints.writer.checkpoint(Object.freeze({
              protocolVersion: "little-harness.checkpoints.v1" as const,
              sessionId: config.sessionId,
              originTurnId: config.originTurnId,
              modelStepId: execution.modelStepId,
              sequenceIndex: execution.sequenceIndex,
              callIdentity,
              label: input.label,
              kind: input.kind,
              ...(input.rationale === undefined
                ? {}
                : { rationale: input.rationale }),
              evidenceArtifactIds: Object.freeze([
                ...input.evidenceArtifactIds,
              ]),
              ...(config.abortSignal === undefined
                ? {}
                : { abortSignal: config.abortSignal }),
            })),
          );
          result = Object.freeze({
            protocolVersion: parsed.protocolVersion,
            sessionId: parsed.sessionId,
            callIdentity: parsed.callIdentity,
            milestoneId: parsed.milestoneId,
            kind: parsed.kind,
            tier: parsed.tier,
            disposition: parsed.disposition,
            ...(parsed.warning === undefined
              ? {}
              : { warning: parsed.warning }),
          });
        } catch (cause) {
          if (cause instanceof HarnessInputError) throw cause;
          throw new HarnessInputError(
            "The checkpoint writer returned an invalid response.",
            { causeName: cause instanceof Error ? cause.name : "unknown" },
          );
        }
        if (
          result.sessionId !== config.sessionId ||
          result.callIdentity !== callIdentity ||
          result.kind !== input.kind
        ) {
          throw new HarnessInputError(
            "The checkpoint writer response does not match this call.",
          );
        }
        return Object.freeze({
          milestoneId: result.milestoneId,
          kind: result.kind,
          tier: result.tier,
          disposition: result.disposition,
          ...(result.warning === undefined ? {} : { warning: result.warning }),
        });
      },
    }),
  };
}

function requiredExecutionIdentity(value: unknown): Readonly<{
  toolCallId: string;
  modelStepId: string;
  sequenceIndex: number;
}> {
  const execution = harnessExecutionContext(value);
  const toolCallId = execution.toolCallId;
  if (
    toolCallId === undefined || toolCallId.length < 1 ||
    toolCallId.length > 512 || hasControl(toolCallId) ||
    execution.modelStepId === undefined ||
    execution.modelStepId.length < 1 ||
    execution.modelStepId.length > 512 ||
    hasControl(execution.modelStepId) ||
    execution.sequenceIndex === undefined ||
    !Number.isSafeInteger(execution.sequenceIndex) ||
    execution.sequenceIndex < 0
  ) {
    throw new HarnessInputError(
      "Checkpoint calls require a Harness-supplied model position.",
    );
  }
  return Object.freeze({
    toolCallId,
    modelStepId: execution.modelStepId,
    sequenceIndex: execution.sequenceIndex,
  });
}

function hasControl(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}
