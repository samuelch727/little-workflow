import { scoreCompanyDeterministically } from "./dataset.mjs";

export function renderStubCompanyReport({ company, riskProfile = "balanced" }) {
  const score = scoreCompanyDeterministically(company);
  const rating = ratingForScore(score);
  const latestAnnual = company?.filings?.latestAnnual;
  const latestQuarter = company?.filings?.latestQuarter;

  return [
    `### ${company.ticker} - ${company.name}`,
    "",
    `- **Rating:** ${rating} (${score}/100 deterministic score for ${riskProfile} investors)`,
    `- **Business context:** Rank ${company.rank}; ${company.industry ?? "industry unavailable"}; S&P 500 source weight ${formatPercent(company.weight)}; source price ${formatCurrency(company.price)}.`,
    `- **Financial read:** Revenue ${formatMetric(company.metrics?.revenue)}; net income ${formatMetric(company.metrics?.netIncome)}; liabilities/assets ${formatRatio(company.metrics?.liabilitiesToAssets)}.`,
    `- **Evidence:** latest annual filing ${formatFiling(latestAnnual)}; latest quarterly filing ${formatFiling(latestQuarter)}.`,
    `- **Watch item:** ${watchItemFor(company, score)}`,
  ].join("\n");
}

export function renderStubFinalMarkdown({
  dataset,
  companyReports,
  recommendationCount = 5,
  riskProfile = "balanced",
}) {
  const companies = Array.isArray(dataset?.companies) ? dataset.companies : [];
  const reports = normalizeCompanyReports(companyReports);
  const recommendations = companies
    .map((company) => ({
      company,
      score: scoreCompanyDeterministically(company),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, recommendationCount);

  return [
    "# S&P 500 Top Companies Investor Report",
    "",
    `Generated from the provided SEC PDF archive metadata and XBRL company facts as of ${dataset?.asOfDate ?? "unknown date"}.`,
    `Risk profile: **${riskProfile}**. Not investment advice.`,
    "",
    "## Recommended Stocks",
    "",
    ...recommendations.map(
      ({ company, score }, index) =>
        `${index + 1}. **${company.ticker} - ${company.name}** (${ratingForScore(score)}, score ${score}/100): ${recommendationReason(company)}`,
    ),
    "",
    "## Method",
    "",
    "- The workflow receives the ZIP path as input and calls the unzip-backed `sp500.unzip_company_dossiers` tool.",
    "- The tool verifies the archive shape, reads top holdings, company profiles, filing indexes, and SEC companyfacts, then compacts the evidence for model review.",
    "- The live path asks DeepSeek to write each company report and synthesize recommendations; this stub path uses the same workflow with deterministic scoring.",
    "",
    "## Per-Company Reports",
    "",
    ...reports,
    "",
    "## Source Caveat",
    "",
    "The top-50 ranking comes from the archive's public S&P 500-by-weight source, not an official S&P DJI licensed constituent file. SEC filing evidence comes from EDGAR links stored in the archive. Not investment advice.",
    "",
  ].join("\n");
}

export function normalizeCompanyReports(companyReports) {
  if (!Array.isArray(companyReports)) return [];
  return companyReports
    .map((item) => {
      if (typeof item === "string") return item;
      if (typeof item?.output === "string") return item.output;
      return undefined;
    })
    .filter(Boolean);
}

export function ratingForScore(score) {
  if (score >= 75) return "BUY";
  if (score >= 58) return "WATCH";
  return "AVOID";
}

function recommendationReason(company) {
  const growth = company?.metrics?.revenue?.annualGrowthPct;
  const leverage = company?.metrics?.liabilitiesToAssets?.latestAnnual?.value;
  const parts = [];
  if (typeof growth === "number") parts.push(`revenue growth ${formatPercent(growth)}`);
  if (typeof leverage === "number") parts.push(`liabilities/assets ${formatPercent(leverage * 100)}`);
  if (company?.filings?.latestAnnual?.sourceUrl) parts.push(`latest 10-K evidence available`);
  return parts.length === 0 ? "best deterministic composite score in this run." : parts.join("; ");
}

function watchItemFor(company, score) {
  const growth = company?.metrics?.revenue?.annualGrowthPct;
  if (typeof growth === "number" && growth < 0) {
    return "Revenue contracted in the latest annual comparison; require a stronger turnaround case before adding exposure.";
  }
  const leverage = company?.metrics?.liabilitiesToAssets?.latestAnnual?.value;
  if (typeof leverage === "number" && leverage > 0.65) {
    return "Balance-sheet leverage is elevated relative to this simple screen.";
  }
  if (score >= 75) {
    return "Valuation is not available in the archive, so confirm market multiples before acting.";
  }
  return "Use the report as a screen and validate valuation, guidance, and recent market news separately.";
}

function formatMetric(metric) {
  const latest = metric?.latestAnnual ?? metric?.latest;
  if (latest?.value === undefined) return "unavailable";
  const growth =
    typeof metric.annualGrowthPct === "number"
      ? ` (${formatPercent(metric.annualGrowthPct)} annual growth)`
      : "";
  return `${formatLargeNumber(latest.value)} ${latest.unit ?? metric.unit ?? ""}`.trim() + growth;
}

function formatRatio(metric) {
  const value = metric?.latestAnnual?.value;
  return typeof value === "number" ? formatPercent(value * 100) : "unavailable";
}

function formatFiling(filing) {
  if (filing === undefined) return "unavailable";
  const date = filing.filingDate ?? "unknown date";
  return filing.sourceUrl === undefined ? `${filing.form} filed ${date}` : `[${filing.form} filed ${date}](${filing.sourceUrl})`;
}

function formatLargeNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unavailable";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${round(value / 1_000_000_000, 2)}B`;
  if (abs >= 1_000_000) return `${round(value / 1_000_000, 2)}M`;
  if (abs >= 1_000) return `${round(value / 1_000, 2)}K`;
  return String(round(value, 2));
}

function formatPercent(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${round(value, 2)}%` : "unavailable";
}

function formatCurrency(value) {
  return typeof value === "number" && Number.isFinite(value) ? `$${round(value, 2)}` : "unavailable";
}

function round(value, places = 2) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
