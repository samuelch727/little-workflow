// Real self-hosted workerd, keyless, with only loopback network access.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as httpServer } from "node:http";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workerd = createRequire(import.meta.url)("workerd").default;
const SETTINGS = ["LITTLEDB_DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY", "MODEL_BASE_URL", "MODEL_NAME", "MODEL_API_KEY", "LITTLEDB_URL", "LITTLEDB_API_KEY", "TRACE_LIMIT"];
let dataDir, config, port, server;
before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "workerd-chats-"));
  execFileSync(join(root, "node_modules/.bin/wrangler"), ["deploy", "--dry-run", "--outdir", "dist"], {
    cwd: root, stdio: "pipe", env: { ...cleanEnv(), XDG_CONFIG_HOME: join(dataDir, "config"), WRANGLER_SEND_METRICS: "false" },
  });
  config = join(dataDir, "test.capnp");
  await copyFile(join(root, "dist/worker.js"), join(dataDir, "worker.js"));
  await writeFile(config, (await readFile(join(root, "workerd.capnp"), "utf8"))
    .replace('embed "dist/worker.js"', 'embed "worker.js"')
    .replace('allow = ["public", "127.0.0.1/32"]', 'allow = ["127.0.0.1/32"]'));
  port = await freePort(); server = await serve();
});
after(async () => { await stop(server); if (dataDir) await rm(dataDir, { recursive: true, force: true }); });

test("each chat has its own files and bash", async () => {
  assert.deepEqual(await bash("a", "echo hello > notes.txt && cat notes.txt"), { stdout: "hello\n", stderr: "", exitCode: 0 });
  assert.equal((await bash("b", "cat notes.txt")).exitCode, 1);
  assert.equal((await bash("b", "ls -A /")).stdout, ".agents\nartifacts\npersistent\nsession\n");
});
test("chats run at the same time, and one chat's turns run in order", async () => {
  const chats = Array.from({ length: 8 }, (_, i) => `parallel-${i}`);
  const replies = await Promise.all(chats.map(chat => bash(chat, `echo ${chat} > id.txt && cat id.txt`)));
  assert.deepEqual(replies.map(r => r.stdout), chats.map(chat => `${chat}\n`));
  await Promise.all([1, 2, 3].map(n => bash("ordered", `echo ${n} >> log.txt`)));
  assert.equal((await bash("ordered", "wc -l < log.txt")).stdout.trim(), "3");
});
test("bash has jq and friends, and refuses unavailable commands", async () => {
  assert.equal((await bash("tools", `echo '{"a":[1,2]}' | jq '.a[1]'`)).stdout, "2\n");
  for (const command of ["python3 -c 'print(1)'", "sqlite3 :memory: 'select 1'", "tar cf x.tar id.txt"]) {
    const reply = await bash("tools", command); assert.equal(reply.exitCode, 127, command); assert.match(reply.stderr, /not available/u);
  }
});
test("file changes are persisted as ordered trace events", async () => {
  const { events } = await post("traced", "mkdir -p /artifacts/out && echo r > /artifacts/out/report.txt");
  assert.ok(events.some(e => e.type === "harness.file.created"));
  assert.deepEqual(events.map(e => e.sequence), events.map((_, i) => events[0].sequence + i));
  const rows = await trace("traced"); assertOrdered(rows);
  assert.deepEqual(rows.map(({ type, sequence }) => ({ type, sequence })), events);
  assert.deepEqual(await trace("traced", rows[4].id), rows.slice(5));
});
test("completed files, history and traces survive a restart", async () => {
  const before = await post("kept", "echo still here > kept.txt");
  const rows = await trace("kept"), history = await get("kept", "messages"); await restart();
  assert.deepEqual(await trace("kept"), rows); assert.deepEqual(await get("kept", "messages"), history);
  const after = await post("kept", "cat kept.txt"); assert.equal(JSON.parse(after.reply).stdout, "still here\n");
  assert.ok(after.events[0].sequence > before.events.at(-1).sequence);
  assert.deepEqual((await get("kept", "files")).files.map(f => f.path), ["/session/kept.txt"]);
});
test("an acknowledged parked question resumes after restart and keeps its answer", async () => {
  const parked = await post("human", "ask:What should I write?"); assert.equal(parked.status, "parked"); assert.equal(parked.requests.length, 1);
  assert.equal(parked.requests[0].question, "What should I write?");
  assert.deepEqual((await get("human", "messages")).messages.map(({ role, text }) => ({ role, text })), [{ role: "user", text: "ask:What should I write?" }]);
  await restart();
  assert.ok((await get("human", "messages")).messages.every(({ text }) => text !== "[parked]"));
  const answer = { requestId: parked.requests[0].requestId, answer: { text: "Use the blue notebook" } };
  const result = await send("human", "answers", answer); assert.equal(result.status, "completed"); assert.equal(result.reply, "Use the blue notebook");
  await restart(); const repeated = await send("human", "answers", answer); assert.equal(repeated.status, "answered"); assert.deepEqual(repeated.requests, []);
  const history = (await get("human", "messages")).messages;
  assert.equal(history.at(-1).text, "Use the blue notebook"); assert.equal(history.filter(r => r.text === "Use the blue notebook").length, 1);
  assert.ok(history.every(({ text }) => text !== "[parked]"));
  const changed = await fetch(url("human", "answers"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...answer, answer: { text: "different" } }) });
  assert.equal(changed.status, 400);
});
test("answers and new turns share the chat queue", async () => {
  const parked = await post("human-queue", "ask:Pick a colour");
  const cursor = (await trace("human-queue")).at(-1).id;
  // Observe the new turn running before submitting the answer; network arrival order
  // of two fetches launched together is deliberately unspecified.
  const message = post("human-queue", "sleep 0.2; echo after-answer");
  await until(async () => (await trace("human-queue", cursor)).some(r => r.type === "harness.tool_call.started"));
  const answer = send("human-queue", "answers", { requestId: parked.requests[0].requestId, answer: { text: "green" } });
  assert.equal(JSON.parse((await message).reply).stdout, "after-answer\n");
  assert.equal((await answer).reply, "green");
  const history = (await get("human-queue", "messages")).messages;
  assert.deepEqual(history.map(r => r.role), ["user", "user", "assistant", "assistant"]);
  assert.ok(history.every(({ text }) => text !== "[parked]"));
  assert.equal(history.at(-1).text, "green");
});
test("SIGKILL after trace insertion never reuses sequences or cursor ids", async () => { await crashWitness("crash", {}); });
test("cursor polling and SIGKILL remain monotonic across a retention prune", async () => {
  await restart({ TRACE_LIMIT: "64" }); let cursor = 0; const received = [];
  for (let i = 0; i < 5; i++) {
    await post("pruned", `echo turn-${i}`); const fresh = await trace("pruned", cursor);
    assert.ok(fresh.length > 0); assert.equal(fresh[0].id, cursor + 1);
    assertOrdered(fresh); received.push(...fresh); cursor = fresh.at(-1).id;
  }
  const retained = await trace("pruned"); assert.equal(retained.length, 64); assert.ok(retained[0].id > received[0].id);
  assert.deepEqual(retained, received.slice(-64)); assert.equal(new Set(received.map(r => r.id)).size, received.length);
  await crashWitness("pruned", { TRACE_LIMIT: "64" }); await restart();
});
test("LittleDB stays off for absent and partial settings", async () => {
  const ingest = await fakeServer(async () => ({}));
  try {
    for (const [i, settings] of [{}, { LITTLEDB_URL: ingest.url }, { LITTLEDB_API_KEY: "test-only-key" }].entries()) {
      await restart(settings); assert.equal((await bash(`offline-${i}`, "echo offline")).stdout, "offline\n");
    }
    await delay(1200); assert.equal(ingest.requests.length, 0);
  } finally { await ingest.close(); }
});
test("LittleDB opt-in exports spans and its outage never fails a turn", async () => {
  const ingest = await fakeServer(async () => ({})); await restart({ LITTLEDB_URL: ingest.url, LITTLEDB_API_KEY: "test-only-key" });
  try {
    assert.equal((await bash("export", "echo exported")).stdout, "exported\n");
    await until(() => ingest.requests.some(r => Array.isArray(r.body.spans) && r.body.spans.length > 0));
    assert.ok(ingest.requests.every(r => r.path === "/v1/ingest")); await ingest.close();
    assert.equal((await bash("export", "echo still-local")).stdout, "still-local\n"); assert.ok((await trace("export")).length > 0);
  } finally { await ingest.close(); await restart(); }
});
test("an optional compatible local model supplies the reply", async () => {
  const model = await fakeServer(async (request, body) => {
    assert.equal(request.url, "/v1/chat/completions"); assert.equal(body.model, "local-test-model");
    return { id: "chatcmpl_test", object: "chat.completion", created: 1, model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "Hello from the LAN model" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 6, total_tokens: 9 } };
  });
  try {
    await restart({ MODEL_BASE_URL: `${model.url}/v1`, MODEL_NAME: "local-test-model" });
    assert.equal((await post("local-model", "hello")).reply, "Hello from the LAN model"); assert.equal(model.requests.length, 1);
  } finally { await model.close(); await restart(); }
});
test("a one-shot plan runs its tool and model and keeps original workflow trace events", async () => {
  const result = JSON.parse((await post("one-shot", "plan:one two three")).reply);
  assert.equal(result.status, "completed");
  assert.equal(result.output, "Words: 3");
  const rows = await trace("one-shot");
  const events = workflowEvents(rows, result.runId);
  for (const type of ["RunStarted", "harness.tool_call.succeeded", "harness.model.responded", "RunCompleted"]) {
    assert.ok(events.some(event => event.type === type), `Missing ${type}`);
  }
  const toolCalls = events.filter(event => event.type === "harness.tool_call.succeeded");
  assert.equal(toolCalls.length, 1);
  const counted = toolCalls[0].payload;
  assert.equal(counted.toolName, "word_count");
  assert.equal(counted.stepPath, "count");
  assert.equal(counted.caller, "code");
  assert.deepEqual(counted.args, { text: "one two three" });
  assert.deepEqual(counted.result, { count: 3 });
  assert.equal(events.find(event => event.type === "harness.tool_call.started").payload.callId, counted.callId);
  const modelCalls = events.filter(event => event.type === "harness.model.responded");
  assert.equal(modelCalls.length, 1);
  const generated = modelCalls[0].payload;
  assert.equal(generated.stepPath, "reply");
  assert.deepEqual(generated.model, { provider: "scripted", modelId: "bash-echo" });
  assert.equal(generated.response.output, "Words: 3");
  const invocation = events.find(event => event.type === "harness.model.called").payload;
  assert.equal(invocation.callId, generated.callId);
  assert.equal(invocation.stepPath, "reply");
  assert.equal(invocation.request.step.uses, "ai.generate");
  assert.deepEqual(invocation.request.messages, [{ role: "user", content: "WORD_COUNT=3" }]);
  assert.deepEqual(events.filter(event => event.type === "StepCompleted").map(event => ({
    stepPath: event.payload.stepPath, uses: event.payload.metadata.uses, output: event.payload.output,
  })), [
    { stepPath: "count", uses: "tool.call", output: { count: 3 } },
    { stepPath: "reply", uses: "ai.generate", output: "Words: 3" },
  ]);
  assert.deepEqual(events.map(event => event.sequence), events.map((_, index) => index + 1));
  assert.ok(events.every(event => event.eventId && event.recordedAt && event.sessionId === "chat"));
  // The global cursor orders both sources; their original sequence namespaces stay separate.
  assert.deepEqual(rows.map(row => row.id), rows.map((_, index) => index + 1));
  const harness = rows.filter(row => row.source === "harness");
  assert.deepEqual(harness.map(event => event.sequence), harness.map((_, index) => index + 1));
  assert.deepEqual(await trace("one-shot", rows[5].id), rows.slice(6));
});
test("a completed definition is offered next turn and its kept plan survives restart without a planner", async () => {
  assert.match((await post("defined", "use:notes.words:not defined yet")).reply, /No defined workflow/u);
  const definition = JSON.parse((await post("defined", "define:notes.words")).reply);
  assert.equal(definition.status, "defined");
  assert.equal(definition.tool, "notes_words");
  const first = JSON.parse((await post("defined", "use:notes.words:one two")).reply);
  assert.equal(first.status, "completed");
  assert.equal(first.output, "Words: 2");
  const saved = await trace("defined");
  const original = workflowEvents(saved, first.runId);
  assert.equal(original.filter(event => event.type === "PlannerStarted").length, 1);
  assert.ok(original.some(event => event.type === "RunCompleted"));
  const version = original.find(event => event.type === "RunStarted").payload.workflowVersionId;
  assert.equal(typeof version, "string");
  const cursor = saved.at(-1).id;

  // Both the definition and its first run completed before this process restart.
  await restart();
  assert.deepEqual(await trace("defined"), saved);
  const second = JSON.parse((await post("defined", "use:notes.words:four fresh words here")).reply);
  assert.equal(second.status, "completed");
  assert.equal(second.output, "Words: 4");
  assert.notEqual(second.runId, first.runId);
  const resumed = workflowEvents(await trace("defined", cursor), second.runId);
  const decision = resumed.find(event => event.type === "PlannerReuseDecisionRecorded").payload;
  assert.equal(decision.decisionKind, "reuse_unchanged");
  assert.equal(decision.candidateWorkflowVersionId, version);
  assert.equal(decision.resultingWorkflowVersionId, version);
  assert.equal(resumed.find(event => event.type === "RunStarted").payload.workflowVersionId, version);
  assert.equal(resumed.some(event => event.type === "PlannerStarted"), false);
  assert.equal(resumed.find(event => event.type === "RunCompleted").payload.output, "Words: 4");
});
function workflowEvents(rows, runId) { return rows.filter(row => row.source === "workflow" && row.runId === runId); }
async function crashWitness(chat, settings) {
  const before = await trace(chat), cursor = before.at(-1)?.id ?? 0; let settled = false;
  const pending = post(chat, "echo interrupted > interrupted.txt; sleep 30").then(value => { settled = true; return value; }, error => { settled = true; return error; });
  let during;
  await until(async () => { during = await trace(chat, cursor); return during.some(r => r.type === "harness.tool_call.started"); });
  assert.equal(settled, false, "killed turn must be active before its file save");
  const killed = server; killed.child.kill("SIGKILL"); assert.equal((await killed.exited).signal, "SIGKILL");
  assert.ok(await pending instanceof Error, "interrupted HTTP request must not succeed"); server = await serve(settings);
  const restored = await trace(chat, cursor); assert.deepEqual(restored, during);
  assert.equal((await get(chat, "files")).files.some(f => f.path === "/session/interrupted.txt"), false);
  await post(chat, "echo after-restart"); const fresh = await trace(chat, restored.at(-1).id); assert.ok(fresh.length > 0);
  assert.ok(fresh[0].sequence > restored.at(-1).sequence); const seen = [...during, ...fresh];
  assert.equal(new Set(seen.map(r => r.sequence)).size, seen.length); assert.equal(new Set(seen.map(r => r.id)).size, seen.length); assertOrdered(seen);
  assert.deepEqual(await trace(chat, fresh.at(-1).id), []);
}
function assertOrdered(rows) { for (let i = 1; i < rows.length; i++) { assert.equal(rows[i].id, rows[i-1].id + 1); assert.ok(rows[i].sequence > rows[i-1].sequence); } }
function url(chat, action) { return `http://127.0.0.1:${port}/chats/${chat}/${action}`; }
async function get(chat, action) { const r = await fetch(url(chat, action)); assert.equal(r.status, 200, await r.clone().text()); return r.json(); }
async function trace(chat, after = 0) { return (await get(chat, `trace?after=${after}`)).events; }
async function send(chat, action, body) {
  const r = await fetch(url(chat, action), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(r.status, 200, `${await r.clone().text()}\n${server?.stderr()}`); return r.json();
}
async function post(chat, text) { return send(chat, "messages", { text }); }
async function bash(chat, command) { return JSON.parse((await post(chat, command)).reply); }
function cleanEnv() { const env = { ...process.env }; for (const key of SETTINGS) delete env[key]; return env; }
async function serve(settings = {}) {
  const child = spawn(workerd, ["serve", config, "--experimental", "--socket-addr", `http=127.0.0.1:${port}`, "--directory-path", `chat-storage=${dataDir}`],
    { cwd: root, env: { ...cleanEnv(), ...settings }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    try { await fetch(`http://127.0.0.1:${port}/`); return { child, exited, stderr: () => stderr }; } catch { await delay(50); }
  }
  child.kill(); throw new Error(`workerd did not start:\n${stderr}`);
}
async function restart(settings = {}) { await stop(server); server = await serve(settings); }
async function stop(running) {
  if (!running || running.child.exitCode !== null || running.child.signalCode !== null) return;
  running.child.kill(); const timer = setTimeout(() => running.child.kill("SIGKILL"), 5000); await running.exited; clearTimeout(timer);
}
function freePort() { return new Promise((resolve, reject) => { const p = createServer(); p.once("error", reject); p.listen(0, "127.0.0.1", () => { const { port } = p.address(); p.close(() => resolve(port)); }); }); }
async function fakeServer(handler) {
  const requests = [];
  const fake = httpServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); requests.push({ path: request.url, body });
      const result = await handler(request, body);
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(result));
    } catch (error) { response.writeHead(500).end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise(resolve => fake.listen(0, "127.0.0.1", resolve)); let closed = false;
  return { requests, url: `http://127.0.0.1:${fake.address().port}`, async close() {
    if (closed) return; closed = true; fake.closeAllConnections(); await new Promise((resolve, reject) => fake.close(error => error ? reject(error) : resolve()));
  } };
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await check()) return; await delay(30); }
  throw new Error(`Timed out waiting for witness. workerd stderr:\n${server?.stderr()}`);
}
