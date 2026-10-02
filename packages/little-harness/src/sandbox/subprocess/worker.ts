import { Bash } from "just-bash";
import { createInterface } from "node:readline";
import {
  bashOptionsForRuntime,
  buildWorkspaceFs,
  defenseInDepthForAdapter,
  execBashSafely,
} from "../../runtime/just-bash-runtime.js";
import { deserializeWorkspace, type ParentToWorkerMessage, type WorkerToParentMessage } from "./protocol.js";

/**
 * Subprocess sandbox worker — the "hands". Spawned by subprocessSandbox() with a stripped
 * environment: it receives a serialized workspace spec and runtime toggles over stdin,
 * runs just-bash over the mounts, and proxies js-exec tool calls back to the parent over
 * stdout. It never sees harness sessions, tool implementations, or credentials.
 */

type PendingToolCall = {
  resolve(result: string): void;
  reject(error: Error): void;
};

let bash: Bash | undefined;
let currentCwd = "/";
let currentEnv: Record<string, string> = {};
let nextToolCallId = 0;
const pendingToolCalls = new Map<number, PendingToolCall>();
let commandChain: Promise<void> = Promise.resolve();

function send(message: WorkerToParentMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function invokeTool(path: string, argsJson: string): Promise<string> {
  nextToolCallId += 1;
  const id = nextToolCallId;
  send({ type: "tool_call", id, path, argsJson });
  return new Promise<string>((resolve, reject) => {
    pendingToolCalls.set(id, { resolve, reject });
  });
}

async function handleInit(message: Extract<ParentToWorkerMessage, { type: "init" }>): Promise<void> {
  const workspace = deserializeWorkspace(message.workspace);
  const fs = await buildWorkspaceFs(workspace, message.mounts);
  const javascript =
    message.runtime.javascript === false
      ? (false as const)
      : message.toolBridge
        ? { invokeTool }
        : message.runtime.javascript ?? true;
  bash = new Bash(bashOptionsForRuntime(fs, workspace.workingDir, message.runtime, {
    javascript,
    defenseInDepth: defenseInDepthForAdapter("subprocess"),
  }));
  currentCwd = workspace.workingDir;
  currentEnv = bash.getEnv();
  send({ type: "ready", id: message.id });
}

async function handleExec(message: Extract<ParentToWorkerMessage, { type: "exec" }>): Promise<void> {
  if (bash === undefined) {
    send({ type: "exec_result", id: message.id, stdout: "", stderr: "Sandbox worker is not initialized.", exitCode: 1 });
    return;
  }
  const executionInput = {
    command: message.command,
    ...(message.timeoutMs === undefined ? {} : { timeoutMs: message.timeoutMs }),
    cwd: message.cwd ?? currentCwd,
    env: currentEnv,
  };
  const result = await execBashSafely(bash, executionInput, undefined);
  currentEnv = result.env;
  currentCwd = result.env.PWD ?? executionInput.cwd;
  send({
    type: "exec_result",
    id: message.id,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  });
}

function handleToolResult(message: Extract<ParentToWorkerMessage, { type: "tool_result" }>): void {
  const pending = pendingToolCalls.get(message.id);
  if (pending === undefined) {
    return;
  }
  pendingToolCalls.delete(message.id);
  if (message.ok) {
    pending.resolve(message.resultJson);
  } else {
    pending.reject(new Error(message.message));
  }
}

function handleMessage(message: ParentToWorkerMessage): void {
  // tool_result must bypass the serial command chain: an in-flight exec is awaiting it.
  if (message.type === "tool_result") {
    handleToolResult(message);
    return;
  }
  if (message.type === "diag") {
    send({ type: "diag_result", id: message.id, pid: process.pid, envKeys: Object.keys(process.env) });
    return;
  }

  commandChain = commandChain.then(async () => {
    if (message.type === "init") {
      await handleInit(message);
    } else if (message.type === "exec") {
      await handleExec(message);
    }
  }).catch((error: unknown) => {
    send({ type: "fatal", message: error instanceof Error ? error.message : String(error) });
  });
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  if (line.trim().length === 0) {
    return;
  }
  let message: ParentToWorkerMessage;
  try {
    message = JSON.parse(line) as ParentToWorkerMessage;
  } catch {
    send({ type: "fatal", message: `Invalid message: ${line.slice(0, 200)}` });
    return;
  }
  handleMessage(message);
});
rl.on("close", () => {
  process.exit(0);
});
