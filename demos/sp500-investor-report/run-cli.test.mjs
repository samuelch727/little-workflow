import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSp500ZipFixture } from "./test-helpers.mjs";

const here = dirname(fileURLToPath(import.meta.url));

test("invalid variant exits cleanly without a stack trace", () => {
  const result = spawnSync(process.execPath, [join(here, "run.mjs"), "invalid"], {
    cwd: here,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown variant/u);
  assert.doesNotMatch(result.stderr, /at parseArgs/u);
});

test("live variant requires DEEPSEEK_API_KEY before running the workflow", () => {
  const env = { ...process.env };
  delete env.DEEPSEEK_API_KEY;

  const result = spawnSync(
    process.execPath,
    [join(here, "run.mjs"), "live", "--archive", "/tmp/missing.zip"],
    { cwd: here, encoding: "utf8", env },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Set DEEPSEEK_API_KEY to run this demo\./u);
});

test("stub variant runs the workflow against a zip fixture and prints markdown", async () => {
  const fixture = await createSp500ZipFixture();
  try {
    const result = spawnSync(
      process.execPath,
      [
        join(here, "run.mjs"),
        "stub",
        "--archive",
        fixture.archivePath,
        "--limit",
        "2",
        "--recommendations",
        "1",
      ],
      { cwd: here, encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /# S&P 500 Top Companies Investor Report/u);
    assert.match(result.stdout, /## Recommended Stocks/u);
    assert.match(result.stdout, /AAA/u);
    assert.match(result.stdout, /Unzip tool:/u);
  } finally {
    await fixture.cleanup();
  }
});
