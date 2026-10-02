import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

test("invalid variant exits cleanly without stack trace", () => {
  const result = spawnSync(
    process.execPath,
    [join(here, "run.mjs"), "invalid"],
    {
      cwd: here,
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown variant/u);
  assert.doesNotMatch(result.stderr, /at parseVariant/u);
});

test("single variant requires DEEPSEEK_API_KEY", () => {
  const env = { ...process.env };
  delete env.DEEPSEEK_API_KEY;
  delete env.OPENAI_API_KEY;

  const result = spawnSync(
    process.execPath,
    [join(here, "run.mjs"), "single"],
    {
      cwd: here,
      encoding: "utf8",
      env,
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Set DEEPSEEK_API_KEY to run this demo\./u);
});

test("stub variant runs without provider API keys", () => {
  const env = { ...process.env };
  delete env.DEEPSEEK_API_KEY;
  delete env.OPENAI_API_KEY;

  const result = spawnSync(
    process.execPath,
    [join(here, "run.mjs"), "stub"],
    {
      cwd: here,
      encoding: "utf8",
      env,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /=== Final Output ===/u);
  assert.match(result.stdout, /Stub deterministic score/u);
});
