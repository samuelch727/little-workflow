const companyDossierSchema = {
  type: "object",
  required: ["rank", "ticker", "name", "filings", "metrics", "evidence"],
  additionalProperties: true,
  properties: {
    rank: { type: "number" },
    ticker: { type: "string" },
    name: { type: "string" },
    cik: { type: "string" },
    exchange: { type: "string" },
    industry: { type: "string" },
    weight: { type: "number" },
    price: { type: "number" },
    filings: { type: "object", additionalProperties: true },
    metrics: { type: "object", additionalProperties: true },
    evidence: { type: "array", items: { type: "object", additionalProperties: true } },
  },
};

export const datasetSchema = {
  type: "object",
  required: ["source", "asOfDate", "dataRange", "companyCount", "companies"],
  additionalProperties: true,
  properties: {
    source: { type: "object", additionalProperties: true },
    asOfDate: { type: "string" },
    dataRange: { type: "object", additionalProperties: true },
    companyCount: { type: "number" },
    companies: { type: "array", items: companyDossierSchema },
  },
};

const parallelEnvelopeArraySchema = {
  type: "array",
  items: {
    type: "object",
    required: ["itemKey", "status", "artifacts"],
    additionalProperties: true,
    properties: {
      itemKey: { type: "string" },
      status: { enum: ["completed", "failed"] },
      output: { type: "string" },
      outputRef: { type: "string" },
      error: { type: "object", additionalProperties: true },
      artifacts: { type: "array", items: { type: "string" } },
    },
  },
};

export const toolInputSchema = {
  type: "object",
  required: ["archivePath"],
  additionalProperties: false,
  properties: {
    archivePath: { type: "string" },
    limit: { type: "number", minimum: 1, maximum: 50 },
  },
};

export function buildInvestorWorkflowLwir({ workflowName }) {
  return {
    apiVersion: "littleworkflow.dev/v0.1",
    kind: "Workflow",
    metadata: {
      name: workflowName,
      version: "0.1.0-alpha",
      description:
        "Unzip the S&P 500 top-50 SEC archive, write per-company investor reports, and recommend stocks in Markdown.",
    },
    input: {
      schema: {
        type: "object",
        required: ["archivePath", "limit", "riskProfile", "recommendationCount"],
        additionalProperties: false,
        properties: {
          archivePath: { type: "string" },
          limit: { type: "number", minimum: 1, maximum: 50 },
          riskProfile: { type: "string" },
          recommendationCount: { type: "number", minimum: 1, maximum: 10 },
        },
      },
    },
    output: { schema: { type: "string" } },
    permissions: {
      tools: ["sp500.unzip_company_dossiers"],
      models: ["model.worker"],
      secrets: [],
      network: [],
    },
    steps: [
      {
        id: "load-dossiers",
        uses: "tool.call",
        with: { tool: "sp500.unzip_company_dossiers" },
        input: {
          archivePath: "{{ input.archivePath }}",
          limit: "{{ input.limit }}",
        },
        output: { mode: "object", schema: datasetSchema },
      },
      {
        id: "analyze-companies",
        uses: "parallel",
        needs: ["load-dossiers"],
        with: {
          items: "{{ steps.load-dossiers.output.companies }}",
          itemKey: "{{ item.ticker }}",
          maxBranches: 50,
          maxConcurrency: 5,
          failureMode: "fail_fast",
          fanIn: {
            order: "input",
            output: "array",
            outputStep: "write-company-report",
          },
        },
        steps: [
          {
            id: "write-company-report",
            uses: "ai.generate",
            input: {
              company: "{{ item }}",
              riskProfile: "{{ input.riskProfile }}",
            },
            with: {
              model: "model.worker",
              system: COMPANY_REPORT_SYSTEM,
              prompt: COMPANY_REPORT_PROMPT,
            },
            output: { mode: "text" },
          },
        ],
        output: { mode: "array", schema: parallelEnvelopeArraySchema },
      },
      {
        id: "select-recommendations",
        uses: "ai.generate",
        needs: ["load-dossiers", "analyze-companies"],
        input: {
          dataset: "{{ steps.load-dossiers.output }}",
          companyReports: "{{ steps.analyze-companies.output }}",
          recommendationCount: "{{ input.recommendationCount }}",
          riskProfile: "{{ input.riskProfile }}",
        },
        with: {
          model: "model.worker",
          system: FINAL_REPORT_SYSTEM,
          prompt: FINAL_REPORT_PROMPT,
        },
        output: { mode: "text" },
      },
    ],
  };
}

const COMPANY_REPORT_SYSTEM = `\
You are an equity research analyst writing for a public-markets investor.
Use only the provided archive-derived evidence. Do not invent valuation data,
guidance, news, or prices that are not present in the dossier.
Return Markdown only.`;

const COMPANY_REPORT_PROMPT = `\
Write one concise investor report section for this company.

Required Markdown shape:
### TICKER - Company Name
- Rating: BUY, WATCH, or AVOID, with one-sentence rationale.
- Business and index context.
- Financial signals from the XBRL facts.
- Filing evidence with SEC source links.
- Key risks or missing data.

Risk profile: {{ input.riskProfile }}
Company dossier JSON:
{{ input.company }}`;

const FINAL_REPORT_SYSTEM = `\
You are an equity portfolio analyst. Synthesize per-company reports and compact
SEC-derived facts into one investor-facing Markdown report.
Use only provided evidence. Do not provide personalized financial advice.`;

const FINAL_REPORT_PROMPT = `\
Create the final Markdown report.

Required shape:
# S&P 500 Top Companies Investor Report
## Recommended Stocks
Recommend exactly {{ input.recommendationCount }} ticker(s), with ranked rationale.
## Portfolio Notes
Summarize concentration, sector/industry exposure, and data gaps.
## Per-Company Reports
Include or lightly edit every completed company report.
## Source Caveat
Mention that the source archive uses a public S&P 500-by-weight source and SEC EDGAR filings, and that this is not investment advice.

Risk profile: {{ input.riskProfile }}
Dataset JSON:
{{ input.dataset }}
Company report envelopes:
{{ input.companyReports }}`;
