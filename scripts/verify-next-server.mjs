// Qualification helper: retain child diagnostics without changing the readiness or HTTP assertions.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

export async function withNextServer(
  { command, args, cwd, url, logPath, env, attempts = 100, intervalMs = 100 },
  verify,
) {
  const server = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env });
  const limit = 1024 * 1024;
  let stdout = "",
    stderr = "",
    truncated = false,
    terminal = null,
    lastResponse = "No response";
  const append = (old, chunk) => {
    const next = old + chunk.toString();
    if (Buffer.byteLength(next) > limit) {
      truncated = true;
      return next.slice(-limit / 2);
    }
    return next;
  };
  server.stdout?.on("data", (chunk) => {
    stdout = append(stdout, chunk);
  });
  server.stderr?.on("data", (chunk) => {
    stderr = append(stderr, chunk);
  });
  server.once("error", (error) => {
    terminal = { error: error.message };
  });
  const closed = new Promise((resolve) =>
    server.once("close", (code, signal) => {
      terminal = { ...terminal, code, signal };
      resolve();
    }),
  );
  try {
    let ready = false;
    for (let i = 0; i < attempts; i++) {
      if (terminal) break;
      try {
        const response = await fetch(`${url}/little`);
        lastResponse = `HTTP ${response.status}`;
        if (response.ok) {
          ready = true;
          break;
        }
        lastResponse += `: ${(await response.text()).slice(0, 2048)}`;
      } catch (error) {
        lastResponse = `${error.name}: ${error.message}`;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    assert(
      ready,
      `Next server started: ${url}; ${lastResponse}; child=${JSON.stringify(terminal)}\n${(stdout + stderr).slice(-8192)}\nDiagnostics: ${logPath}`,
    );
    await verify();
  } finally {
    if (server.exitCode === null && server.signalCode === null) server.kill("SIGTERM");
    await closed;
    await writeFile(
      logPath,
      JSON.stringify({ url, terminal, lastResponse, truncated }) +
        `\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    );
  }
}
