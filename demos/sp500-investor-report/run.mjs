/**
 * sp500-investor-report
 *
 * Passes the S&P 500 top-50 reports ZIP into a Little Workflow run. The
 * workflow calls an unzip-backed tool to compact the archive into investor
 * dossiers, analyzes each company in parallel, and returns a Markdown report.
 *
 * Requires DEEPSEEK_API_KEY for the live variant. The stub variant is keyless.
 */

import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import * as ai from "ai";
import { Output, streamText } from "ai";
import {
  createWorkflowHarness,
  createLittleWorkflow,
  createToolRegistry,
  localWorld,
  model,
  runWorkflow,
} from "little-workflow";
import { assertUnzipAvailable, loadCompanyDossiers } from "./dataset.mjs";
import { renderStubCompanyReport, renderStubFinalMarkdown } from "./markdown.mjs";
import { resolveDeepseekModel } from "./provider-client.mjs";
import {
  buildInvestorWorkflowLwir,
  datasetSchema,
  toolInputSchema,
} from "./workflow-lwir.mjs";

const DEFAULT_ARCHIVE_PATH = "./sp500_top50_reports.zip";
const DEFAULT_MODEL_ID = "deepseek-v4-pro";
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_MODEL_CALL_TIMEOUT_MS = 300_000;
const DEFAULT_MODEL_CALL_MAX_RETRIES = 2;
const DEFAULT_MODEL_CALL_RETRY_DELAY_MS = 2_000;

const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;

if (isDirectRun) {
  try {
    await runDemo(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export function parseArgs(argv) {
  const args = [...argv];
  let variant = "live";
  if (args[0] !== undefined && !args[0].startsWith("-")) {
    variant = args.shift();
  }
  if (!["live", "stub"].includes(variant)) {
    throw new Error(`Unknown variant '${variant}'. Expected live or stub.`);
  }

  const options = {
    variant,
    archivePath: DEFAULT_ARCHIVE_PATH,
    limit: 50,
    recommendationCount: 5,
    riskProfile: "balanced",
    outPath: undefined,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    switch (arg) {
      case "--":
        break;
      case "--archive":
        options.archivePath = requireValue(arg, next);
        index += 1;
        break;
      case "--limit":
        options.limit = parseBoundedInteger(requireValue(arg, next), "--limit", 1, 50);
        index += 1;
        break;
      case "--recommendations":
        options.recommendationCount = parseBoundedInteger(
          requireValue(arg, next),
          "--recommendations",
          1,
          10,
        );
        index += 1;
        break;
      case "--risk":
        options.riskProfile = requireValue(arg, next);
        index += 1;
        break;
      case "--out":
        options.outPath = requireValue(arg, next);
        index += 1;
        break;
      default:
        throw new Error(`Unknown option '${arg}'.`);
    }
  }

  return options;
}

export async function runDemo({
  variant,
  archivePath,
  limit,
  recommendationCount,
  riskProfile,
  outPath,
}) {
  const useStub = variant === "stub";
  if (!useStub && !process.env.DEEPSEEK_API_KEY) {
    throw new Error("Set DEEPSEEK_API_KEY to run this demo.");
  }

  const unzipCommand = process.env.UNZIP_COMMAND ?? "unzip";
  await assertUnzipAvailable(unzipCommand);

  const deepseekModelId = process.env.DEEPSEEK_MODEL_ID ?? DEFAULT_MODEL_ID;
  const deepseekBaseURL = process.env.DEEPSEEK_BASE_URL ?? DEFAULT_DEEPSEEK_BASE_URL;
  const modelCallTimeoutMs = parseOptionalPositiveInteger(
    process.env.MODEL_CALL_TIMEOUT_MS ?? process.env.DEEPSEEK_MODEL_CALL_TIMEOUT_MS,
    "MODEL_CALL_TIMEOUT_MS",
  ) ?? DEFAULT_MODEL_CALL_TIMEOUT_MS;
  const modelCallMaxRetries = parseOptionalNonNegativeInteger(
    process.env.MODEL_CALL_MAX_RETRIES ?? process.env.DEEPSEEK_MODEL_CALL_MAX_RETRIES,
    "MODEL_CALL_MAX_RETRIES",
  ) ?? DEFAULT_MODEL_CALL_MAX_RETRIES;
  const modelCallRetryDelayMs = parseOptionalNonNegativeInteger(
    process.env.MODEL_CALL_RETRY_DELAY_MS ?? process.env.DEEPSEEK_MODEL_CALL_RETRY_DELAY_MS,
    "MODEL_CALL_RETRY_DELAY_MS",
  ) ?? DEFAULT_MODEL_CALL_RETRY_DELAY_MS;
  const aiSdkModel = useStub
    ? { provider: "stub", modelId: "stub-worker" }
    : resolveDeepseekModel({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: deepseekBaseURL,
        modelId: deepseekModelId,
      });

  const workflowId = "demo.sp500.investor.report";
  const fixedLwir = buildInvestorWorkflowLwir({ workflowName: workflowId });
  const plannerHarness = {
    harnessId: "sp500InvestorFixedPlanner@1.0.0",
    async run(task) {
      if (task.kind !== "plan") {
        return { kind: "delegate_to_default" };
      }
      return { kind: "plan", lwir: fixedLwir };
    },
  };

  const workerHarness = createWorkflowHarness({
    modelCallTimeoutMs,
    modelCallMaxRetries,
    modelCallRetryDelayMs,
    aiLoop: {
      generate: async ({ model: stepModel, system, step, input, signal }) => {
        if (useStub) {
          const text = renderStubStep({ stepId: step.id, input });
          return {
            output: text,
            text,
            usage: { inputTokens: 0, outputTokens: 0 },
          };
        }

        const stepSystem = typeof step.with?.system === "string" ? step.with.system : undefined;
        const prompt = typeof step.with?.prompt === "string" ? step.with.prompt : "";
        const mergedSystem = [system, stepSystem].filter(Boolean).join("\n\n") || undefined;
        const result = await runWorkerLiveCall({
          model: stepModel,
          system: mergedSystem,
          prompt: renderPromptTemplate(prompt, input),
          outputMode: step.output?.mode ?? "text",
          signal,
          timeout: modelCallTimeoutMs,
        });
        return {
          output: result.output,
          text: result.text,
          usage: {
            inputTokens: result.usage?.inputTokens ?? 0,
            outputTokens: result.usage?.outputTokens ?? 0,
          },
        };
      },
    },
  });

  const workerSlot = model(aiSdkModel, {
    id: "model.worker",
    description: "DeepSeek v4 pro worker model for S&P 500 investor reports.",
  });
  const workflow = createLittleWorkflow({
    id: workflowId,
    description:
      "Given a ZIP of S&P 500 top-company SEC reports, output Markdown investor reports and recommended stocks.",
    inputSchema: fixedLwir.input.schema,
    output: { kind: "text" },
    models: [workerSlot],
    planner: {
      model: aiSdkModel,
      harness: plannerHarness,
    },
    globalTools: ["sp500.unzip_company_dossiers"],
    worker: { harness: workerHarness },
  });

  const tools = createToolRegistry({
    "sp500.unzip_company_dossiers": ai.tool({
      description:
        "Read the provided S&P 500 report ZIP through unzip and return compact investor dossiers.",
      inputSchema: toolInputSchema,
      outputSchema: datasetSchema,
      execute: async ({ archivePath: toolArchivePath, limit: toolLimit }) =>
        loadCompanyDossiers({
          archivePath: toolArchivePath,
          limit: toolLimit,
          unzipCommand,
        }),
    }),
  });

  const world = localWorld({
    dataDir: ".little-workflow-sp500-investor-report",
    maxConcurrentSteps: 6,
  });

  const result = await runWorkflow({
    world,
    workflows: workflow,
    input: {
      archivePath,
      limit,
      recommendationCount,
      riskProfile,
    },
    tools,
    runId: `run_demo_sp500_investor_${variant}_${Date.now()}`,
  });

  if (result.status !== "completed") {
    throw new Error(`Expected completed status, received: ${result.status}`);
  }
  if (typeof result.output !== "string") {
    throw new Error("Expected workflow output to be Markdown text.");
  }

  const header = [
    `<!-- demo: sp500-investor-report (${variant}) -->`,
    `<!-- Archive: ${archivePath} -->`,
    `<!-- Unzip tool: ${unzipCommand} -->`,
    `<!-- Model: ${useStub ? "stub-worker" : deepseekModelId} -->`,
    `<!-- Model call timeout: ${modelCallTimeoutMs}ms -->`,
    `<!-- Model call retries: ${modelCallMaxRetries} (delay ${modelCallRetryDelayMs}ms) -->`,
    "",
  ].join("\n");
  const markdown = `${header}${result.output}`;
  if (outPath !== undefined) {
    await writeFile(outPath, markdown, "utf8");
  }
  process.stdout.write(markdown);
  if (!markdown.endsWith("\n")) process.stdout.write("\n");
}

export async function runWorkerLiveCall({ model, system, prompt, outputMode, signal, timeout }) {
  if (outputMode !== "text") {
    throw new TypeError(`Unsupported live output mode for this demo: ${outputMode}`);
  }
  const result = streamText({
    model,
    ...(system === undefined ? {} : { system }),
    prompt,
    output: Output.text(),
    abortSignal: signal,
    timeout,
  });
  const [text, usage] = await Promise.all([result.text, result.usage]);
  return { output: text, text, usage };
}

function renderStubStep({ stepId, input }) {
  if (stepId === "write-company-report") {
    return renderStubCompanyReport({
      company: input.company,
      riskProfile: input.riskProfile,
    });
  }
  if (stepId === "select-recommendations") {
    return renderStubFinalMarkdown({
      dataset: input.dataset,
      companyReports: input.companyReports,
      recommendationCount: input.recommendationCount,
      riskProfile: input.riskProfile,
    });
  }
  throw new Error(`No stub renderer for step '${stepId}'.`);
}

function renderPromptTemplate(prompt, input) {
  const fallback = `Use this input JSON:\n${safeJson(input)}`;
  if (typeof prompt !== "string" || prompt.length === 0) {
    return fallback;
  }
  const rendered = prompt.replace(/\{\{\s*input\.([^{}]+)\s*\}\}/gu, (_whole, path) => {
    const value = readPath(input, path.trim());
    return value === undefined ? "" : safeScalar(value);
  });
  if (rendered.includes("{{") || rendered.includes("}}")) {
    return fallback;
  }
  return rendered;
}

function readPath(root, rawPath) {
  const normalized = rawPath
    .replace(/\[(\d+)\]/gu, ".$1")
    .replace(/\[['"]([^'"]+)['"]\]/gu, ".$1");
  const segments = normalized.split(".").filter(Boolean);
  let current = root;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    if (!Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function safeScalar(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return safeJson(value);
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseBoundedInteger(value, name, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return parsed;
}

function parseOptionalPositiveInteger(value, name) {
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function parseOptionalNonNegativeInteger(value, name) {
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

function requireValue(flag, value) {
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}
