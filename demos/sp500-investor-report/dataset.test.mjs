import test from "node:test";
import assert from "node:assert/strict";
import { createSp500ZipFixture } from "./test-helpers.mjs";
import { loadCompanyDossiers } from "./dataset.mjs";

test("loads compact investor dossiers directly from a zip through unzip", async () => {
  const fixture = await createSp500ZipFixture();
  try {
    const result = await loadCompanyDossiers({
      archivePath: fixture.archivePath,
      limit: 2,
      unzipCommand: "/usr/bin/unzip",
    });

    assert.equal(result.source.kind, "zip");
    assert.equal(result.source.archivePath, fixture.archivePath);
    assert.equal(result.companies.length, 2);
    assert.deepEqual(result.companies.map((company) => company.ticker), ["AAA", "BBB"]);
    assert.equal(result.companies[0].filings.latestAnnual.form, "10-K");
    assert.equal(result.companies[0].filings.latestQuarter.form, "10-Q");
    assert.equal(result.companies[0].metrics.revenue.latestAnnual.value, 1300);
    assert.equal(result.companies[0].metrics.revenue.annualGrowthPct, 30);
    assert.equal(result.companies[0].metrics.liabilitiesToAssets.latestAnnual.value, 0.3);
    assert.match(result.companies[0].evidence[0].sourceUrl, /sec\.gov/u);
  } finally {
    await fixture.cleanup();
  }
});

test("reports a clear setup error when unzip is unavailable", async () => {
  const fixture = await createSp500ZipFixture();
  try {
    await assert.rejects(
      () =>
        loadCompanyDossiers({
          archivePath: fixture.archivePath,
          limit: 1,
          unzipCommand: "definitely-not-unzip",
        }),
      /unzip command is not available/u,
    );
  } finally {
    await fixture.cleanup();
  }
});
