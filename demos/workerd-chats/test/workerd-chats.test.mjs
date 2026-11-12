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
const SETTINGS = ["LITTLEDB_DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY", "MODEL_BASE_URL", "MODEL_NAME", "MODEL_API_KEY", "LITTLEDB_URL", "LITTLEDB_API_KEY", "TRACE_LIMIT", "TEST_FAULTS", "DATA_API_TOKEN", "DATA_API_PORT"];
const dataToken = "loopback-only-remote-tools-test-token";
let dataDir, config, port, server, dataPort, dataService;
before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "workerd-chats-"));
  execFileSync(join(root, "node_modules/.bin/wrangler"), ["deploy", "--dry-run", "--outdir", "dist"], {
    cwd: root, stdio: "pipe", env: { ...cleanEnv(), XDG_CONFIG_HOME: join(dataDir, "config"), WRANGLER_SEND_METRICS: "false" },
  });
  config = join(dataDir, "test.capnp");
  dataPort = await freePort();
  await copyFile(join(root, "dist/worker.js"), join(dataDir, "worker.js"));
  await writeFile(config, (await readFile(join(root, "workerd.capnp"), "utf8"))
    .replace('embed "dist/worker.js"', 'embed "worker.js"')
    .replace('127.0.0.1:8788', `127.0.0.1:${dataPort}`)
    .replace('(name = "CHAT", durableObjectNamespace = "Chat"),', '(name = "CHAT", durableObjectNamespace = "Chat"),\n    (name = "TEST_FAULTS", fromEnvironment = "TEST_FAULTS"),')
    .replace('allow = ["public", "127.0.0.1/32"]', 'allow = ["127.0.0.1/32"]'));
  port = await freePort(); server = await serve();
});
after(async () => { await stop(server); await stop(dataService); if (dataDir) await rm(dataDir, { recursive: true, force: true }); });

test("each chat has its own files and bash", async () => {
  assert.deepEqual(await bash("a", "echo hello > notes.txt && cat notes.txt"), { stdout: "hello\n", stderr: "", exitCode: 0 });
  assert.equal((await bash("b", "cat notes.txt")).exitCode, 1);
  assert.equal((await bash("b", "ls -A /")).stdout, ".agents\nartifacts\ndev\npersistent\nsession\n");
});
for (const command of [
  "printf hidden > /dev/null; cat /dev/null; printf OK",
  "printf hidden >> '/dev/null'; cat < /dev/null; printf OK",
  "cat /missing 2>/dev/null; printf OK",
  "{ printf hidden; cat /missing; } >/dev/null 2>&1; printf OK",
]) test(`null device redirects: ${command}`, async () => {
  assert.deepEqual(await bash(`null-${command.length}`, command), { stdout: "OK", stderr: "", exitCode: 0 });
});
for (const [index, [command, stdout]] of [
  ["{ printf OUT; printf ERR >&2; } >/session/all 2>&1; cat /session/all", "OUTERR"],
  ["{ printf OUT; printf ERR >&2; } 2>&1 >/session/out; printf '|'; cat /session/out", "ERR|OUT"],
  ["{ printf OUT; printf ERR >&2; } >/session/all 2>&1 2>/session/err; cat /session/all; printf '|'; cat /session/err", "OUT|ERR"],
  ["printf OUT >/session/first >/session/last; cat /session/first; printf '|'; cat /session/last", "|OUT"],
].entries()) test(`descriptor order matrix ${index}`, async () => {
  assert.deepEqual(await bash(`fd-order-${index}`, command), { stdout, stderr: "", exitCode: 0 });
});
test("null device cannot be replaced and other device writes remain forbidden", async () => {
  for (const command of ["printf no >/dev/nullish", "printf no >/dev/other", "rm /dev/null", "ln -s /session/file /dev/null", "ln /dev/null /session/alias"]) {
    assert.notEqual((await bash("null-deny", command)).exitCode, 0);
  }
  assert.deepEqual(await bash("null-deny", "cat /dev/null"), { stdout: "", stderr: "", exitCode: 0 });
  assert.deepEqual((await get("null-deny", "files")).files, []);
});
test("null structural operations explicitly preserve sources and device stat/mkdir behavior", async () => {
  await bash("null-structural", "printf keep >/session/source");
  for (const command of ["mv /session/source /dev/null", "cp /session/source /dev/null"]) {
    const result = await bash("null-structural", command);
    assert.notEqual(result.exitCode, 0); assert.match(result.stderr, /synthetic/); assert.doesNotMatch(result.stderr, /chmod/);
    assert.equal((await bash("null-structural", "cat /session/source")).stdout, "keep");
  }
  assert.deepEqual(await bash("null-structural", "test ! -f /dev/null && test -c /dev/null && printf OK"), { stdout: "OK", stderr: "", exitCode: 0 });
  assert.notEqual((await bash("null-structural", "mkdir /dev")).exitCode, 0);
  assert.equal((await bash("null-structural", "mkdir -p /dev; cat /dev/null")).exitCode, 0);
});
test("command execution identity stays distinct across chat scopes", async () => {
  const results = await Promise.all([post("identity-a", "sleep 0.1; printf synthetic"), post("identity-b", "sleep 0.1; printf synthetic")]);
  const ids = [];
  for (const result of results) {
    const start = result.events.find(event => event.type === "harness.runtime.command.started");
    const finish = result.events.find(event => event.type === "harness.runtime.command.succeeded");
    assert.ok(start); assert.ok(finish);
    assert.equal(typeof start.executionId, "string");
    assert.equal(start.executionId, finish.executionId);
    assert.equal(start.toolCallId, finish.toolCallId);
    const allowed = new Set(["type", "sequence", "sessionId", "turnId", "executionId", "toolCallId"]);
    assert.ok([...Object.keys(start), ...Object.keys(finish)].every(key => allowed.has(key)));
    assert.equal(start.sessionId, finish.sessionId); assert.equal(start.turnId, finish.turnId);
    ids.push(start.executionId);
  }
  assert.notEqual(ids[0], ids[1]);
});
test("synthetic /dev directory moves and recursive copies fail without leaving a destination", async () => {
  for (const source of ["/dev", "/dev/", "/dev/null/.."]) {
    for (const operation of ["mv", "cp -r"]) {
      const result = await bash("dev-directory-guard", `${operation} ${source} /session/devcopy`);
      assert.notEqual(result.exitCode, 0); assert.match(result.stderr, /synthetic/);
      assert.equal((await bash("dev-directory-guard", "test ! -e /session/devcopy")).exitCode, 0);
      assert.deepEqual((await get("dev-directory-guard", "files")).files, []);
    }
  }
  assert.deepEqual(await bash("dev-directory-guard", "ls /dev; cat /dev/null"), { stdout: "null\n", stderr: "", exitCode: 0 });
});
test("null-source copies leave managed files intact and redirects can explicitly create or truncate them", async () => {
  await bash("null-source-copy", "printf keep > /session/existing");
  for (const destination of ["existing", "absent"]) {
    const result = await bash("null-source-copy", `cp /dev/null /session/${destination}`);
    assert.notEqual(result.exitCode, 0); assert.match(result.stderr, /synthetic/);
  }
  assert.equal((await bash("null-source-copy", "cat /session/existing")).stdout, "keep");
  assert.notEqual((await bash("null-source-copy", "test -e /session/absent")).exitCode, 0);
  assert.deepEqual(await bash("null-source-copy", ": > /session/existing; : > /session/absent; wc -c /session/existing /session/absent | tail -n 1"), { stdout: "  0 total\n", stderr: "", exitCode: 0 });
});
test("identical parallel bash calls overlap within one native-workerd turn and retain exact IDs", async () => {
  const result = await post("identity-same-turn", "parallel-bash:sleep 0.2; printf synthetic");
  const commands = result.events.filter(event => event.type.startsWith("harness.runtime.command."));
  const starts = commands.filter(event => event.type.endsWith("started"));
  const ends = commands.filter(event => event.type.endsWith("succeeded"));
  assert.equal(starts.length, 2); assert.equal(ends.length, 2);
  assert.equal(new Set(commands.map(event => event.turnId)).size, 1);
  assert.equal(new Set(commands.map(event => event.sessionId)).size, 1);
  assert.equal(new Set(starts.map(event => event.executionId)).size, 2);
  assert.ok(Math.max(...starts.map(event => event.sequence)) < Math.min(...ends.map(event => event.sequence)), "both commands must start before either finishes");
  for (const start of starts) {
    const end = ends.find(event => event.executionId === start.executionId);
    assert.ok(end); assert.equal(end.toolCallId, start.toolCallId);
    assert.ok(Object.keys(start).every(key => ["type", "sequence", "sessionId", "turnId", "executionId", "toolCallId"].includes(key)));
  }
});
test("the streaming script forwards both parallel same-turn tool calls", async () => {
  const chunks = await readSse(await openStream("identity-stream-turn", "parallel-bash:sleep 0.2; printf synthetic"));
  assert.equal(chunks.filter(chunk => chunk.type === "tool-input-available").length, 2);
  assert.equal(chunks.filter(chunk => chunk.type === "tool-output-available").length, 2);
  const events = await trace("identity-stream-turn");
  const starts = events.filter(event => event.type === "harness.runtime.command.started");
  const ends = events.filter(event => event.type === "harness.runtime.command.succeeded");
  assert.equal(starts.length, 2); assert.equal(ends.length, 2);
  assert.equal(new Set(starts.map(event => event.turnId)).size, 1);
  assert.equal(new Set(starts.map(event => event.metadata.executionId)).size, 2);
  assert.ok(Math.max(...starts.map(event => event.sequence)) < Math.min(...ends.map(event => event.sequence)));
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
  assert.deepEqual(rows.map(({ type, sequence }) => ({ type, sequence })), events.map(({ type, sequence }) => ({ type, sequence })));
  for (const event of events.filter(event => event.type.startsWith("harness.runtime.command."))) {
    const stored = rows.find(row => row.sequence === event.sequence);
    assert.equal(event.executionId, stored.metadata.executionId);
    assert.equal(event.toolCallId, stored.metadata.toolCallId);
    assert.equal(event.sessionId, stored.sessionId); assert.equal(event.turnId, stored.turnId);
  }
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
test("a streamed bash turn sends ordered UI chunks and saves before finish", async (t) => {
  const command = "echo streamed > streamed.txt && cat streamed.txt";
  const chunks = await readSse(await openStream("streamed", command), async (chunk) => {
    if (chunk.type !== "finish") return;
    assert.deepEqual((await get("streamed", "files")).files.map(f => f.path), ["/session/streamed.txt"]);
    assert.deepEqual((await get("streamed", "messages")).messages.map(r => r.role), ["user", "assistant"]);
    assert.equal((await trace("streamed")).at(-1).type, "harness.session.completed");
  });
  const types = chunks.map(chunk => chunk.type);
  t.diagnostic(`bash UI chunks: ${types.join(" → ")} → [DONE]`);
  assert.deepEqual(types, [
    "start", "start-step", "tool-input-start", "tool-input-delta", "tool-input-available", "tool-output-available", "finish-step",
    "start-step", "text-start", "text-delta", "text-end", "finish-step", "finish",
  ]);
  assert.equal(chunks.find(chunk => chunk.type === "tool-input-available").input.command, command);
  assert.equal(chunks.find(chunk => chunk.type === "tool-output-available").output.stdout, "streamed\n");
  assert.equal(chunks.at(-1).messageMetadata, undefined, "completed finish stays unchanged");
  assert.equal(JSON.parse(streamedText(chunks)).stdout, "streamed\n");
  assert.equal((await get("streamed", "messages")).messages.at(-1).text, streamedText(chunks));
  assertOrdered(await trace("streamed"));
});
test("an after-drain failure emits one generic error, saves files and releases the queue", async () => {
  const command = "echo survived > failed.txt";
  await restart({ TEST_FAULTS: JSON.stringify({ failAfterDrainFor: command }) });
  try {
    const chunks = await readSse(await openStream("stream-failed", command));
    assert.deepEqual(chunks.filter(chunk => chunk.type === "error"), [{ type: "error", errorText: "The turn failed." }]);
    assert.equal(chunks.some(chunk => chunk.type === "finish"), false);
    assert.equal(JSON.stringify(chunks).includes("Injected after-drain"), false);
    assert.deepEqual((await get("stream-failed", "messages")).messages, []);
    assert.equal((await bash("stream-failed", "cat failed.txt")).stdout, "survived\n");
    await restart();
    assert.equal((await bash("stream-failed", "cat failed.txt")).stdout, "survived\n");
    assertOrdered(await trace("stream-failed"));
  } finally { await restart(); }
});
test("finish and a queued JSON turn wait for the streamed filesystem save", async (t) => {
  const saveDelayMs = 1200;
  await restart({ TEST_FAULTS: JSON.stringify({ saveDelayMs }) });
  try {
    const observed = []; let finishAt;
    const stream = readSse(await openStream("stream-queue", "echo first >> order.txt"), (chunk) => {
      observed.push(chunk); if (chunk.type === "finish") finishAt = Date.now();
    });
    await until(async () => (await trace("stream-queue")).some(row => row.type === "harness.session.completed"));
    const completedAt = Date.now();
    assert.equal(observed.some(chunk => chunk.type === "finish"), false);
    let settled = false;
    const queued = post("stream-queue", "echo second >> order.txt").then(result => { settled = true; return result; });
    await delay(150);
    assert.equal(settled, false, "JSON success must wait for the streaming turn's save");
    assert.equal((await trace("stream-queue")).filter(row => row.type === "harness.session.started").length, 1);
    assert.equal(observed.some(chunk => chunk.type === "finish"), false);
    await stream;
    assert.ok(finishAt - completedAt >= 1000, "finish must follow the injected save delay");
    t.diagnostic(`finish followed harness completion by ${finishAt - completedAt}ms with a ${saveDelayMs}ms pre-save delay`);
    assert.equal((await queued).status, "completed");
    await restart();
    assert.equal((await bash("stream-queue", "cat order.txt")).stdout, "first\nsecond\n");
  } finally { await restart(); }
});
test("disconnecting after the first chunk still saves the turn across restart", async () => {
  const abort = new AbortController();
  const response = await openStream("stream-aborted", "sleep 0.3; echo kept > kept.txt", { signal: abort.signal });
  const reader = response.body.getReader();
  assert.equal((await reader.read()).done, false);
  assert.equal((await trace("stream-aborted")).some(row => row.type === "harness.session.completed"), false);
  abort.abort(); await reader.cancel().catch(() => {});
  await until(async () => (await get("stream-aborted", "messages")).messages.length === 2);
  // The next queued JSON turn witnesses completion of the disconnected turn's save.
  assert.equal((await bash("stream-aborted", "cat kept.txt")).stdout, "kept\n");
  const history = await get("stream-aborted", "messages"), rows = await trace("stream-aborted");
  assertOrdered(rows); await restart();
  assert.deepEqual(await get("stream-aborted", "messages"), history);
  assert.deepEqual(await trace("stream-aborted"), rows);
  assert.deepEqual((await get("stream-aborted", "files")).files.map(f => f.path), ["/session/kept.txt"]);
  assert.equal((await bash("stream-aborted", "cat kept.txt")).stdout, "kept\n");
});
test("a streamed question parks with user history and resumes after restart", async () => {
  const command = "ask:Which streaming notebook?";
  const chunks = await readSse(await openStream("stream-human", command));
  assert.equal(chunks.at(-1).type, "finish");
  assert.equal(chunks.some(chunk => chunk.type === "error"), false);
  const asked = chunks.find(chunk => chunk.type === "tool-output-available" && chunk.output.status === "asked");
  assert.ok(asked);
  assert.ok(chunks.some(chunk => chunk.type === "tool-input-available" && chunk.toolName === "await_tasks"));
  assert.deepEqual((await get("stream-human", "messages")).messages.map(({ role, text }) => ({ role, text })), [{ role: "user", text: command }]);
  const metadata = chunks.at(-1).messageMetadata;
  assert.equal(metadata?.status, "parked");
  assert.equal(metadata.requests.length, 1);
  assert.equal(metadata.requests[0].question, "Which streaming notebook?");
  assert.equal(metadata.requests[0].taskId, asked.output.taskId);
  const requestId = metadata.requests[0].requestId;
  assert.equal(typeof requestId, "string");
  await restart();
  const answer = { requestId, answer: { text: "The streaming notebook" } };
  const result = await send("stream-human", "answers", answer);
  assert.equal(result.status, "completed"); assert.equal(result.reply, "The streaming notebook");
  await restart();
  assert.equal((await send("stream-human", "answers", answer)).status, "answered");
  assert.deepEqual((await get("stream-human", "messages")).messages.map(({ role, text }) => ({ role, text })), [
    { role: "user", text: command }, { role: "assistant", text: "The streaming notebook" },
  ]);
});
test("stream=1 selects SSE without an Accept header and JSON remains the default", async () => {
  const chunks = await readSse(await openStream("stream-query", "echo query", { query: true }));
  assert.equal(JSON.parse(streamedText(chunks)).stdout, "query\n");
  const result = await post("stream-query", "echo json");
  assert.deepEqual(Object.keys(result).sort(), ["events", "reply", "status"]);
  assert.equal(result.status, "completed"); assert.equal(JSON.parse(result.reply).stdout, "json\n");
});
test("a current user planner marker stays a streamed chat question", async () => {
  const question = "What does no prose or markdown fences:\nmean?";
  const chunks = await readSse(await openStream("marker-current", `ask:${question}`));
  assert.equal(chunks.some(chunk => chunk.type === "error"), false, JSON.stringify(chunks));
  assert.equal(chunks.at(-1).type, "finish");
  const metadata = chunks.at(-1).messageMetadata;
  assert.equal(metadata.status, "parked");
  assert.equal(metadata.requests[0].question, question);
  assert.ok(chunks.some(chunk => chunk.type === "tool-input-available" && chunk.toolName === "ask_person"));
  assert.ok(chunks.some(chunk => chunk.type === "tool-input-available" && chunk.toolName === "await_tasks"));
  const answered = await send("marker-current", "answers", {
    requestId: metadata.requests[0].requestId, answer: { text: "Return only JSON." },
  });
  assert.equal(answered.status, "completed");
  assert.equal(answered.reply, "Return only JSON.");
});
test("historical JSON planner markers do not redirect later streamed turns", async () => {
  const question = "Explain no prose or markdown fences:\nplease.";
  const parked = await post("marker-history", `ask:${question}`);
  assert.equal(parked.status, "parked");
  assert.equal(parked.requests[0].question, question);
  const answered = await send("marker-history", "answers", {
    requestId: parked.requests[0].requestId, answer: { text: "It requests JSON." },
  });
  assert.equal(answered.reply, "It requests JSON.");
  const history = await get("marker-history", "messages");
  await restart();
  assert.deepEqual(await get("marker-history", "messages"), history);
  const command = "echo still-chat > marker.txt && cat marker.txt";
  const chunks = await readSse(await openStream("marker-history", command));
  assert.equal(chunks.some(chunk => chunk.type === "error"), false, JSON.stringify(chunks));
  assert.equal(chunks.at(-1).type, "finish");
  assert.equal(chunks.find(chunk => chunk.type === "tool-input-available").toolName, "bash");
  assert.equal(JSON.parse(streamedText(chunks)).stdout, "still-chat\n");
  assert.deepEqual((await get("marker-history", "messages")).messages.map(({ role, text }) => ({ role, text })), [
    { role: "user", text: `ask:${question}` }, { role: "assistant", text: "It requests JSON." },
    { role: "user", text: command }, { role: "assistant", text: streamedText(chunks) },
  ]);
  assert.deepEqual((await get("marker-history", "files")).files.map(file => file.path), ["/session/marker.txt"]);
});
test("streamed plans and reusable workflows retain the scripted model paths", async () => {
  const planned = await readSse(await openStream("stream-workflows", "plan:one two three"));
  assert.equal(JSON.parse(streamedText(planned)).output, "Words: 3");
  const defined = await readSse(await openStream("stream-workflows", "define:stream.words"));
  assert.equal(JSON.parse(streamedText(defined)).status, "defined");
  const used = await readSse(await openStream("stream-workflows", "use:stream.words:one two"));
  assert.equal(JSON.parse(streamedText(used)).output, "Words: 2");
});

test("remote orders run in Node SQLite with principal-scoped rows and no server code or token in workerd", async () => {
  await startDataService();
  try {
    await restart({ DATA_API_TOKEN: dataToken });
    const result = await post("remote-orders", "orders:open");
    assert.equal(result.status, "completed");
    assert.ok(!result.reply.startsWith("Tool error:"), `${result.reply}\n${server.stderr()}`);
    assert.deepEqual(JSON.parse(result.reply).orders, [{ id: "order-1", status: "open", total: 4200 }, { id: "order-2", status: "open", total: 1900 }]);
    const streamed = await readSse(await openStream("remote-orders-stream", "orders:closed"));
    assert.deepEqual(JSON.parse(streamedText(streamed)).orders, [{ id: "order-3", status: "closed", total: 800 }]);
    const bundle = await readFile(join(root, "dist/worker.js"), "utf8");
    assert.ok(!bundle.includes(dataToken));
    assert.ok(!bundle.includes("demo_remote_orders"));
    assert.ok(!bundle.includes("node:sqlite"));
    assert.ok(!bundle.includes("other-user-order"));
  } finally { await stop(dataService); dataService = undefined; await restart(); }
});

test("a wrong remote token and a stopped data service are recoverable tool errors", async () => {
  await startDataService();
  try {
    await restart({ DATA_API_TOKEN: "wrong-loopback-token" });
    const refused = await post("remote-wrong-token", "orders:open");
    assert.equal(refused.status, "completed");
    assert.match(refused.reply, /Tool error:.*401/u);
    assert.ok(!refused.reply.includes(dataToken));
    await stop(dataService);
    dataService = undefined;
    await restart({ DATA_API_TOKEN: dataToken });
    const offline = await post("remote-offline", "orders:open");
    assert.equal(offline.status, "completed");
    assert.match(offline.reply, /Tool error:.*remote tool call failed/u);
    assert.equal(JSON.parse((await post("remote-offline", "echo next-turn")).reply).stdout, "next-turn\n");
  } finally { await stop(dataService); dataService = undefined; await restart(); }
});

test("workerd refuses a remote redirect without contacting its target or forwarding credentials", async () => {
  const targetRequests = [], initialRequests = [];
  const target = httpServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    targetRequests.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true,"output":{"orders":[]}}');
  });
  await new Promise(resolve => target.listen(0, "127.0.0.1", resolve));
  let status = 302;
  const redirector = httpServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    initialRequests.push({ authorization: req.headers.authorization, method: req.method, body: Buffer.concat(chunks).toString() });
    res.writeHead(status, { location: `http://127.0.0.1:${target.address().port}/redirect-target` });
    res.end("private-redirect-body");
  });
  await new Promise(resolve => redirector.listen(dataPort, "127.0.0.1", resolve));
  try {
    await restart({ DATA_API_TOKEN: dataToken });
    for (const code of [300, 301, 302, 303, 304, 305, 306, 307, 308, 399]) {
      status = code;
      const result = await post(`remote-redirect-${code}`, "orders:open");
      assert.equal(result.status, "completed");
      assert.match(result.reply, new RegExp(`Tool error:.*\\(${code}\\)`, "u"));
      assert.ok(!result.reply.includes("private-redirect-body"));
    }
    assert.equal(initialRequests.length, 10, "one request per call, with no retries");
    for (const req of initialRequests) {
      assert.equal(req.method, "POST");
      assert.equal(req.authorization, `Bearer ${dataToken}`);
      assert.deepEqual(JSON.parse(req.body).input, { status: "open" });
    }
    assert.deepEqual(targetRequests, [], "destination receives no request, credentials or body");
  } finally {
    redirector.closeAllConnections(); target.closeAllConnections();
    await Promise.all([new Promise(resolve => redirector.close(resolve)), new Promise(resolve => target.close(resolve))]);
    await restart();
  }
});

function streamedText(chunks) { return chunks.filter(chunk => chunk.type === "text-delta").map(chunk => chunk.delta).join(""); }
async function openStream(chat, text, { query = false, signal } = {}) {
  const response = await fetch(url(chat, `messages${query ? "?stream=1" : ""}`), {
    method: "POST", signal, headers: { "content-type": "application/json", ...(!query ? { accept: "text/event-stream" } : {}) },
    body: JSON.stringify({ text }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/event-stream\b/u);
  assert.equal(response.headers.get("x-vercel-ai-ui-message-stream"), "v1");
  return response;
}
async function readSse(response, observe = () => {}) {
  const chunks = [], frames = []; let buffer = "";
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    buffer += value;
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      if (!frame.startsWith("data: ")) continue;
      const data = frame.slice(6); frames.push(data);
      if (data === "[DONE]") continue;
      const chunk = JSON.parse(data); chunks.push(chunk); await observe(chunk);
    }
  }
  assert.equal(buffer, "");
  assert.equal(frames.at(-1), "[DONE]");
  assert.equal(frames.filter(frame => frame === "[DONE]").length, 1);
  return chunks;
}
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
async function startDataService() {
  const child = spawn(process.execPath, ["--experimental-strip-types", join(root, "data-service.mjs")], {
    cwd: root, env: { ...cleanEnv(), DATA_API_TOKEN: dataToken, DATA_API_PORT: String(dataPort) }, stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  let log = "";
  dataService = { child, exited, stderr: () => log };
  child.stdout.on("data", chunk => { log += chunk; });
  child.stderr.on("data", chunk => { log += chunk; });
  await until(async () => { if (child.exitCode !== null || child.signalCode !== null) throw new Error(log); return log.includes("Data service listening"); });
}
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
