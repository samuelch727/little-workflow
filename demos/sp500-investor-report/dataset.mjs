import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_UNZIP_COMMAND = "unzip";
const MAX_EXEC_BUFFER = 128 * 1024 * 1024;
const DATA_RANGE = {
  from: "2023-05-25",
  to: "2026-05-25",
};

const METRIC_DEFINITIONS = {
  revenue: {
    label: "Revenue",
    aliases: [
      "RevenueFromContractWithCustomerExcludingAssessedTax",
      "Revenues",
      "SalesRevenueNet",
    ],
    namespaces: ["us-gaap"],
    units: ["USD"],
  },
  netIncome: {
    label: "Net income",
    aliases: ["NetIncomeLoss", "ProfitLoss"],
    namespaces: ["us-gaap"],
    units: ["USD"],
  },
  operatingIncome: {
    label: "Operating income",
    aliases: ["OperatingIncomeLoss"],
    namespaces: ["us-gaap"],
    units: ["USD"],
  },
  assets: {
    label: "Assets",
    aliases: ["Assets"],
    namespaces: ["us-gaap"],
    units: ["USD"],
  },
  liabilities: {
    label: "Liabilities",
    aliases: ["Liabilities"],
    namespaces: ["us-gaap"],
    units: ["USD"],
  },
  operatingCashFlow: {
    label: "Operating cash flow",
    aliases: [
      "NetCashProvidedByUsedInOperatingActivities",
      "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
    ],
    namespaces: ["us-gaap"],
    units: ["USD"],
  },
  dilutedEps: {
    label: "Diluted EPS",
    aliases: ["EarningsPerShareDiluted"],
    namespaces: ["us-gaap"],
    units: ["USD/shares", "USD/share"],
  },
  sharesOutstanding: {
    label: "Shares outstanding",
    aliases: ["EntityCommonStockSharesOutstanding"],
    namespaces: ["dei"],
    units: ["shares"],
  },
};

export async function loadCompanyDossiers({
  archivePath,
  limit = 50,
  unzipCommand = DEFAULT_UNZIP_COMMAND,
} = {}) {
  if (typeof archivePath !== "string" || archivePath.length === 0) {
    throw new TypeError("archivePath is required.");
  }

  const source = await createDatasetSource({ archivePath, unzipCommand });
  const boundedLimit = clampInteger(limit, 1, 50);
  const [topHoldings, companySummary] = await Promise.all([
    source.readJsonBySuffix("top50_holdings.json"),
    source.readJsonBySuffix("company_summary.json"),
  ]);

  if (!Array.isArray(topHoldings)) {
    throw new TypeError("top50_holdings.json must contain an array.");
  }
  if (!Array.isArray(companySummary)) {
    throw new TypeError("company_summary.json must contain an array.");
  }

  const profileEntries = source.entries.filter((entry) =>
    entry.includes("/companies/") && entry.endsWith("/company_profile.json"),
  );
  const profileRecords = await Promise.all(
    profileEntries.map(async (entry) => ({
      entry,
      directory: entry.slice(0, -"company_profile.json".length).replace(/\/$/u, ""),
      profile: await source.readJson(entry),
    })),
  );

  const profilesByTicker = new Map();
  const profilesByRank = new Map();
  for (const record of profileRecords) {
    const ticker = stringValue(record.profile?.sourceRank?.ticker) ?? stringValue(record.profile?.sec?.ticker);
    const rank = numberValue(record.profile?.sourceRank?.rank);
    if (ticker !== undefined) profilesByTicker.set(ticker, record);
    if (rank !== undefined) profilesByRank.set(rank, record);
  }

  const summaryByTicker = new Map(
    companySummary
      .map((row) => [stringValue(row?.ticker), row])
      .filter(([ticker]) => ticker !== undefined),
  );

  const companies = [];
  for (const holding of topHoldings.slice(0, boundedLimit)) {
    const ticker = stringValue(holding?.ticker);
    const rank = numberValue(holding?.rank);
    const profileRecord =
      (ticker === undefined ? undefined : profilesByTicker.get(ticker)) ??
      (rank === undefined ? undefined : profilesByRank.get(rank));
    if (ticker === undefined || rank === undefined || profileRecord === undefined) {
      continue;
    }

    const [filingsIndex, companyFacts] = await Promise.all([
      source.readJson(`${profileRecord.directory}/filings_index.json`),
      source.readJson(`${profileRecord.directory}/sec_companyfacts.json`),
    ]);
    const summary = summaryByTicker.get(ticker) ?? {};
    companies.push(
      cleanJson(
        buildDossier({
          holding,
          profile: profileRecord.profile,
          summary,
          filingsIndex: Array.isArray(filingsIndex) ? filingsIndex : [],
          companyFacts,
        }),
      ),
    );
  }

  return {
    source: source.describe(),
    asOfDate: DATA_RANGE.to,
    dataRange: DATA_RANGE,
    companyCount: companies.length,
    companies,
  };
}

export async function assertUnzipAvailable(unzipCommand = DEFAULT_UNZIP_COMMAND) {
  try {
    await execFileAsync(unzipCommand, ["-v"], { maxBuffer: 1024 * 1024 });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`unzip command is not available: ${unzipCommand}`);
    }
    throw error;
  }
}

async function createDatasetSource({ archivePath, unzipCommand }) {
  const archiveStat = await stat(archivePath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error(`Dataset archive not found: ${archivePath}`);
    }
    throw error;
  });

  if (archiveStat.isDirectory()) {
    const entries = await listDirectoryEntries(archivePath);
    return {
      entries,
      async readJson(entry) {
        return JSON.parse(await readFile(join(archivePath, entry), "utf8"));
      },
      async readJsonBySuffix(suffix) {
        const entry = findEntryBySuffix(entries, suffix);
        return this.readJson(entry);
      },
      describe() {
        return {
          kind: "directory",
          archivePath,
          entryCount: entries.length,
        };
      },
    };
  }

  await assertUnzipAvailable(unzipCommand);
  const entries = await listZipEntries({ archivePath, unzipCommand });
  return {
    entries,
    async readJson(entry) {
      return JSON.parse(await readZipEntryText({ archivePath, entry, unzipCommand }));
    },
    async readJsonBySuffix(suffix) {
      const entry = findEntryBySuffix(entries, suffix);
      return this.readJson(entry);
    },
    describe() {
      return {
        kind: "zip",
        archivePath,
        unzipCommand,
        entryCount: entries.length,
      };
    },
  };
}

async function listZipEntries({ archivePath, unzipCommand }) {
  try {
    const { stdout } = await execFileAsync(unzipCommand, ["-Z", "-1", archivePath], {
      maxBuffer: MAX_EXEC_BUFFER,
    });
    return stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.endsWith("/"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`unzip command is not available: ${unzipCommand}`);
    }
    throw new Error(`Unable to list dataset zip entries: ${errorMessage(error)}`);
  }
}

async function readZipEntryText({ archivePath, entry, unzipCommand }) {
  try {
    const { stdout } = await execFileAsync(unzipCommand, ["-p", archivePath, entry], {
      maxBuffer: MAX_EXEC_BUFFER,
    });
    return stdout;
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`unzip command is not available: ${unzipCommand}`);
    }
    throw new Error(`Unable to read '${entry}' from dataset zip: ${errorMessage(error)}`);
  }
}

async function listDirectoryEntries(root) {
  const entries = [];
  await walk(root, "");
  return entries;

  async function walk(base, prefix) {
    const dirents = await readdir(base, { withFileTypes: true });
    for (const dirent of dirents) {
      const rel = prefix.length === 0 ? dirent.name : `${prefix}/${dirent.name}`;
      const fullPath = join(base, dirent.name);
      if (dirent.isDirectory()) {
        await walk(fullPath, rel);
      } else if (dirent.isFile()) {
        entries.push(rel.split(sep).join("/"));
      }
    }
  }
}

function findEntryBySuffix(entries, suffix) {
  const normalizedSuffix = suffix.replace(/^\/+/u, "");
  const matches = entries.filter(
    (entry) => entry === normalizedSuffix || entry.endsWith(`/${normalizedSuffix}`),
  );
  if (matches.length === 0) {
    throw new Error(`Dataset entry not found: ${suffix}`);
  }
  return matches.sort((left, right) => left.length - right.length)[0];
}

function buildDossier({ holding, profile, summary, filingsIndex, companyFacts }) {
  const filings = summarizeFilings(filingsIndex);
  const metrics = summarizeFacts(companyFacts);
  const rank = numberValue(holding.rank) ?? numberValue(profile?.sourceRank?.rank);
  const ticker = stringValue(holding.ticker) ?? stringValue(profile?.sourceRank?.ticker);
  const name = stringValue(holding.name) ?? stringValue(profile?.sourceRank?.name);
  const weight = numberValue(holding.weight);
  const price = numberValue(holding.price);
  const industry = stringValue(profile?.sec?.sicDescription);
  const exchange = stringValue(profile?.sec?.exchange);
  const cik = stringValue(summary?.cik) ?? stringValue(profile?.sec?.cik);

  return {
    rank,
    ticker,
    name,
    cik,
    exchange,
    industry,
    fiscalYearEnd: stringValue(profile?.sec?.fiscalYearEnd),
    weight,
    price,
    downloadedFilings: numberValue(summary?.downloadedFilings),
    failedFilings: numberValue(summary?.failedFilings),
    factsStatus: stringValue(summary?.factsStatus) ?? stringValue(profile?.sec?.factsStatus),
    filings,
    metrics,
    evidence: [
      filings.latestAnnual,
      filings.latestQuarter,
      filings.latestProxy,
      ...filings.recent.slice(0, 2),
    ]
      .filter(Boolean)
      .map(compactFiling),
  };
}

function summarizeFilings(filingsIndex) {
  const filings = filingsIndex
    .filter((filing) => filing?.status === undefined || filing.status === "downloaded")
    .map(compactFiling)
    .sort(compareByFilingDateDesc);
  const countsByForm = {};
  for (const filing of filings) {
    countsByForm[filing.form] = (countsByForm[filing.form] ?? 0) + 1;
  }
  return {
    count: filings.length,
    countsByForm,
    latestAnnual: filings.find((filing) => /^10-K/u.test(filing.form)),
    latestQuarter: filings.find((filing) => /^10-Q/u.test(filing.form)),
    latestProxy: filings.find((filing) => /^DEF/u.test(filing.form)),
    recent: filings.slice(0, 8),
  };
}

function compactFiling(filing) {
  if (filing === undefined || filing === null) return undefined;
  return {
    form: stringValue(filing.form) ?? "unknown",
    filingDate: stringValue(filing.filingDate),
    reportDate: stringValue(filing.reportDate),
    accessionNumber: stringValue(filing.accessionNumber),
    sourceUrl: stringValue(filing.sourceUrl),
    localPath: stringValue(filing.localPath),
  };
}

function summarizeFacts(companyFacts) {
  const metrics = {};
  for (const [key, definition] of Object.entries(METRIC_DEFINITIONS)) {
    metrics[key] = extractMetric(companyFacts, definition);
  }

  const assets = metrics.assets?.latestAnnual?.value ?? metrics.assets?.latest?.value;
  const liabilities = metrics.liabilities?.latestAnnual?.value ?? metrics.liabilities?.latest?.value;
  metrics.liabilitiesToAssets = {
    label: "Liabilities / assets",
    latestAnnual:
      typeof assets === "number" && assets !== 0 && typeof liabilities === "number"
        ? {
            value: round(liabilities / assets, 4),
            fy: metrics.assets?.latestAnnual?.fy ?? metrics.liabilities?.latestAnnual?.fy,
          }
        : undefined,
  };

  return metrics;
}

function extractMetric(companyFacts, definition) {
  const concept = findConcept(companyFacts, definition);
  if (concept === undefined) {
    return { label: definition.label, available: false };
  }
  const facts = concept.facts
    .map(normalizeFact)
    .filter((fact) => fact !== undefined)
    .filter((fact) => fact.filed === undefined || isWithinDataRange(fact.filed))
    .sort(compareFactsDesc);
  const annualFacts = facts.filter((fact) => /^10-K/u.test(fact.form ?? "") && fact.fp === "FY");
  const quarterlyFacts = facts.filter((fact) => /^10-Q/u.test(fact.form ?? ""));
  const latestAnnual = annualFacts[0];
  const previousAnnual = annualFacts.find((fact) => fact !== latestAnnual && fact.value !== undefined);
  return {
    label: definition.label,
    available: facts.length > 0,
    concept: concept.name,
    unit: concept.unit,
    latest: facts[0],
    latestAnnual,
    latestQuarter: quarterlyFacts[0],
    annualGrowthPct:
      latestAnnual?.value !== undefined && previousAnnual?.value !== undefined
        ? percentChange(latestAnnual.value, previousAnnual.value)
        : undefined,
  };
}

function findConcept(companyFacts, definition) {
  for (const namespace of definition.namespaces) {
    const factsNamespace = companyFacts?.facts?.[namespace];
    if (factsNamespace === undefined || typeof factsNamespace !== "object") continue;
    for (const alias of definition.aliases) {
      const concept = factsNamespace[alias];
      if (concept === undefined || concept?.units === undefined) continue;
      const unit = definition.units.find((candidate) => Array.isArray(concept.units[candidate]));
      const resolvedUnit = unit ?? Object.keys(concept.units)[0];
      const facts = Array.isArray(concept.units[resolvedUnit]) ? concept.units[resolvedUnit] : [];
      return { name: alias, unit: resolvedUnit, facts };
    }
  }
  return undefined;
}

function normalizeFact(fact) {
  const value = numberValue(fact?.val);
  if (value === undefined) return undefined;
  return {
    value,
    start: stringValue(fact.start),
    end: stringValue(fact.end),
    fy: numberValue(fact.fy),
    fp: stringValue(fact.fp),
    form: stringValue(fact.form),
    filed: stringValue(fact.filed),
  };
}

export function scoreCompanyDeterministically(company) {
  const revenueGrowth = numberValue(company?.metrics?.revenue?.annualGrowthPct);
  const revenue = numberValue(company?.metrics?.revenue?.latestAnnual?.value);
  const netIncome = numberValue(company?.metrics?.netIncome?.latestAnnual?.value);
  const leverage = numberValue(company?.metrics?.liabilitiesToAssets?.latestAnnual?.value);
  const cashFlow = numberValue(company?.metrics?.operatingCashFlow?.latestAnnual?.value);
  const weight = numberValue(company?.weight);

  let score = 50;
  if (revenueGrowth !== undefined) score += clamp(revenueGrowth / 2, -18, 22);
  if (revenue !== undefined && revenue !== 0 && netIncome !== undefined) {
    score += clamp((netIncome / Math.abs(revenue)) * 100, -12, 18);
  }
  if (leverage !== undefined) score += clamp((0.65 - leverage) * 30, -12, 12);
  if (cashFlow !== undefined) score += cashFlow >= 0 ? 5 : -8;
  if (weight !== undefined) score += clamp(weight / 2, 0, 8);

  return Math.round(clamp(score, 0, 100));
}

function compareByFilingDateDesc(left, right) {
  return String(right.filingDate ?? "").localeCompare(String(left.filingDate ?? ""));
}

function compareFactsDesc(left, right) {
  const byEnd = String(right.end ?? "").localeCompare(String(left.end ?? ""));
  if (byEnd !== 0) return byEnd;
  return String(right.filed ?? "").localeCompare(String(left.filed ?? ""));
}

function isWithinDataRange(date) {
  return date >= DATA_RANGE.from && date <= DATA_RANGE.to;
}

function percentChange(current, previous) {
  if (previous === 0) return undefined;
  return round(((current - previous) / Math.abs(previous)) * 100, 2);
}

function clampInteger(value, min, max) {
  const number = numberValue(value) ?? max;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function stringValue(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function cleanJson(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map(cleanJson).filter((item) => item !== undefined);
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, entryValue]) => [key, cleanJson(entryValue)])
        .filter(([, entryValue]) => entryValue !== undefined),
    );
  }
  return value;
}
