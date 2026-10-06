// Clean consumer qualification, with no workspace dependency resolution or provider keys.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const value = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const tarball = resolve(value("--tarball") || join(tmpdir(), "little-setup-packs/little-workflow-0.2.0-alpha.1.tgz"));
const managers = args.includes("--managers") ? value("--managers").split(",") : ["npm", "pnpm"];
const root = await mkdtemp(join(tmpdir(), "little-install-matrix-"));
console.log(`Qualification fixtures and logs: ${root}`);
function run(command, argv, cwd, name) {
  const result = spawnSync(command, argv, { cwd, encoding: "utf8", env: { ...process.env, LITTLE_DEMO: "1", NEXT_TELEMETRY_DISABLED: "1" }, maxBuffer: 10 * 1024 * 1024 });
  if (name) writeFile(join(root, `${name}.log`), `${result.stdout ?? ""}${result.stderr ?? ""}`);
  if (result.status !== 0) throw new Error(`${command} ${argv.join(" ")} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
const packed = JSON.parse(run("tar", ["-xOf", tarball, "package/package.json"], root));
assert.equal(packed.name, "little-workflow");
assert.equal(packed.publishConfig.tag, "alpha");
assert(!JSON.stringify(packed).match(/workspace:|littledb|little-compute/));
assert(packed.exports["./scaffold"]);
const consumer = join(root, "cli-consumer");
await mkdir(consumer);
run("npm", ["install", "--ignore-scripts", "--prefix", consumer, tarball, "ai@^7"], root, "cli-install");
const cli = join(consumer, "node_modules/little-workflow/dist/cli.js");
assert.match(run(process.execPath, [cli, "setup", "--help"], consumer), /--rollback/);
run("npm", ["pack", "--ignore-scripts", "--pack-destination", root], join(consumer, "node_modules/little-workflow"), "npm-pack-outside");
const evidence = [];
for (const manager of managers) {
  assert(["npm", "pnpm", "yarn"].includes(manager));
  for (const template of ["node", "next"]) for (const workflow of [false, true]) {
    const name = `${manager}-${template}-${workflow ? "workflow" : "harness"}`;
    const dir = join(root, name);
    const flags = ["setup", dir, "--template", template, "--package-manager", manager, "--yes", "--no-install", ...(workflow ? ["--workflow"] : [])];
    run(process.execPath, [cli, ...flags], root, `${name}-generate`);
    const manifest = await readFile(join(dir, "package.json"), "utf8");
    const pkg = JSON.parse(manifest);
    assert(!JSON.stringify(pkg).match(/workspace:|latest|littledb|little-compute/));
    if (workflow) {
      // The candidate version is not on npm yet. Replace only this disposable fixture's
      // Workflow dependency with its packed artifact; restore its intended manifest below.
      pkg.dependencies["little-workflow"] = `file:${tarball}`;
      await writeFile(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
    }
    run(manager, ["install", "--ignore-scripts", ...(manager === "pnpm" ? ["--no-frozen-lockfile"] : [])], dir, `${name}-install`);
    if (workflow) run("npm", ["rebuild", "better-sqlite3", "--ignore-scripts=false"], dir, `${name}-native`);
    await writeFile(join(dir, "package.json"), manifest);
    run(process.execPath, [cli, ...flags, "--verify"], root, `${name}-verify`);
    const rerun = JSON.parse(run(process.execPath, [cli, ...flags, "--plan"], root));
    assert.deepEqual(rerun.files, []);
    if (template === "next") {
      run(process.execPath, [join(dir, "node_modules/next/dist/bin/next"), "build"], dir, `${name}-build`);
      assert.deepEqual(JSON.parse(run(process.execPath, [cli, ...flags, "--plan"], root)).files, []);
      const port = 43000 + evidence.length;
      const server = spawn(process.execPath, [join(dir, "node_modules/next/dist/bin/next"), "start", "--port", String(port)], { cwd: dir, stdio: "ignore", env: { ...process.env, LITTLE_DEMO: "1", NEXT_TELEMETRY_DISABLED: "1" } });
      try {
        const url = `http://localhost:${port}`;
        let ready = false;
        for (let i = 0; i < 100; i++) {
          try { if ((await fetch(`${url}/little`)).ok) { ready = true; break; } } catch {}
          await new Promise(accept => setTimeout(accept, 100));
        }
        assert(ready, "Next server started");
        const request = { messages: [{ id: "test", role: "user", parts: [{ type: "text", text: "hello" }] }], userId: "not-auth", id: "not-a-server-session" };
        const response = await fetch(`${url}/api/little/chat`, { method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify(request) });
        assert.equal(response.status, 200);
        const stream = await response.text();
        assert.match(stream, /Hello from Little/);
        if (workflow) assert.match(stream, /starter_echo/);
        assert.equal((await fetch(`${url}/api/little/chat`, { method: "POST", body: "{broken" })).status, 400);
        assert.equal((await fetch(`${url}/api/little/chat`, { method: "POST", headers: { origin: "https://untrusted.example" }, body: JSON.stringify(request) })).status, 403);
      } finally { server.kill("SIGTERM"); await new Promise(accept => server.once("exit", accept)); }
    }
    evidence.push({ manager, template, workflow, install: "passed", typecheck: "passed", keyless: "passed", build: template === "next" ? "passed" : "n/a", rerun: "no-op" });
    console.log(`Passed ${name}`);
  }
}
// Existing Next layouts use custom scripts, aliases, config, env and a pre-existing chat route.
for (const src of [false, true]) {
  const name = `existing-${src ? "src-app" : "app"}`;
  const dir = join(root, name), app = src ? "src/app" : "app";
  await mkdir(join(dir, app, "api/chat"), { recursive: true });
  const preserved = {
    "package.json": JSON.stringify({ name, private: true, type: "module", scripts: { dev: "custom-dev", build: "custom-build" }, dependencies: { next: "^16.3.8", react: "^19.2.7", "react-dom": "^19.2.7" }, devDependencies: { "@types/react": "^19.2.0", "@types/react-dom": "^19.2.0" } }, null, 2),
    "tsconfig.json": '{ // custom alias\n"compilerOptions":{"paths":{"~/*":["./src/*"]},"jsx":"react-jsx"}}',
    "next.config.mjs": 'export default { serverExternalPackages: ["little-harness", "little-workflow"] };\n',
    ".env.local": "CUSTOM_VALUE=unchanged\n",
    [`${app}/layout.tsx`]: 'import type {ReactNode} from "react"; export default function Layout({children}:{children:ReactNode}) {return <html><body>{children}</body></html>}',
    [`${app}/api/chat/route.ts`]: 'export function POST() {return new Response("existing route");}',
  };
  for (const [path, text] of Object.entries(preserved)) await writeFile(join(dir, path), text);
  run("git", ["init", "-q"], dir);
  const flags = [cli, "setup", "--here", "--workflow", "--yes", "--no-install"];
  run(process.execPath, flags, dir, `${name}-generate`);
  for (const [path, text] of Object.entries(preserved)) if (path !== "package.json") assert.equal(await readFile(join(dir, path), "utf8"), text);
  const manifest = await readFile(join(dir, "package.json"), "utf8");
  const pkg = JSON.parse(manifest);
  assert.equal(pkg.scripts.dev, "custom-dev"); assert.equal(pkg.scripts.build, "custom-build");
  pkg.dependencies["little-workflow"] = `file:${tarball}`;
  await writeFile(join(dir, "package.json"), JSON.stringify(pkg));
  run("npm", ["install", "--ignore-scripts"], dir, `${name}-install`);
  run("npm", ["rebuild", "better-sqlite3", "--ignore-scripts=false"], dir, `${name}-native`);
  await writeFile(join(dir, "package.json"), manifest);
  run(process.execPath, [...flags, "--verify"], dir, `${name}-verify`);
  run(process.execPath, [join(dir, "node_modules/next/dist/bin/next"), "build"], dir, `${name}-build`);
  assert.deepEqual(JSON.parse(run(process.execPath, [...flags, "--plan"], dir)).files, []);
  evidence.push({ template: name, manager: "npm", workflow: true, install: "passed", typecheck: "passed", keyless: "passed", build: "passed", customScripts: "preserved", existingChat: "preserved", rerun: "no-op" });
  console.log(`Passed ${name}`);
}
await writeFile(join(root, "evidence.json"), JSON.stringify({ version: packed.version, tarball, evidence }, null, 2));
console.log(`All ${evidence.length} consumer cases passed. Evidence: ${join(root, "evidence.json")}`);
