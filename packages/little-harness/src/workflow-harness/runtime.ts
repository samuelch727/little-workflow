import { tool } from "ai";
import { z } from "zod";
import type {
  HarnessRuntime,
  HarnessRuntimeMount,
  HarnessRuntimeOptions,
  PreparedTurn,
} from "../types.js";

export type CreateWorkflowRuntimeOptions = {
  readonly prepared: PreparedTurn;
  readonly mounts: readonly HarnessRuntimeMount[];
  readonly runtime?: HarnessRuntimeOptions;
  readonly abortSignal?: AbortSignal;
};

const workflowShellInputSchema = z.object({
  cmd: z.string().optional(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  timeoutMs: z.number().optional(),
}).refine((input) => input.command !== undefined || input.cmd !== undefined, {
  message: "Either cmd or command is required.",
});

export async function createWorkflowRuntime(
  options: CreateWorkflowRuntimeOptions,
): Promise<HarnessRuntime> {
  const runtimeOptions: Parameters<PreparedTurn["createRuntime"]>[0] = {
    mounts: options.mounts,
    emitToolEvents: false,
  };
  if (options.runtime !== undefined) {
    runtimeOptions.runtime = options.runtime;
  }
  if (options.abortSignal !== undefined) {
    runtimeOptions.abortSignal = options.abortSignal;
  }

  const runtime = await options.prepared.createRuntime(runtimeOptions);
  const shell = runtime.shellTool();

  return {
    ...(runtime.dispose === undefined ? {} : { dispose: runtime.dispose.bind(runtime) }),
    systemHints(hintOptions) {
      return [
        "The workflow harness filesystem exposes memory under /mnt/memory, scratch under /mnt/scratch, and skills under .agents/skills.",
        "Use /mnt/scratch/own for temporary run-scoped work. Memory and skill mounts may be read-only depending on role scope.",
        ...runtime.systemHints(hintOptions),
      ];
    },
    shellTool() {
      return tool({
        description: "Run a bash command inside the Workflow harness filesystem.",
        inputSchema: workflowShellInputSchema,
        execute: async (input, executeOptions) => {
          const command = input.command ?? input.cmd;
          if (command === undefined) {
            throw new Error("Either cmd or command is required.");
          }

          const shellInput: { command: string; cwd?: string; timeoutMs?: number } = { command };
          if (input.cwd !== undefined) {
            shellInput.cwd = input.cwd;
          }
          if (input.timeoutMs !== undefined) {
            shellInput.timeoutMs = input.timeoutMs;
          }

          if (!shell.execute) {
            throw new Error("Workflow runtime shell tool is not executable.");
          }
          return shell.execute(shellInput, executeOptions as never);
        },
      });
    },
  };
}
