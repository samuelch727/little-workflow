// Genuine self-hosted workerd, no Wrangler emulator, provider key, LittleDB or outbound network.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { InMemoryFs } from "just-bash";
import { generateHarness, loadHarness, virtualHost } from "@little-stack/harness";
const root = fileURLToPath(new URL("..", import.meta.url));
const workerd = createRequire(import.meta.url)("workerd").default;
let directory, config, port, running;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "workerd-folders-"));
  execFileSync(process.execPath, ["compile.mjs"], { cwd: root, stdio: "pipe" });
  execFileSync(join(root, "node_modules/.bin/wrangler"), ["deploy", "--dry-run", "--outdir", "dist"], {
    cwd: root, stdio: "pipe", env: { ...process.env, XDG_CONFIG_HOME: join(directory, "config"), WRANGLER_SEND_METRICS: "false" },
  });
  await copyFile(join(root, "dist/worker.js"), join(directory, "worker.js"));
  config = join(directory, "test.capnp");
  await writeFile(config, (await readFile(join(root, "workerd.capnp"), "utf8")).replace('embed "dist/worker.js"', 'embed "worker.js"'));
  port = await freePort(); running = await serve();
});
after(async () => { await stop(); if (directory) await rm(directory, { recursive: true, force: true }); });

test("discovered tools and instructions match the Node loader on the same folder", async () => {
  const node = await loadHarness(join(root, "agents/support"), { host: virtualHost({ fs: new InMemoryFs() }) });
  const message = text => [{ id: "test", role: "user", parts: [{ type: "text", text }] }];
  for (const text of ["count:one two three", "system"]) {
    const result = await generateHarness({ harness: node, session: text, messages: message(text) });
    assert.equal(result.status, "completed");
    const actual = (await post("parity", text)).reply;
    if (text === "system") {
      // Runtime capability instructions intentionally differ: Node supports js-exec, workerd does not.
      const authored = prompt => prompt.split("\n\nThe harness filesystem exposes")[0];
      assert.equal(authored(actual), authored(result.text));
      assert.match(actual, /not available in this shell/);
    } else assert.equal(actual, result.text);
  }
});
test("bundled SKILL.md and nested UTF-8 assets are available to real bash offline", async () => {
  const result = await bash("skill", "cat /.agents/skills/guide/SKILL.md; cat /.agents/skills/guide/assets/note.txt");
  assert.equal(result.exitCode, 0); assert.match(result.stdout, /bundled offline support guide/); assert.match(result.stdout, /繁體中文 offline guide/);
  assert.match((await post("catalog", "system")).reply, /guide/);
});
test("chat-local factory closures and same-chat queues remain isolated", async () => {
  const a = await post("a", "counter"), b = await post("b", "counter");
  assert.equal(output(a), 1); assert.equal(output(b), 1);
  assert.deepEqual((await Promise.all([post("a", "counter"), post("a", "counter")])).map(output).sort(), [2, 3]);
  const intervals = (await Promise.all([post("a", "pause:50"), post("a", "pause:50")])).map(output).sort((a, b) => a.started - b.started);
  assert.ok(intervals[0].ended <= intervals[1].started, JSON.stringify(intervals));
});
test("separate chats overlap in actual asynchronous tool execution", async () => {
  const [a, b] = (await Promise.all([post("overlap-a", "pause:500"), post("overlap-b", "pause:500")])).map(output);
  assert.ok(Math.max(a.started, b.started) < Math.min(a.ended, b.ended), JSON.stringify({ a, b }));
});
test("files and saved histories stay separate across chat and agent tuples", async () => {
  assert.equal((await bash("files-a", "echo alpha > note.txt; cat note.txt")).stdout, "alpha\n");
  assert.equal((await bash("files-b", "cat note.txt")).exitCode, 1);
  assert.equal((await bash("files-a", "cat note.txt", "other")).exitCode, 1);
  assert.match((await post("files-a", "system", "other")).reply, /other folder agent/);
  assert.equal((await post("files-a", "history")).reply, "2");
  assert.equal((await post("files-b", "history")).reply, "2");
  const response = await fetch(url("a", "missing")); assert.equal(response.status, 404);
  assert.equal((await fetch(url("a", "__proto__"))).status, 404);
});
test("regular files and history survive a real workerd process restart", async () => {
  await bash("restart", "echo persisted > note.txt");
  await stop(); running = await serve();
  assert.equal((await bash("restart", "cat note.txt")).stdout, "persisted\n");
  const response = await fetch(url("restart")); assert.equal(response.status, 200);
  assert.equal((await response.json()).messages.length, 4);
});

test("a failed turn persists its attempted user message and partial writes immediately", async () => {
  const response = await fetch(url("failed"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "fail:echo partial > note.txt" }) });
  assert.equal(response.status, 500);
  await stop(); running = await serve();
  const history = await (await fetch(url("failed"))).json();
  assert.equal(history.messages.length, 1); assert.equal(history.messages[0].role, "user");
  // Read through the GET history and a fresh ordinary turn: prior failed input must not poison later model calls.
  const recovered = await post("failed", "cat note.txt");
  assert.equal(output(recovered).stdout, "partial\n");
});

function output(result) { const value = JSON.parse(result.reply); assert.equal(value.type, "json", JSON.stringify(value)); return value.value; }
async function bash(chat, command, agent) { return output(await post(chat, command, agent)); }
function url(chat, agent = "support") { return `http://127.0.0.1:${port}/agents/${agent}/chats/${chat}/messages`; }
async function post(chat, text, agent) {
  const response = await fetch(url(chat, agent), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200, `${await response.clone().text()}\n${running?.log()}`); return response.json();
}
async function serve() {
  const child = spawn(workerd, ["serve", config, "--experimental", "--socket-addr", `http=127.0.0.1:${port}`, "--directory-path", `chat-storage=${directory}`], { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
  const exited = new Promise(resolve => child.once("exit", resolve)); let log = "";
  child.stderr.on("data", chunk => { log += chunk; });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    try { await fetch(url("health")); return { child, exited, log: () => log }; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  child.kill(); await exited; throw new Error(`workerd failed to start: ${log}`);
}
async function stop() {
  if (!running || running.child.exitCode !== null || running.child.signalCode !== null) return;
  running.child.kill(); const timer = setTimeout(() => running.child.kill("SIGKILL"), 5000);
  await running.exited; clearTimeout(timer);
}
function freePort() { return new Promise((resolve, reject) => { const server = createServer(); server.on("error", reject); server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); }); }); }
