import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

test("remote-resume: kill-and-resume via the remote session log", async () => {
  const runScript = fileURLToPath(new URL("./run.mjs", import.meta.url));
  const child = spawn(process.execPath, [runScript], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const code = await new Promise((resolve) => {
    child.on("exit", (exitCode) => resolve(exitCode));
  });
  assert.equal(code, 0, `demo failed:\n${output}`);
  assert.match(output, /All checks passed/u);
});
