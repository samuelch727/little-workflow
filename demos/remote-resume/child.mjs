// One stateless harness process. All state that survives this process lives in the
// remote session log; the parent only hands us the log's URL, run ids, and a phase.
import { writeFileSync } from "node:fs";
import {
  createHarness,
  generateHarness,
  localHost,
  remoteSessionLog,
  subprocessSandbox,
} from "little-harness";
import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";

const phase = process.env.DEMO_PHASE;
const serverUrl = process.env.DEMO_SERVER_URL;
const authToken = process.env.DEMO_AUTH_TOKEN;
const dataDir = process.env.DEMO_DATA_DIR;
const resultPath = process.env.DEMO_RESULT_PATH;
if (!phase || !serverUrl || !authToken || !dataDir || !resultPath) {
  console.error("[child] missing DEMO_* env");
  process.exit(2);
}

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const finish = (unified) => ({ unified, raw: unified });

function countToolResults(prompt, toolName) {
  let count = 0;
  for (const message of prompt) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "tool-result" && part.toolName === toolName) count += 1;
    }
  }
  return count;
}

// Turn A: a plain single-step text turn — the case that replays with ZERO provider calls.
let turnAModelCalls = 0;
const modelA = new MockLanguageModelV3({
  provider: "demo",
  modelId: "remote-resume-a",
  doGenerate: async () => {
    turnAModelCalls += 1;
    return {
      content: [{ type: "text", text: "remembered across processes" }],
      finishReason: finish("stop"),
      usage,
      warnings: [],
    };
  },
});

// Turn B: a multi-step turn — bash runs in the subprocess sandbox, then a configured tool.
// On resume the model is re-called per step by design; tool SIDE EFFECTS must not re-run.
let turnBModelCalls = 0;
let addToolExecutions = 0;
const modelB = new MockLanguageModelV3({
  provider: "demo",
  modelId: "remote-resume-b",
  doGenerate: async (options) => {
    turnBModelCalls += 1;
    if (countToolResults(options.prompt, "add") > 0) {
      return {
        content: [{ type: "text", text: "the sum is 7" }],
        finishReason: finish("stop"),
        usage,
        warnings: [],
      };
    }
    if (countToolResults(options.prompt, "bash") > 0) {
      return {
        content: [
          {
            type: "tool-call",
            toolCallId: "call_add_1",
            toolName: "add",
            input: JSON.stringify({ a: 3, b: 4 }),
          },
        ],
        finishReason: finish("tool-calls"),
        usage,
        warnings: [],
      };
    }
    return {
      content: [
        {
          type: "tool-call",
          toolCallId: "call_bash_1",
          toolName: "bash",
          input: JSON.stringify({
            command: "printf sandboxed > /artifacts/proof.txt && echo done",
          }),
        },
      ],
      finishReason: finish("tool-calls"),
      usage,
      warnings: [],
    };
  },
});

const sessionLog = remoteSessionLog({ baseUrl: serverUrl, authToken });
// Agent bash executes in a child process with a stripped environment — the sandbox port.
const host = localHost({ dataDir, executionEnvironment: subprocessSandbox() });

const harnessA = createHarness({ host, model: modelA, sessionLog });
const harnessB = createHarness({
  host,
  model: modelB,
  sessionLog,
  tools: {
    add: tool({
      description: "Add two numbers.",
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => {
        addToolExecutions += 1;
        return { sum: a + b };
      },
    }),
  },
});

const resultA = await generateHarness({
  harness: harnessA,
  messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Remember me." }] }],
  session: "remote-a",
  runId: "run_remote_a",
});
const resultB = await generateHarness({
  harness: harnessB,
  messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Add 3 and 4." }] }],
  session: "remote-b",
  runId: "run_remote_b",
});

writeFileSync(
  resultPath,
  JSON.stringify({
    phase,
    turnAText: resultA.text,
    turnBText: resultB.text,
    turnAModelCalls,
    turnBModelCalls,
    addToolExecutions,
  }),
);
console.error(
  `[child] phase=${phase} turnA=${JSON.stringify(resultA.text)} turnB=${JSON.stringify(resultB.text)} ` +
    `modelCalls=${turnAModelCalls}+${turnBModelCalls} addExecutions=${addToolExecutions}`,
);

if (phase === "initial") {
  // Die the hard way: no graceful shutdown, no flushing hooks. Everything the resume
  // needs must already be in the remote session log.
  process.kill(process.pid, "SIGKILL");
}
process.exit(0);
