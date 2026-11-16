import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createServer, type Server } from "node:http";
import {
  mkdtemp,
  readFile,
  stat,
  rm,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  login,
  config,
  logout,
  whoami,
  safeMessage,
  boundControlKey,
} from "./auth.js";
let home: string, server: Server, url: string;
let poll: Record<string, unknown>[];
let seen: any[];
let agentsUrl: string | null;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "onb-login-"));
  vi.stubEnv("HOME", home);
  for (const k of [
    "LITTLEDB_URL",
    "LITTLEDB_MANAGEMENT_KEY",
    "LITTLEDB_AGENTS_URL",
    "LITTLEDB_AGENTS_KEY",
    "LITTLEDB_PROJECT",
    "LITTLEDB_API_KEY",
    "npm_command",
  ])
    vi.stubEnv(k, "");
  poll = [];
  seen = [];
  agentsUrl = "http://127.0.0.1:9000";
  server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ url: req.url, body: body ? JSON.parse(body) : null });
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/api/org/key?"))
      return void res.end(
        JSON.stringify({
          organization: { slug: "org", name: "Organization" },
          project: { slug: "project", name: "Project" },
          key: { scopes: ["read", "deploy"] },
        }),
      );
    if (req.url === "/api/cli/config")
      return void res.end(JSON.stringify({ agentsUrl, signIn: true }));
    if (req.url === "/api/cli/logins")
      return void res.end(
        JSON.stringify({
          code: "ABCD-EFGH",
          verifyUrl: url + "/cli/ABCDEFGH",
          expiresAt: 0,
          interval: 0,
        }),
      );
    if (req.url === "/api/cli/logins/poll") {
      const data = poll.shift() ?? { status: "pending" };
      res.statusCode = Number(data.http ?? 200);
      if (data.http === 429) res.setHeader("Retry-After", "3");
      return void res.end(JSON.stringify(data));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});
const approved = {
  status: "approved",
  key: "ldbm_fake_for_test",
  organization: { slug: "org", name: "Organization" },
  project: { slug: "project", name: "Project" },
  agentsUrl: "http://127.0.0.1:9000",
};
const opts = {
  sleep: async (_ms: number) => {},
  openBrowser: (_url: string) => {},
  device: "work\n\u0085\u202estation",
};
test("browser login saves mode 0600 and never prints the delivered key", async () => {
  poll = [approved];
  const lines: string[] = [];
  await login({ url, project: "project" }, (line) => lines.push(line), opts);
  expect(
    (await stat(join(home, ".config/littledb/config.json"))).mode & 0o777,
  ).toBe(0o600);
  await whoami((line) => lines.push(line));
  expect(lines.join("\n")).not.toContain(approved.key);
  expect(lines.join("\n")).toContain("Organization / Project");
});

test("login strips rejected controls from the device and hashes the poll secret", async () => {
  poll = [approved];
  await login({ url }, () => {}, opts);
  const started = seen.find(
    (request) => request.url === "/api/cli/logins",
  ).body;
  expect(started.device).toBe("workstation");
  expect(started.pollSecretHash).toMatch(/^[a-f0-9]{64}$/);
});

test("login obeys Retry-After rather than ending on the terminal clock", async () => {
  poll = [{ http: 429 }, { status: "pending" }, approved];
  const sleep = vi.fn(async () => {});
  await login({ url }, () => {}, { ...opts, sleep });
  expect(sleep).toHaveBeenCalledWith(3000);
});

test("409 repeats quietly until its message changes and polling continues", async () => {
  poll = [
    { http: 409, error: { message: "Key limit reached" } },
    { http: 409, error: { message: "Key limit reached" } },
    { http: 409, error: { message: "Choose a key to revoke" } },
    approved,
  ];
  const lines: string[] = [];
  await login({ url }, (line) => lines.push(line), opts);
  expect(lines.filter((line) => line === "Key limit reached")).toHaveLength(1);
  expect(
    lines.filter((line) => line === "Choose a key to revoke"),
  ).toHaveLength(1);
});

test.each(["denied", "expired"])("terminal %s ends sign-in", async (status) => {
  poll = [{ status }];
  await expect(login({ url }, () => {}, opts)).rejects.toThrow(status);
});
test("interrupted sign-in resumes saved code and secret rather than starting another", async () => {
  poll = [{ http: 503 }];
  await expect(login({ url }, () => {}, opts)).rejects.toThrow("resume");
  const pending = await readFile(
    join(home, ".config/littledb/login-pending.json"),
    "utf8",
  );
  poll = [approved];
  await login({ url }, () => {}, opts);
  expect(seen.filter((x) => x.url === "/api/cli/logins")).toHaveLength(1);
  expect(
    seen
      .filter((x) => x.url === "/api/cli/logins/poll")
      .map((x) => x.body.pollSecret),
  ).toEqual([JSON.parse(pending).pollSecret, JSON.parse(pending).pollSecret]);
});
test("env-only discovers service and supports absent service message", async () => {
  vi.stubEnv("LITTLEDB_URL", url);
  vi.stubEnv("LITTLEDB_MANAGEMENT_KEY", "ldbm_ci");
  vi.stubEnv("LITTLEDB_PROJECT", "project");
  expect(await config({})).toMatchObject({
    url: agentsUrl,
    key: "ldbm_ci",
    project: "project",
  });
  agentsUrl = null;
  await expect(config({})).rejects.toThrow(
    "still send runs with the client library",
  );
});

test("paste login and env-only whoami use management inspection without exposing credentials", async () => {
  const lines: string[] = [];
  await login(
    { url, key: "ldbm_script_test", project: "project" },
    (s) => lines.push(s),
    opts,
  );
  const saved = JSON.parse(
    await readFile(join(home, ".config/littledb/config.json"), "utf8"),
  );
  expect(saved.key).toBe("ldbm_script_test");
  expect(saved.scopes).toEqual(["read", "deploy"]);
  await logout(() => {});
  vi.stubEnv("LITTLEDB_URL", url);
  vi.stubEnv("LITTLEDB_MANAGEMENT_KEY", "ldbm_env_test");
  vi.stubEnv("LITTLEDB_PROJECT", "project");
  await whoami((s) => lines.push(s));
  expect(lines.join("")).toContain("Organization / Project");
  expect(lines.join("")).not.toContain("ldbm_");
});

async function storeLogin(savedUrl = "https://saved.example") {
  await mkdir(join(home, ".config/littledb"), { recursive: true });
  await writeFile(
    join(home, ".config/littledb/config.json"),
    JSON.stringify({
      url: savedUrl,
      agentsUrl: "https://agents.saved.example",
      key: "ldbm_" + "a".repeat(43),
      organization: { slug: "org", name: "Organization" },
      project: { slug: "project", name: "Project" },
    }),
  );
}

test.each(["flag", "environment"])(
  "saved keys cannot follow an alternate %s address",
  async (source) => {
    await storeLogin();
    const flags = source === "flag" ? { url } : {};
    if (source === "environment") vi.stubEnv("LITTLEDB_URL", url);
    await expect(config(flags)).rejects.toThrow(
      `You are signed in to https://saved.example, not ${url}`,
    );
    await expect(whoami(() => {}, flags)).rejects.toThrow(
      "You are signed in to",
    );
    await expect(boundControlKey({}, url)).rejects.toThrow(
      "You are signed in to",
    );
    expect(seen).toHaveLength(0);
  },
);

test.each(["flag", "environment"])(
  "an explicit %s key retains caller-chosen destination behavior",
  async (source) => {
    await storeLogin();
    const flags =
      source === "flag"
        ? { url, key: "ldbm_explicit", project: "project" }
        : { url };
    if (source === "environment")
      vi.stubEnv("LITTLEDB_MANAGEMENT_KEY", "ldbm_explicit");
    expect(await config(flags)).toMatchObject({
      key: "ldbm_explicit",
      url: agentsUrl,
    });
    expect(await boundControlKey(flags, url)).toBe("ldbm_explicit");
  },
);

test("saved keys cannot follow an agents service override", async () => {
  await storeLogin();
  vi.stubEnv("LITTLEDB_AGENTS_URL", url);
  const error = await config({}).catch((error) => error);
  expect(error.message).toContain("another agents service");
  expect(error.message).toContain("--key or LITTLEDB_MANAGEMENT_KEY");
  expect(error.message).not.toContain("login --url");
  expect(seen).toHaveLength(0);
});

test("missing-address messages distinguish absent configuration from no agents service", async () => {
  vi.stubEnv("LITTLEDB_MANAGEMENT_KEY", "ldbm_explicit");
  await expect(config({})).rejects.toThrow("No LittleDB address is known");
  await expect(login({}, () => {}, opts)).rejects.toThrow(
    "Usage: littledb login --url",
  );
});

test("npx sign-in hints use this package version", async () => {
  vi.stubEnv("npm_command", "exec");
  const packageJson = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  await expect(config({ url })).rejects.toThrow(
    `npx @little-stack/littledb@${packageJson.version} login --url ${url}`,
  );
});

test("logout names deletion of the older once-shown project-key sign-in", async () => {
  await storeLogin();
  await writeFile(
    join(home, ".config/littledb/agents.json"),
    JSON.stringify({ key: "ldbak_once_shown" }),
  );
  const lines: string[] = [];
  await logout((line) => lines.push(line));
  expect(lines.join("\n")).toContain("legacy agents.json");
  await expect(
    readFile(join(home, ".config/littledb/agents.json")),
  ).rejects.toThrow();
});

test("redaction matches complete key shapes, preserving ordinary agent and branch names", () => {
  expect(safeMessage("ldb_demo ldbm_feature ldbak_local")).toBe(
    "ldb_demo ldbm_feature ldbak_local",
  );
  for (const key of [
    "ldb_" + "a".repeat(32),
    "ldbm_" + "b".repeat(43),
    "ldbak_" + "c".repeat(32),
    "ldbak_" + "Ab_9-".repeat(5),
    "ldbm_" + "b".repeat(42),
    "ldbm_" + "b".repeat(44),
    "ldb_" + "a".repeat(33),
  ])
    expect(safeMessage(`Key: ${key}.`)).toBe("Key: [redacted].");
});

test("logout names only files actually removed, and is honest on a second call", async () => {
  await mkdir(join(home, ".config/littledb"), { recursive: true });
  await writeFile(join(home, ".config/littledb/agents.json"), "{}");
  const lines: string[] = [];
  await logout((line) => lines.push(line));
  expect(lines[0]).toContain("Removed legacy agents.json.");
  expect(lines[0]).not.toContain("config.json");
  expect(lines[0]).not.toContain("login-pending.json");
  await logout((line) => lines.push(line));
  expect(lines[1]).toContain("No saved sign-in files were present.");
});
