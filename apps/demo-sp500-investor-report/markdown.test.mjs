import test from "node:test";
import assert from "node:assert/strict";
import {
  renderStubCompanyReport,
  renderStubFinalMarkdown,
} from "./markdown.mjs";

test("stub markdown includes per-company report, recommendation section, and source caveat", () => {
  const alpha = {
    rank: 1,
    ticker: "AAA",
    name: "Alpha Inc",
    weight: 7.5,
    price: 100,
    industry: "Application Software",
    metrics: {
      revenue: { latestAnnual: { value: 1300, unit: "USD", fy: 2025 }, annualGrowthPct: 30 },
      netIncome: { latestAnnual: { value: 260, unit: "USD", fy: 2025 } },
      liabilitiesToAssets: { latestAnnual: { value: 0.3, fy: 2025 } },
    },
    filings: {
      latestAnnual: { form: "10-K", filingDate: "2026-02-12", sourceUrl: "https://sec.gov/a" },
      latestQuarter: { form: "10-Q", filingDate: "2026-04-28", sourceUrl: "https://sec.gov/q" },
    },
    evidence: [{ form: "10-K", filingDate: "2026-02-12", sourceUrl: "https://sec.gov/a" }],
  };

  const beta = {
    ...alpha,
    rank: 2,
    ticker: "BBB",
    name: "Beta Corp",
    metrics: {
      revenue: { latestAnnual: { value: 810, unit: "USD", fy: 2025 }, annualGrowthPct: -10 },
      netIncome: { latestAnnual: { value: 40, unit: "USD", fy: 2025 } },
      liabilitiesToAssets: { latestAnnual: { value: 0.7, fy: 2025 } },
    },
  };

  const companyReports = [
    renderStubCompanyReport({ company: alpha, riskProfile: "balanced" }),
    renderStubCompanyReport({ company: beta, riskProfile: "balanced" }),
  ];
  const markdown = renderStubFinalMarkdown({
    dataset: { companies: [alpha, beta], asOfDate: "2026-05-25" },
    companyReports,
    recommendationCount: 1,
    riskProfile: "balanced",
  });

  assert.match(markdown, /^# S&P 500 Top Companies Investor Report/mu);
  assert.match(markdown, /## Recommended Stocks/mu);
  assert.match(markdown, /AAA/u);
  assert.match(markdown, /## Per-Company Reports/mu);
  assert.match(markdown, /Not investment advice/u);
});
