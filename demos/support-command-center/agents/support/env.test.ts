import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { loadSupportEnv, resolveSupportModelConfig } from "./env";

const touched: string[] = [];

function clearSupportEnv(): void {
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_MODEL_ID;
  delete process.env.DEEPSEEK_BASE_URL;
  delete process.env.SUPPORT_COMMAND_CENTER_ENV_FILE;
}

// Clear before each test too, so an ambient DEEPSEEK_* (e.g. exported per the README setup, or a
// repo .env.local) cannot make these env-loading assertions non-deterministic.
beforeEach(clearSupportEnv);

afterEach(async () => {
  clearSupportEnv();
  await Promise.all(touched.map((path) => rm(path, { recursive: true, force: true })));
});

test("loadSupportEnv reads a dotenv candidate without returning secret values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "support-env-"));
  touched.push(dir);
  const file = join(dir, ".env.local");
  await writeFile(file, "DEEPSEEK_API_KEY=secret-demo-key\nDEEPSEEK_MODEL_ID=deepseek-v4-pro\n");

  const loaded = await loadSupportEnv([file]);

  expect(loaded.loaded).toBe(true);
  expect(loaded.paths).toEqual([file]);
  expect(loaded.keys).toEqual(["DEEPSEEK_API_KEY", "DEEPSEEK_MODEL_ID"]);
  expect(JSON.stringify(loaded)).not.toContain("secret-demo-key");
});

test("loadSupportEnv merges all candidates: nearest file wins per key, process.env always wins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "support-env-merge-"));
  touched.push(dir);
  const near = join(dir, "near.env.local");
  const far = join(dir, "far.env.local");
  // `export` prefix is supported; the nearer file only sets the API key, the farther file adds a
  // model id AND tries to override the API key (which the nearer file already won).
  await writeFile(near, "export DEEPSEEK_API_KEY=near-key\n");
  await writeFile(far, "DEEPSEEK_API_KEY=far-key\nDEEPSEEK_MODEL_ID=deepseek-v4-flash\n");
  process.env.DEEPSEEK_BASE_URL = "https://preset.example/v1";

  const loaded = await loadSupportEnv([near, far]);

  expect(loaded.paths).toEqual([near, far]);
  // API key: nearest file wins; model id: filled by the farther file; base url: process.env wins.
  expect(loaded.keys).toEqual(["DEEPSEEK_API_KEY", "DEEPSEEK_MODEL_ID"]);
  expect(process.env.DEEPSEEK_API_KEY).toBe("near-key");
  expect(process.env.DEEPSEEK_MODEL_ID).toBe("deepseek-v4-flash");
  expect(process.env.DEEPSEEK_BASE_URL).toBe("https://preset.example/v1");
});

test("loadSupportEnv trims trailing whitespace from unquoted dotenv values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "support-env-trim-"));
  touched.push(dir);
  const file = join(dir, ".env.local");
  await writeFile(file, "DEEPSEEK_API_KEY=secret-demo-key   \nDEEPSEEK_MODEL_ID='deepseek-v4-pro  '\n");

  await loadSupportEnv([file]);

  expect(process.env.DEEPSEEK_API_KEY).toBe("secret-demo-key");
  expect(process.env.DEEPSEEK_MODEL_ID).toBe("deepseek-v4-pro  ");
});

test("resolveSupportModelConfig defaults to deepseek v4 pro endpoint", () => {
  process.env.DEEPSEEK_API_KEY = "secret";

  const config = resolveSupportModelConfig();

  expect(config.modelId).toBe("deepseek-v4-pro");
  expect(config.baseURL).toBe("https://api.deepseek.com/v1");
});

test("loadSupportEnv can use an explicit env file override", async () => {
  const dir = await mkdtemp(join(tmpdir(), "support-env-override-"));
  touched.push(dir);
  const file = join(dir, ".env.local");
  await writeFile(file, "DEEPSEEK_API_KEY=override-key\n");
  process.env.SUPPORT_COMMAND_CENTER_ENV_FILE = file;

  const loaded = await loadSupportEnv();

  expect(loaded.loaded).toBe(true);
  // The explicit override is consulted first (nearest), so its key wins.
  expect(loaded.paths[0]).toBe(file);
  expect(loaded.keys).toContain("DEEPSEEK_API_KEY");
  expect(process.env.DEEPSEEK_API_KEY).toBe("override-key");
});
