import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const bundle = (folder: string, name = "support") => ({
  name,
  folder,
  bundle: "export default {}",
  manifest: { tools: [], skills: [] },
  warnings: [],
  inputs: [],
  traversals: [],
  searchPaths: [],
  provenanceInspected: true,
});
vi.mock("../agents/bundle/index.js", () => ({
  bundleAgent: async (folder: string) => bundle(folder),
}));
vi.mock("../agents/bundle/workspace.js", () => ({
  bundleWorkspace: async (folder: string) => [
    bundle(folder),
    bundle(folder, "research"),
  ],
}));
vi.mock("./git.js", () => ({
  git: () => undefined,
  GitProvenance: class {
    dirty() {
      return false;
    }
    hasRepository() {
      return false;
    }
  },
}));
import { main } from "./main.js";
import { commandHint } from "./messages.js";

let home: string;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "onb-command-"));
  vi.stubEnv("HOME", home);
  for (const name of [
    "LITTLEDB_URL",
    "LITTLEDB_MANAGEMENT_KEY",
    "LITTLEDB_AGENTS_URL",
    "LITTLEDB_AGENTS_KEY",
    "LITTLEDB_PROJECT",
    "LITTLEDB_API_KEY",
    "npm_command",
  ]) {
    vi.stubEnv(name, "");
    delete process.env[name];
  }
});
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
  await rm(home, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function service(
  reply: (path: string, body: any) => { status?: number; body: unknown },
) {
  const requests: Array<{ path: string; body: any }> = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    requests.push({ path: req.url!, body });
    const result = reply(req.url!, body);
    res.statusCode = result.status ?? 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  vi.stubEnv("LITTLEDB_AGENTS_URL", url);
  vi.stubEnv("LITTLEDB_URL", url);
  vi.stubEnv("LITTLEDB_MANAGEMENT_KEY", "ldbm_synthetic_test");
  vi.stubEnv("LITTLEDB_PROJECT", "project");
  return { url, requests };
}
function output() {
  const lines: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((line: any) => {
    lines.push(String(line));
    return true;
  });
  return () => lines.join("");
}
function deployed(reporting: unknown) {
  return {
    deployment: { number: 3 },
    branch: { url: "http://localhost/c/demo", production: false },
    productionUrl: "http://localhost/c/prod",
    agent: { productionBranch: "main" },
    reporting,
  };
}
test.each([false, true])(
  "deploy hints are copyable and npx-aware (npx=%s)",
  async (npx) => {
    vi.stubEnv("npm_command", npx ? "exec" : "");
    await service(() => ({
      body: deployed({
        ok: false,
        code: "key_exists",
        reason: "Reporting key exists",
      }),
    }));
    const printed = output();
    await main(["deploy", home, "--branch", "dev", "--rotate-tracing-key"]);
    expect(printed()).toContain(
      `Next: ${commandHint("chat support --branch dev")}`,
    );
    expect(printed()).toContain(
      `To ship it: ${commandHint("promote support dev")}`,
    );
    expect(printed().split("\n")).toContain(
      commandHint(`deploy ${home} --branch dev --rotate-tracing-key`),
    );
    expect(printed()).not.toContain("--rotate-tracing-key.");
  },
);
test("a workspace rotates the project's key only on its first deployment", async () => {
  const { requests } = await service(() => ({
    body: deployed({ ok: true, project: "project" }),
  }));
  output();
  await main([
    "deploy",
    home,
    "--all",
    "--branch",
    "dev",
    "--rotate-tracing-key",
  ]);
  expect(requests.map((r) => r.body.rotateTracingKey)).toEqual([
    true,
    undefined,
  ]);
});
test("empty agents hints use the versioned npx command", async () => {
  vi.stubEnv("npm_command", "exec");
  await service(() => ({ body: { agents: [] } }));
  const printed = output();
  await main(["agents"]);
  expect(printed()).toContain(commandHint("deploy <folder>"));
});
test.each([
  ["schedules", "support"],
  ["credits"],
  ["limits", "support"],
  ["retention", "support"],
  ["webhooks", "support"],
  ["email", "support"],
  ["user-secret", "support"],
])("developer command %s reaches its handler", async (...args) => {
  const { requests } = await service(() => ({
    status: 404,
    body: { error: "handler reached" },
  }));
  await expect(main(args)).rejects.toThrow("404: handler reached");
  expect(requests.length).toBeGreaterThan(0);
});
test.each([false, true])(
  "preserves non-scope 403 reasons (legacy=%s)",
  async (legacy) => {
    const { url } = await service(() => ({
      status: 403,
      body: { error: "End-user deletion is disabled." },
    }));
    await expect(
      main(["agents", "--url", url, "--key", "ldbak_synthetic"], legacy),
    ).rejects.toThrow(/^403: End-user deletion is disabled\.$/);
  },
);
test("adds sign-in guidance only for a scope refusal", async () => {
  vi.stubEnv("npm_command", "exec");
  await service(() => ({
    status: 403,
    body: { error: "This needs a management key with the deploy scope." },
  }));
  await expect(main(["agents"])).rejects.toThrow(commandHint("login"));
});
test("piped chat failure exits the compiled command with status one", async () => {
  const { url } = await service((path) =>
    path.endsWith("/chat")
      ? { status: 400, body: { error: "The model key is not set." } }
      : { body: { agent: "support", branch: "dev", version: { number: 1 } } },
  );
  // Build the actual entry point so a clean checkout cannot test stale or absent output.
  const packageDir = fileURLToPath(new URL("../../", import.meta.url));
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
    cwd: packageDir,
    stdio: "pipe",
  });
  const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
  const result = await new Promise<{ code: number | null; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [cli, "chat", url], {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });
      let stderr = "";
      child.stdout.resume();
      child.stderr.on("data", (data) => {
        stderr += String(data);
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stderr }));
      child.stdin.end("hello\n");
    },
  );
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("The model key is not set.");
}, 30_000);

test("a failed first workspace deployment never repeats a requested rotation", async () => {
  let attempts = 0;
  const { requests } = await service(() => {
    attempts++;
    return attempts === 1
      ? { status: 500, body: { error: "Deployment answer lost." } }
      : { body: deployed({ ok: true, project: "project" }) };
  });
  output();
  await expect(
    main(["deploy", home, "--all", "--branch", "dev", "--rotate-tracing-key"]),
  ).rejects.toThrow("Workspace deployment incomplete");
  expect(requests.map((request) => request.body.rotateTracingKey)).toEqual([
    true,
    undefined,
  ]);
});

test("npx help pins hints to this package's own version", async () => {
  vi.stubEnv("npm_command", "exec");
  const printed = output();
  await main(["help"]);
  expect(printed()).toMatch(
    /npx @little-stack\/littledb@\d+\.\d+\.\d+[^ ]* <command>/,
  );
  expect(printed()).not.toContain("@alpha");
});

async function isolatedServer(
  handler: (path: string, authorization: string | undefined) => unknown,
) {
  const requests: Array<{ path: string; authorization: string | undefined }> =
    [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url!, authorization: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(handler(req.url!, req.headers.authorization)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    requests,
  };
}

test.each([false, true])(
  "legacy saved management key follows only its saved service's control address (legacy=%s)",
  async (legacy) => {
    const control = await isolatedServer(() => ({ models: [], agents: [] }));
    const service = await isolatedServer(() => ({ littledbUrl: control.url }));
    const other = await isolatedServer(() => ({ models: [], agents: [] }));
    await mkdir(join(home, ".config/littledb"), { recursive: true });
    await writeFile(
      join(home, ".config/littledb/agents.json"),
      JSON.stringify({ url: service.url, key: "ldbm_legacy", project: "p" }),
    );
    output();
    for (const explicitAddress of [false, true]) {
      vi.stubEnv("LITTLEDB_URL", explicitAddress ? control.url : "");
      await main(["models"], legacy);
    }
    expect(
      service.requests.every(
        (r) => r.path === "/v1/me" && r.authorization === "Bearer ldbm_legacy",
      ),
    ).toBe(true);
    expect(control.requests).toHaveLength(2);
    expect(
      control.requests.every(
        (r) =>
          r.path === "/v1/agent-models" &&
          r.authorization === "Bearer ldbm_legacy",
      ),
    ).toBe(true);
    vi.stubEnv("LITTLEDB_URL", other.url);
    await expect(main(["models"], legacy)).rejects.toThrow(
      "You are signed in to",
    );
    await expect(
      main(["models", "--littledb-url", other.url], legacy),
    ).rejects.toThrow("You are signed in to");
    expect(other.requests).toEqual([]);
  },
);

test.each([false, true])(
  "never sends an agents key to LittleDB (legacy=%s)",
  async (legacy) => {
    const control = await isolatedServer(() => ({ models: [], agents: [] }));
    const service = await isolatedServer(() => ({ littledbUrl: control.url }));
    vi.stubEnv("LITTLEDB_AGENTS_URL", service.url);
    vi.stubEnv("LITTLEDB_AGENTS_KEY", "ldbak_agents_only");
    vi.stubEnv("LITTLEDB_URL", control.url);
    vi.stubEnv("LITTLEDB_API_KEY", "ldb_project_only");
    output();
    await main(["models"], legacy);
    expect(control.requests[0]?.authorization).toBe("Bearer ldb_project_only");
    expect(service.requests).toEqual([]);
    await main(["models", "--key", "ldbak_flag_only"], legacy);
    expect(control.requests[1]?.authorization).toBe("Bearer ldb_project_only");
  },
);

test("workspace repair prints once after the final agent", async () => {
  await service(() => ({
    body: deployed({
      ok: false,
      code: "partial_secrets",
      reason: "Incomplete reporting",
    }),
  }));
  const printed = output();
  await main(["deploy", home, "--all", "--branch", "dev"]);
  const text = printed();
  expect(text.match(/Repair \(the old tracing key/g)).toHaveLength(1);
  expect(text.match(/--rotate-tracing-key/g)).toHaveLength(1);
  expect(text.indexOf("Repair (")).toBeGreaterThan(text.lastIndexOf("Next:"));
});

test("pnpm dlx hints retain the installed package version", () => {
  vi.stubEnv("npm_command", "dlx");
  expect(commandHint("status support")).toBe(
    "pnpm dlx @little-stack/littledb@0.2.0-alpha.4 status support",
  );
});
