import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, generateHarness, localHost } from "@little-stack/harness";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { littleDBFromEnv } from "./client.js";
import { isManagedMemory } from "./memory.js";
import { testLittleDB } from "./testing.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

type Desk = { userId: string; name: string; bankId: string; role: "officer" | "underwriter" };
const dana: Desk = { userId: "u_dana", name: "Dana", bankId: "bank_17", role: "underwriter" };
const carol: Desk = { userId: "u_carol", name: "Carol", bankId: "bank_17", role: "officer" };

/** What the agent does for each message: write a rule, write a preference, read a rule, or just answer. */
const WRITES: Record<string, { tool: string; input: Record<string, string> } | undefined> = {
  TEACH: { tool: "write_file", input: { path: "/persistent/org/lending-rules/rules/self-employed.md", content: "---\ndescription: Refer self-employed applicants under 12 months.\n---\n" } },
  PREFER: { tool: "write_file", input: { path: "/persistent/me/style.md", content: "---\ndescription: Short answers, numbers first.\n---\n" } },
  READ: { tool: "read_file", input: { path: "/persistent/org/lending-rules/rules/debt-to-income.md" } },
  LIST: { tool: "list_files", input: { path: "/persistent/org/lending-rules/rules" } },
};

function deskModel() {
  const systems: Record<string, string> = {};
  const results: Record<string, string> = {};
  const model = new MockLanguageModelV3({
    provider: "test",
    modelId: "desk",
    doGenerate: async (options) => {
      const prompt = JSON.stringify(options.prompt);
      const ask = /"text":"(TEACH|PREFER|READ|LIST|ASK)[^"]*"/u.exec(prompt)?.[1] ?? "?";
      const write = WRITES[ask];
      if (prompt.includes("tool-result") || write === undefined) {
        if (prompt.includes("tool-result")) results[ask] = prompt;
        else systems[ask] = options.prompt.filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
        return { content: [{ type: "text", text: "done" }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] };
      }
      systems[ask] = options.prompt.filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
      return {
        content: [{ type: "tool-call", toolCallId: `call_${ask}`, toolName: write.tool, input: JSON.stringify(write.input) }],
        finishReason: { unified: "tool-calls", raw: "tool-calls" },
        usage,
        warnings: [],
      };
    },
  });
  return { model, systems, results };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "littledb-memory-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(errors: unknown[] = []) {
  const server = testLittleDB({ onError: (error) => errors.push(error) });
  const { model, systems, results } = deskModel();
  const desk = server.db.managedHarness({ slug: "loan-desk", bootstrap: { system: "You run the loan desk." } });
  const harness = createHarness<any, Desk>({
    host: localHost({ dataDir: dir }),
    model,
    runtime: { bash: false },
    turnOptions: desk.turnOptions,
    memory: [
      server.db.memory.org<Desk>({
        space: "lending-rules",
        org: ({ extraBody }) => extraBody?.bankId,
        description: "The bank's lending rules. Only underwriters change them.",
        canWrite: ({ extraBody }) => extraBody?.role === "underwriter",
        by: ({ extraBody }) => extraBody && { id: extraBody.userId, label: extraBody.name, role: extraBody.role },
        seed: { "rules/debt-to-income.md": "---\ndescription: Decline above 45% debt-to-income.\n---\n" },
      }),
      server.db.memory.user<Desk>({
        user: ({ extraBody }) => extraBody && { id: extraBody.userId, label: extraBody.name },
        org: ({ extraBody }) => extraBody?.bankId,
        description: "This person's own preferences.",
      }),
    ],
  });
  const turn = (text: string, session: string, who: Desk) =>
    generateHarness({ harness, messages: [{ id: `${session}-${text}`, role: "user", parts: [{ type: "text", text }] }] as any, session, extraBody: who });
  return { server, harness, desk, turn, systems, results };
}

describe("db.memory.org and db.memory.user", () => {
  it("return ordinary memory options", () => {
    const server = testLittleDB();
    const org = server.db.memory.org({ space: "lending-rules" });
    expect(org).toMatchObject({ harnessDir: "/persistent/org/lending-rules", instructions: expect.stringContaining("waiting for review") });
    expect(typeof org.backend?.load).toBe("function");
    expect(isManagedMemory(org)).toBe(true);
    expect(server.db.memory.user({ user: () => "u1" }).harnessDir).toBe("/persistent/me");
    expect(server.db.memory.org({ space: "faq", review: "after" }).instructions).toBeUndefined();
    expect(() => server.db.memory.org({ space: "Lending Rules" })).toThrow(TypeError);
  });

  it("seeds org memory, and an underwriter's change waits for a person", async () => {
    const { server, desk, turn, systems } = setup();
    const taught = await turn("TEACH the 12 month rule", "dana-1", dana);
    expect(taught.status).toBe("completed");
    expect(systems.TEACH).toContain("- rules/debt-to-income.md: Decline above 45% debt-to-income.");
    expect(systems.TEACH).toContain("tell the person it is waiting for review");

    const [change] = server.memory.waiting();
    expect(change).toMatchObject({
      space: "lending-rules",
      org: "bank_17",
      sessionId: "dana-1",
      by: { id: "u_dana", label: "Dana", role: "underwriter" },
      said: "TEACH the 12 month rule",
      traceId: desk.tracer?.traceIdFor("dana-1"),
      edits: [{ path: "rules/self-employed.md", op: "put" }],
    });
    // Not live yet: the seed is all the org has.
    expect(Object.keys(server.memory.files("lending-rules", { org: "bank_17" }))).toEqual(["rules/debt-to-income.md"]);

    // Dana's own conversation keeps her change; Carol's doesn't see it until it is approved.
    await turn("ASK again", "dana-1", dana);
    expect(systems.ASK).toContain("rules/self-employed.md");
    await turn("ASK", "carol-1", carol);
    expect(systems.ASK).not.toContain("rules/self-employed.md");
    server.memory.approve(change!.id);
    await turn("ASK now", "carol-2", carol);
    expect(systems.ASK).toContain("- rules/self-employed.md: Refer self-employed applicants under 12 months.");
  });

  it("keeps org memory read-only for an officer, and stores nothing", async () => {
    const { server, turn, systems, results } = setup();
    const tried = await turn("TEACH it anyway", "carol-1", carol);
    expect(tried.status).toBe("completed");
    expect(systems.TEACH).toContain("This memory is read-only in this conversation");
    expect(results.TEACH).toContain("read-only");
    expect(server.memory.changes).toHaveLength(0);
    expect(server.requests.filter((r) => r.path === "/v1/memory/store")).toHaveLength(0);
  });

  it("saves a person's memory at once, and traces what each turn carried", async () => {
    const { server, desk, turn } = setup();
    await turn("PREFER short answers", "carol-1", carol);
    expect(server.memory.files("me", { org: "bank_17", user: "u_carol" })).toEqual({ "style.md": "---\ndescription: Short answers, numbers first.\n---\n" });
    expect(server.memory.files("me", { org: "bank_17", user: "u_dana" })).toEqual({});

    await server.db.flush();
    const spans = server.spansOf(desk.tracer!.traceIdFor("carol-1")!);
    const loads = spans.filter((s) => s.type === "retrieval").map((s) => s.attributes?.memory as Record<string, unknown>);
    expect(loads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ layer: "org", space: "lending-rules", writable: false, snapshot: expect.stringMatching(/^msnap_/u), review: "person" }),
        expect.objectContaining({ layer: "user", space: "me", writable: true, snapshot: expect.stringMatching(/^msnap_/u) }),
      ]),
    );
    const saved = spans.find((s) => s.type === "event" && s.name === "memory me saved");
    expect(saved?.attributes?.memory).toMatchObject({ status: "saved", created: ["/persistent/me/style.md"] });

    // A turn that changes nothing saves nothing, so its trace has no saved events.
    await turn("ASK what you remember", "carol-2", carol);
    await server.db.flush();
    const quiet = server.spansOf(desk.tracer!.traceIdFor("carol-2")!);
    expect(quiet.filter((s) => s.type === "retrieval")).toHaveLength(2);
    expect(quiet.filter((s) => s.type === "event" && s.name.endsWith(" saved"))).toEqual([]);
  });

  it("keeps each turn's memory spans apart when the turns share one trace", async () => {
    const server = testLittleDB();
    // Each turn saves a new preference. The provider numbers tool calls per turn: both are `call_1`.
    let saves = 0;
    const model = new MockLanguageModelV3({
      provider: "test",
      modelId: "desk",
      doGenerate: async (options) => {
        if (options.prompt.at(-1)?.role === "tool") return { content: [{ type: "text", text: "noted" }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] };
        saves += 1;
        const input = { path: "/persistent/me/style.md", content: `---\ndescription: Preference ${saves}.\n---\n` };
        return { content: [{ type: "tool-call", toolCallId: "call_1", toolName: "write_file", input: JSON.stringify(input) }], finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage, warnings: [] };
      },
    });
    // One trace for the whole conversation, as an eval worker's multi-turn episode has.
    const tracer = server.db.harnessTracer({ harness: "loan-desk", traceId: "episode_1" });
    const harness = createHarness<any, Desk>({
      host: localHost({ dataDir: dir }),
      model,
      runtime: { bash: false },
      onEvent: tracer.onEvent,
      memory: [server.db.memory.user<Desk>({ user: ({ extraBody }) => extraBody && { id: extraBody.userId, label: extraBody.name }, org: ({ extraBody }) => extraBody?.bankId })],
    });
    for (const text of ["PREFER short answers", "PREFER numbers first"]) {
      await generateHarness({ harness, messages: [{ id: text, role: "user", parts: [{ type: "text", text }] }] as any, session: "carol-1", extraBody: carol });
    }
    await server.db.flush();

    const spans = server.spansOf("episode_1");
    const turns = spans.filter((s) => s.parentId === "root").map((s) => s.id);
    expect(turns).toHaveLength(2);
    // Each turn loaded the memory, wrote it with its tool call, and saved it.
    for (const kind of ["retrieval", "event", "tool"]) {
      const own = spans.filter((s) => s.type === kind);
      expect(own.map((s) => s.parentId).sort(), kind).toEqual([...turns].sort());
    }
  });

  it("traces which memory files each step read and wrote, and each change names the step that wrote it", async () => {
    const { server, desk, turn } = setup();
    await turn("TEACH the 12 month rule", "dana-1", dana);
    await turn("READ the debt rule", "dana-2", dana);
    await turn("LIST the rules", "dana-3", dana);
    await server.db.flush();

    const taught = server.spansOf(desk.tracer!.traceIdFor("dana-1")!).find((s) => s.type === "tool");
    expect(taught?.attributes?.memoryAccess).toEqual({
      how: "tool",
      files: [{ layer: "org", space: "lending-rules", path: "rules/self-employed.md", op: "write" }],
    });
    // The change says which step wrote each file, so LittleDB can show the moment it was taught.
    const store = server.requests.find((r) => r.path === "/v1/memory/store");
    expect(store?.body).toMatchObject({ steps: { "rules/self-employed.md": taught!.id } });

    const read = server.spansOf(desk.tracer!.traceIdFor("dana-2")!).find((s) => s.type === "tool");
    expect(read?.attributes?.memoryAccess).toEqual({
      how: "tool",
      files: [{ layer: "org", space: "lending-rules", path: "rules/debt-to-income.md", op: "read", revision: expect.any(String) }],
    });
    // Its revision is the one the turn carried.
    const carried = server.spansOf(desk.tracer!.traceIdFor("dana-2")!).find((s) => s.type === "retrieval" && s.name === "memory lending-rules");
    expect(carried?.attributes?.memory).toMatchObject({ snapshot: expect.stringMatching(/^msnap_/u) });

    const listed = server.spansOf(desk.tracer!.traceIdFor("dana-3")!).find((s) => s.type === "tool");
    expect(listed?.attributes?.memoryAccess).toEqual({ how: "tool", files: [], listed: ["lending-rules"] });
  });

  it("an outage keeps the conversation going on the last copy, and says the change was not saved", async () => {
    const errors: unknown[] = [];
    const { server, turn, systems } = setup(errors);
    await turn("ASK first", "dana-1", dana);
    server.setDown(true);
    const taught = await turn("TEACH while down", "dana-2", dana);
    expect(taught.status).toBe("completed");
    expect(systems.TEACH).toContain("rules/debt-to-income.md");
    expect(errors.map((e) => String((e as Error).message)).join("\n")).toMatch(/were not saved/u);
    server.setDown(false);
    expect(server.memory.changes).toHaveLength(0);
  });

  it("lets a person see and forget their own memory through your app", async () => {
    const { server, turn } = setup();
    await turn("PREFER", "carol-1", carol);
    const handler = server.db.memory.handler({ authorize: (request) => (request.headers.get("x-user") === "carol" ? { user: "u_carol", org: "bank_17" } : null) });
    expect((await handler(new Request("http://app/api/memory"))).status).toBe(401);
    const mine = await handler(new Request("http://app/api/memory", { headers: { "x-user": "carol" } }));
    expect(await mine.json()).toEqual({ spaces: [{ space: "me", description: null, files: [{ path: "style.md", summary: null, content: expect.stringContaining("numbers first"), updatedAt: null }] }] });
    expect((await handler(new Request("http://app/api/memory", { method: "DELETE", headers: { "x-user": "carol" } }))).status).toBe(400);
    const one = await handler(new Request("http://app/api/memory?space=me&path=style.md", { method: "DELETE", headers: { "x-user": "carol" } }));
    expect(await one.json()).toEqual({ forgotten: "style.md" });
    expect(server.memory.files("me", { org: "bank_17", user: "u_carol" })).toEqual({});

    await turn("PREFER", "carol-2", carol);
    expect(await server.db.memory.forgetUser({ user: "u_carol", org: "bank_17" })).toEqual({ files: 1 });
  });

  it("a managed workflow reads org memory read-only, and its trace says which revisions", async () => {
    const { server, turn } = setup();
    await turn("ASK", "dana-1", dana);
    const returns = server.db.managedWorkflow({
      slug: "credit-check",
      bootstrap: { steps: { decide: { system: "Decide." } } },
      memory: [server.db.memory.org({ space: "lending-rules", org: () => "bank_17" })],
    });
    const run = await returns.prepare({ stickyKey: "app_1" });
    expect(run.memory.loaded[0]).toMatchObject({ space: "lending-rules", snapshot: expect.stringMatching(/^msnap_/u) });
    expect(run.memory.note()).toContain("### rules/debt-to-income.md");
    expect(server.requests.filter((r) => r.path === "/v1/memory/load").at(-1)?.body).toMatchObject({ writable: false, subject: "workflow:credit-check", session: "app_1" });
  });
});

describe("offline", () => {
  it("keeps managed memory in local folders, seeded from the repo", async () => {
    const db = littleDBFromEnv({}, { LITTLEDB_MEMORY_DIR: join(dir, "memory") });
    expect(db.offline).toBe(true);
    const { model } = deskModel();
    const harness = createHarness<any, Desk>({
      host: localHost({ dataDir: join(dir, "data") }),
      model,
      runtime: { bash: false },
      memory: [
        db.memory.org<Desk>({
          space: "lending-rules",
          org: ({ extraBody }) => extraBody?.bankId,
          canWrite: ({ extraBody }) => extraBody?.role === "underwriter",
          seed: { "rules/debt-to-income.md": "Decline above 45%.\n" },
        }),
      ],
    });
    const result = await generateHarness({ harness, messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "TEACH" }] }] as any, session: "s1", extraBody: dana });
    expect(result.status).toBe("completed");
    const folder = join(dir, "memory", "org", "bank_17", "lending-rules");
    expect(await readFile(join(folder, "rules", "debt-to-income.md"), "utf8")).toBe("Decline above 45%.\n");
    expect(await readFile(join(folder, "rules", "self-employed.md"), "utf8")).toContain("12 months");

    // A person's own folders: your app's handler shows and forgets them offline too.
    const mine = join(dir, "memory", "people", "bank_17", "u_dana", "me");
    await mkdir(join(mine, "notes"), { recursive: true });
    await writeFile(join(mine, "prefs.md"), "---\ndescription: Short answers\n---\nNumbers first.\n");
    await writeFile(join(mine, "notes", "acme.md"), "Acme Bakery is a repeat client.\n");
    const handler = db.memory.handler({ authorize: () => ({ user: "u_dana", org: "bank_17" }) });
    const listed = await (await handler(new Request("http://app/memory"))).json();
    expect(listed.spaces).toEqual([
      expect.objectContaining({ space: "me", files: expect.arrayContaining([expect.objectContaining({ path: "prefs.md", summary: "Short answers" }), expect.objectContaining({ path: "notes/acme.md", summary: "Acme Bakery is a repeat client." })]) }),
    ]);
    expect((await handler(new Request("http://app/memory?space=me&path=../x.md", { method: "DELETE" }))).status).toBe(400);
    expect(await (await handler(new Request("http://app/memory?space=me&path=prefs.md", { method: "DELETE" }))).json()).toEqual({ forgotten: "prefs.md" });
    expect(await db.memory.forgetUser({ user: "u_dana", org: "bank_17" })).toEqual({ files: 1 });
    expect((await (await handler(new Request("http://app/memory"))).json()).spaces).toEqual([]);
  });
});
