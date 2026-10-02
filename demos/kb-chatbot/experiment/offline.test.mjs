/**
 * The gate's "no telemetry" guarantee, tested on a plain object instead of `process.env`.
 *
 * What these assert is the whole mechanism: `agents/librarian/littledb.ts` returns `undefined`
 * when `LITTLEDB_URL` is unset, so an environment with no `LITTLEDB_*` keys cannot produce an
 * outcome sink, an event reporter, or an engine run — no matter what the agent code does.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertNoLittleDbEnv, scrubLittleDbEnv, telemetryEnvKeys } from "./offline.mjs";

const populated = () => ({
  LITTLEDB_URL: "http://localhost:3000",
  LITTLEDB_ENGINE_URL: "http://localhost:7878",
  LITTLEDB_HARNESS_ID: "kb-librarian-x",
  LITTLEDB_CHANNEL: "production",
  LITTLEDB_PROJECT_KEY: "secret",
  LIBRARIAN_PROMPT_FILE: "experiment/prompt-v1.md",
  DEEPSEEK_API_KEY: "keep-me",
  PATH: "/usr/bin",
});

describe("scrubLittleDbEnv", () => {
  it("removes every LITTLEDB_ variable, including the project key", () => {
    const env = populated();
    const removed = scrubLittleDbEnv(env);
    assert.equal(
      Object.keys(env).some((key) => key.startsWith("LITTLEDB_")),
      false,
    );
    assert.ok(removed.includes("LITTLEDB_URL"));
    assert.ok(removed.includes("LITTLEDB_PROJECT_KEY"));
  });

  it("removes LIBRARIAN_PROMPT_FILE, which exists only to seed a littleDB bootstrap", () => {
    const env = populated();
    scrubLittleDbEnv(env);
    assert.equal("LIBRARIAN_PROMPT_FILE" in env, false);
  });

  it("leaves everything the agent still needs", () => {
    const env = populated();
    scrubLittleDbEnv(env);
    assert.equal(env.DEEPSEEK_API_KEY, "keep-me");
    assert.equal(env.PATH, "/usr/bin");
  });

  it("is a no-op on an already-clean environment", () => {
    const env = { DEEPSEEK_API_KEY: "k" };
    assert.deepEqual(scrubLittleDbEnv(env), []);
    assert.deepEqual(env, { DEEPSEEK_API_KEY: "k" });
  });
});

describe("assertNoLittleDbEnv", () => {
  it("throws when any telemetry variable survives, and names it", () => {
    assert.throws(
      () => assertNoLittleDbEnv({ LITTLEDB_URL: "http://localhost:3000" }, "after scrubbing"),
      /LITTLEDB_URL.*after scrubbing.*trace plane/s,
    );
  });

  it("throws when only the engine url is set — reporting needs no control plane", () => {
    assert.throws(() => assertNoLittleDbEnv({ LITTLEDB_ENGINE_URL: "http://localhost:7878" }));
  });

  it("throws on a re-seeded bootstrap path", () => {
    assert.throws(() => assertNoLittleDbEnv({ LIBRARIAN_PROMPT_FILE: "x.md" }));
  });

  it("passes on a scrubbed environment", () => {
    const env = populated();
    scrubLittleDbEnv(env);
    assert.doesNotThrow(() => assertNoLittleDbEnv(env, "after loading the agent"));
    assert.deepEqual(telemetryEnvKeys(env), []);
  });
});
