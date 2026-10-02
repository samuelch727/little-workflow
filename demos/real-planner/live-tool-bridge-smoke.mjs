import { createDeepSeek } from "@ai-sdk/deepseek";
import { defaultSettingsMiddleware, stepCountIs, tool, wrapLanguageModel } from "ai";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "../../packages/little-harness/node_modules/zod/index.js";
import { createHarness, generateHarness, localHost } from "../../packages/little-harness/dist/index.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
loadEnvFile(path.join(repoRoot, ".env.local"));
loadEnvFile(path.resolve(repoRoot, "../..", ".env.local"));

if (!process.env.DEEPSEEK_API_KEY) {
  console.error("Set DEEPSEEK_API_KEY or add it to the repo-root .env.local.");
  process.exit(1);
}

const provider = createDeepSeek({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1",
  headers: { "accept-encoding": "identity" },
});

const modelConfigs = [
  {
    id: "deepseek-v4-pro",
    forceToolChoice: false,
    model: wrapLanguageModel({
      model: provider("deepseek-v4-pro"),
      middleware: defaultSettingsMiddleware({
        settings: {
          maxRetries: 2,
          providerOptions: {
            deepseek: { thinking: { type: "enabled" }, reasoningEffort: "high" },
          },
        },
      }),
    }),
  },
  {
    id: "deepseek-v4-flash",
    forceToolChoice: true,
    model: wrapLanguageModel({
      model: provider("deepseek-v4-flash"),
      middleware: defaultSettingsMiddleware({
        settings: {
          maxRetries: 2,
          providerOptions: {
            deepseek: { thinking: { type: "disabled" } },
          },
        },
      }),
    }),
  },
];

const bridgeProgram = [
  "const skus=[\"SKU-004\",\"SKU-017\",\"SKU-031\",\"SKU-044\",\"SKU-059\",\"SKU-073\"];",
  "const catalog=await tools.catalogSearch({categories:[\"compute\",\"storage\",\"network\"],limit:96});",
  "if(!catalog.path) throw new Error(\"missing catalog spool path\");",
  "const quotes=[];",
  "for(let i=0;i<skus.length;i+=1){quotes.push(await tools.priceQuote({sku:skus[i],quantity:i+2,currency:\"USD\"}));}",
  "const inventory=await Promise.all(quotes.map((q)=>tools.inventoryCheck({sku:q.sku,region:\"us-east\"})));",
  "const risks=await Promise.all(quotes.map((q)=>tools.complianceRisk({sku:q.sku,destination:\"EU\",amount:q.total})));",
  "const total=Number(quotes.reduce((sum,q)=>sum+q.total,0).toFixed(2));",
  "const maxRisk=Math.max(...risks.map((risk)=>risk.score));",
  "const decision=await tools.writeDecision({catalogPath:catalog.path,quotes,inventory,risks,total,maxRisk});",
  "const audit=await tools.auditTrail({decisionPath:decision.path,quoteCount:quotes.length,total,marker:\"BRIDGE_COMPLEX_OK\"});",
  "console.log(JSON.stringify({marker:\"BRIDGE_COMPLEX_OK\",catalogPath:catalog.path,decisionPath:decision.path,auditPath:audit.path,quoteCount:quotes.length,total,maxRisk}));",
].join("");

const bridgeCommand = `js-exec -c '${bridgeProgram}' > /artifacts/bridge-summary.json`;
const dataRoot = path.join(repoRoot, "demos/real-planner/.little-harness-live-tool-bridge");
rmSync(dataRoot, { recursive: true, force: true });

const summaries = [];
for (const config of modelConfigs) {
  summaries.push(await runModelSmoke(config));
}

console.log(JSON.stringify({ ok: true, summaries }, null, 2));

async function runModelSmoke(config) {
  const events = [];
  const toolCallCounts = new Map();
  const harness = createHarness({
    host: localHost({ dataDir: path.join(dataRoot, safeSegment(config.id)) }),
    model: config.model,
    system: [
      "You are running a live Little Harness Runtime Tool Bridge smoke test.",
      "On the first step, call the bash tool with exactly this command and no extra commands:",
      bridgeCommand,
      "Do not call app tools directly through provider tool calls. The app tools must be called from js-exec.",
    ].join("\n"),
    toolResultSpooling: { maxInlineBytes: 1200, previewBytes: 160 },
    tools: smokeTools(toolCallCounts),
    onEvent: async (event) => {
      events.push(event);
    },
  });

  const result = await generateHarness({
    harness,
    messages: [
      {
        id: `live-${safeSegment(config.id)}`,
        role: "user",
        parts: [{ type: "text", text: "Run the live runtime bridge scenario." }],
      },
    ],
    session: `live-runtime-bridge-${safeSegment(config.id)}`,
    runId: `live-runtime-bridge-${safeSegment(config.id)}`,
    maxRetries: 1,
    stopWhen: stepCountIs(1),
    prepareStep: ({ stepNumber }) => {
      if (stepNumber !== 0) {
        return { activeTools: [] };
      }
      return config.forceToolChoice
        ? { activeTools: ["bash"], toolChoice: { type: "tool", toolName: "bash" } }
        : { activeTools: ["bash"] };
    },
  });

  const summary = JSON.parse((await result.session.files.read("/artifacts/bridge-summary.json")).text());
  const catalogText = (await result.session.files.read(summary.catalogPath)).text();
  const decision = JSON.parse((await result.session.files.read(summary.decisionPath)).text());
  const audit = JSON.parse((await result.session.files.read(summary.auditPath)).text());
  const runtimeSucceeded = events.filter(
    (event) =>
      event.type === "harness.tool_call.succeeded" &&
      event.metadata?.caller === "runtime",
  );
  const runtimeStarted = events.filter(
    (event) =>
      event.type === "harness.tool_call.started" &&
      event.metadata?.caller === "runtime",
  );
  const modelToolStarted = events.filter(
    (event) =>
      event.type === "harness.tool_call.started" &&
      event.metadata?.caller === "model",
  );
  const catalogSucceeded = runtimeSucceeded.find((event) => event.metadata?.toolName === "catalogSearch");
  const catalogFileEvents = events.filter(
    (event) => event.type === "harness.file.created" && event.metadata?.path === summary.catalogPath,
  );

  assert(summary.marker === "BRIDGE_COMPLEX_OK", `${config.id}: missing bridge marker`);
  assert(summary.quoteCount === 6, `${config.id}: expected 6 quotes`);
  assert(summary.total > 0, `${config.id}: expected positive total`);
  assert(decision.total === summary.total, `${config.id}: decision total mismatch`);
  assert(audit.marker === "BRIDGE_COMPLEX_OK", `${config.id}: audit marker mismatch`);
  assert(catalogText.includes("CATALOG_SENTINEL_BRIDGE_LARGE_RESPONSE"), `${config.id}: catalog sentinel missing`);
  assert(catalogSucceeded?.metadata?.spooled?.path === summary.catalogPath, `${config.id}: missing spooled metadata`);
  assert(catalogFileEvents.length === 1, `${config.id}: expected one catalog file-created event`);
  assert(runtimeStarted.length >= 11, `${config.id}: expected many runtime tool starts`);
  assert(runtimeSucceeded.length >= 11, `${config.id}: expected many runtime tool successes`);
  assert(modelToolStarted.length === 1, `${config.id}: expected one model bash tool call`);
  assert(modelToolStarted.every((event) => event.metadata?.toolName === "bash"), `${config.id}: app tool called directly by model`);

  return {
    modelId: config.id,
    finalText: result.text.trim(),
    finalTextHasMarker: result.text.includes("BRIDGE_COMPLEX_OK"),
    summary,
    runtimeToolStarts: runtimeStarted.length,
    runtimeToolSuccesses: runtimeSucceeded.length,
    modelToolStarts: modelToolStarted.map((event) => event.metadata?.toolName),
    toolCallCounts: Object.fromEntries([...toolCallCounts.entries()].sort()),
    tracePath: result.trace.path,
  };
}

function smokeTools(counts) {
  const track = (name) => counts.set(name, (counts.get(name) ?? 0) + 1);
  return {
    catalogSearch: tool({
      description: "Search the product catalog. Returns a deliberately large payload.",
      inputSchema: z.object({
        categories: z.array(z.string()),
        limit: z.number(),
      }),
      execute: async ({ categories, limit }) => {
        track("catalogSearch");
        return {
          sentinel: "CATALOG_SENTINEL_BRIDGE_LARGE_RESPONSE",
          categories,
          rows: Array.from({ length: limit }, (_, index) => ({
            sku: `SKU-${String(index + 1).padStart(3, "0")}`,
            category: categories[index % categories.length],
            title: `Bridge smoke product ${index + 1}`,
            notes: "large-row-payload ".repeat(12),
            attributes: {
              latencyMs: 20 + (index % 13),
              storageGb: 128 + index,
              region: index % 2 === 0 ? "us-east" : "eu-west",
            },
          })),
        };
      },
    }),
    priceQuote: tool({
      description: "Quote one SKU.",
      inputSchema: z.object({
        sku: z.string(),
        quantity: z.number(),
        currency: z.string(),
      }),
      execute: async ({ sku, quantity, currency }) => {
        track("priceQuote");
        const numeric = Number(sku.replace(/\D/gu, ""));
        const unitPrice = Number((18 + (numeric % 17) * 1.37).toFixed(2));
        const discount = quantity >= 5 ? 0.08 : 0.03;
        const total = Number((unitPrice * quantity * (1 - discount)).toFixed(2));
        return { sku, quantity, currency, unitPrice, discount, total, quoteId: `quote-${sku}-${quantity}` };
      },
    }),
    inventoryCheck: tool({
      description: "Check regional inventory for one SKU.",
      inputSchema: z.object({
        sku: z.string(),
        region: z.string(),
      }),
      execute: async ({ sku, region }) => {
        track("inventoryCheck");
        const numeric = Number(sku.replace(/\D/gu, ""));
        return {
          sku,
          region,
          available: 40 + (numeric % 9),
          warehouses: [`${region}-a`, `${region}-b`],
        };
      },
    }),
    complianceRisk: tool({
      description: "Score compliance risk for one SKU quote.",
      inputSchema: z.object({
        sku: z.string(),
        destination: z.string(),
        amount: z.number(),
      }),
      execute: async ({ sku, destination, amount }) => {
        track("complianceRisk");
        const numeric = Number(sku.replace(/\D/gu, ""));
        const score = Number(Math.min(0.99, 0.12 + (numeric % 11) / 20 + amount / 10000).toFixed(3));
        return {
          sku,
          destination,
          amount,
          score,
          flags: score > 0.55 ? ["manual_review"] : [],
        };
      },
    }),
    writeDecision: tool({
      description: "Write the aggregated bridge decision to an artifact.",
      inputSchema: z.object({
        catalogPath: z.string(),
        quotes: z.array(z.any()),
        inventory: z.array(z.any()),
        risks: z.array(z.any()),
        total: z.number(),
        maxRisk: z.number(),
      }),
      execute: async (input, ctx) => {
        track("writeDecision");
        const pathName = `/artifacts/runtime-bridge/decision-${stableChecksum(input)}.json`;
        const ref = await ctx.files.writeJSON(pathName, {
          marker: "BRIDGE_COMPLEX_OK",
          ...input,
        }, {
          artifact: { metadata: { smoke: "runtime-tool-bridge", kind: "decision" } },
        });
        return { path: ref.path, bytes: ref.bytes, sha256: ref.sha256 };
      },
    }),
    auditTrail: tool({
      description: "Write an audit record for the bridge smoke decision.",
      inputSchema: z.object({
        decisionPath: z.string(),
        quoteCount: z.number(),
        total: z.number(),
        marker: z.string(),
      }),
      execute: async (input, ctx) => {
        track("auditTrail");
        const pathName = `/artifacts/runtime-bridge/audit-${stableChecksum(input)}.json`;
        const ref = await ctx.files.writeJSON(pathName, {
          ...input,
          auditedAt: "2026-06-12T00:00:00.000Z",
        }, {
          artifact: { metadata: { smoke: "runtime-tool-bridge", kind: "audit" } },
        });
        return { path: ref.path, bytes: ref.bytes, sha256: ref.sha256, marker: input.marker };
      },
    }),
  };
}

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return;
  }
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(trimmed);
    if (!match || process.env[match[1]] !== undefined) {
      continue;
    }
    process.env[match[1]] = unquoteEnvValue(match[2]);
  }
}

function unquoteEnvValue(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function stableChecksum(value) {
  const text = JSON.stringify(value);
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function safeSegment(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
