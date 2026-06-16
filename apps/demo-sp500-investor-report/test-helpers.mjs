import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createSp500ZipFixture() {
  const tempDir = await mkdtemp(join(tmpdir(), "sp500-investor-fixture-"));
  const root = join(tempDir, "sp500_fixture");
  await mkdir(join(root, "companies", "01_AAA_Alpha_Inc"), { recursive: true });
  await mkdir(join(root, "companies", "02_BBB_Beta_Corp"), { recursive: true });

  await writeJson(join(root, "top50_holdings.json"), [
    { rank: 1, name: "Alpha Inc", ticker: "AAA", weight: "7.50", price: "100.00" },
    { rank: 2, name: "Beta Corp", ticker: "BBB", weight: "2.25", price: "50.00" },
  ]);
  await writeJson(join(root, "company_summary.json"), [
    {
      rank: 1,
      ticker: "AAA",
      name: "Alpha Inc",
      secTicker: "AAA",
      cik: "0000000001",
      downloadedFilings: 3,
      failedFilings: 0,
      factsStatus: "downloaded",
    },
    {
      rank: 2,
      ticker: "BBB",
      name: "Beta Corp",
      secTicker: "BBB",
      cik: "0000000002",
      downloadedFilings: 2,
      failedFilings: 0,
      factsStatus: "downloaded",
    },
  ]);

  await writeCompanyFixture(root, {
    directory: "01_AAA_Alpha_Inc",
    rank: 1,
    ticker: "AAA",
    name: "Alpha Inc",
    cik: "0000000001",
    sicDescription: "Application Software",
    revenue2024: 1000,
    revenue2025: 1300,
    netIncome2025: 260,
    assets2025: 4000,
    liabilities2025: 1200,
  });
  await writeCompanyFixture(root, {
    directory: "02_BBB_Beta_Corp",
    rank: 2,
    ticker: "BBB",
    name: "Beta Corp",
    cik: "0000000002",
    sicDescription: "Semiconductors",
    revenue2024: 900,
    revenue2025: 810,
    netIncome2025: 40,
    assets2025: 3000,
    liabilities2025: 2100,
  });

  const archivePath = join(tempDir, "sp500_fixture.zip");
  execFileSync("zip", ["-qr", archivePath, "sp500_fixture"], { cwd: tempDir });

  return {
    archivePath,
    cleanup: () => rm(tempDir, { recursive: true, force: true }),
  };
}

async function writeCompanyFixture(root, options) {
  const companyDir = join(root, "companies", options.directory);
  await writeJson(join(companyDir, "company_profile.json"), {
    collectedAt: "2026-05-25T12:00:00.000Z",
    sourceRank: {
      rank: options.rank,
      name: options.name,
      ticker: options.ticker,
      weight: options.rank === 1 ? "7.50" : "2.25",
      price: options.rank === 1 ? "100.00" : "50.00",
    },
    sec: {
      cik: options.cik,
      ticker: options.ticker,
      exchange: "NYSE",
      entityName: options.name.toUpperCase(),
      sic: "7372",
      sicDescription: options.sicDescription,
      fiscalYearEnd: "1231",
      factsStatus: "downloaded",
    },
  });
  await writeJson(join(companyDir, "filings_index.json"), [
    filing(options, "2025-02-10", "2024-12-31", "10-K"),
    filing(options, "2026-02-12", "2025-12-31", "10-K"),
    filing(options, "2026-04-28", "2026-03-31", "10-Q"),
  ]);
  await writeJson(join(companyDir, "sec_companyfacts.json"), {
    cik: Number(options.cik),
    entityName: options.name.toUpperCase(),
    facts: {
      "us-gaap": {
        Revenues: {
          units: {
            USD: [
              annualFact(2024, options.revenue2024),
              annualFact(2025, options.revenue2025),
              quarterlyFact(2026, "Q1", Math.round(options.revenue2025 / 4)),
            ],
          },
        },
        NetIncomeLoss: {
          units: {
            USD: [
              annualFact(2024, Math.round(options.netIncome2025 * 0.8)),
              annualFact(2025, options.netIncome2025),
            ],
          },
        },
        Assets: {
          units: {
            USD: [instantFact(2025, options.assets2025, "10-K")],
          },
        },
        Liabilities: {
          units: {
            USD: [instantFact(2025, options.liabilities2025, "10-K")],
          },
        },
        NetCashProvidedByUsedInOperatingActivities: {
          units: {
            USD: [annualFact(2025, Math.round(options.netIncome2025 * 1.2))],
          },
        },
      },
      dei: {
        EntityCommonStockSharesOutstanding: {
          units: {
            shares: [instantFact(2025, 1000000, "10-K")],
          },
        },
      },
    },
  });
}

function filing(options, filingDate, reportDate, form) {
  return {
    sourceRank: options.rank,
    ticker: options.ticker,
    companyName: options.name,
    cik: options.cik,
    accessionNumber: `000000000${options.rank}-26-000001`,
    filingDate,
    reportDate,
    form,
    sourceUrl: `https://www.sec.gov/Archives/edgar/data/${Number(options.cik)}/${form.toLowerCase()}.htm`,
    localPath: `companies/${options.directory}/filings/${filingDate}_${form}_${options.ticker}.pdf`,
    status: "downloaded",
    storedDocumentFormat: "pdf",
  };
}

function annualFact(fy, val) {
  return {
    start: `${fy}-01-01`,
    end: `${fy}-12-31`,
    val,
    fy,
    fp: "FY",
    form: "10-K",
    filed: `${fy + 1}-02-15`,
  };
}

function quarterlyFact(fy, fp, val) {
  return {
    start: `${fy}-01-01`,
    end: `${fy}-03-31`,
    val,
    fy,
    fp,
    form: "10-Q",
    filed: `${fy}-04-25`,
  };
}

function instantFact(fy, val, form) {
  return {
    end: `${fy}-12-31`,
    val,
    fy,
    fp: "FY",
    form,
    filed: `${fy + 1}-02-15`,
  };
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
