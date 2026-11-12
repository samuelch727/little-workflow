import { withNextServer } from "./verify-next-server.mjs";
import { writeFileSync } from "node:fs";
// Clean consumer qualification, with no workspace dependency resolution or provider keys.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const value = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const tarball = resolve(value("--tarball") || join(tmpdir(), "little-setup-packs/little-stack-workflow-0.2.0-alpha.3.tgz"));
const managers = args.includes("--existing-only") ? [] : args.includes("--managers") ? value("--managers").split(",") : ["npm", "pnpm"];
const templates = args.includes("--templates") ? value("--templates").split(",") : ["node", "next"];
// An unpublished Harness candidate: generated fixtures and the CLI consumer resolve it from this tarball.
const harnessTarball = value("--harness-tarball") && resolve(value("--harness-tarball"));
function overrideHarness(pkg, manager) {
  if (!harnessTarball) return;
  pkg.dependencies["@little-stack/harness"] = `file:${harnessTarball}`;
  if (manager === "pnpm") pkg.pnpm = { ...pkg.pnpm, overrides: { ...pkg.pnpm?.overrides, "@little-stack/harness": `file:${harnessTarball}` } };
  // npm only accepts an override of a direct dependency as a reference to that dependency's spec.
  else pkg.overrides = { ...pkg.overrides, "@little-stack/harness": "$@little-stack/harness" };
}
const evidenceBase = process.env.LITTLE_SETUP_EVIDENCE_DIR || tmpdir();
await mkdir(evidenceBase, { recursive: true });
const root = await mkdtemp(join(evidenceBase, "little-install-matrix-"));
console.log(`Qualification fixtures and logs: ${root}`);
function run(command, argv, cwd, name) {
  const result = spawnSync(command, argv, { cwd, encoding: "utf8", env: { ...process.env, LITTLE_DEMO: "1", NEXT_TELEMETRY_DISABLED: "1" }, maxBuffer: 10 * 1024 * 1024 });
  if (name) writeFileSync(join(root, `${name}.log`), `${result.stdout ?? ""}${result.stderr ?? ""}`);
  if (result.status !== 0) throw new Error(`${command} ${argv.join(" ")} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
const packed = JSON.parse(run("tar", ["-xOf", tarball, "package/package.json"], root));
assert.equal(packed.name, "@little-stack/workflow");
assert.equal(packed.publishConfig.tag, "alpha");
assert(!JSON.stringify(packed).match(/workspace:|littledb|little-compute|@little-stack\/compute/));
assert(packed.exports["./scaffold"]);
const consumer = join(root, "cli-consumer");
await mkdir(consumer);
if (harnessTarball) {
  const pkg = { private: true, dependencies: {} };
  overrideHarness(pkg, "npm");
  await writeFile(join(consumer, "package.json"), JSON.stringify(pkg));
}
run("npm", ["install", "--ignore-scripts", "--prefix", consumer, tarball, "ai@^7"], root, "cli-install");
const cli = join(consumer, "node_modules/@little-stack/workflow/dist/cli.js");
assert.match(run(process.execPath, [cli, "setup", "--help"], consumer), /--rollback/);
run("npm", ["pack", "--ignore-scripts", "--pack-destination", root], join(consumer, "node_modules/@little-stack/workflow"), "npm-pack-outside");
const evidence = [];
for (const manager of managers) {
  assert(["npm", "pnpm", "yarn"].includes(manager));
  for (const template of templates) for (const workflow of [false, true]) {
    const name = `${manager}-${template}-${workflow ? "workflow" : "harness"}`;
    const dir = join(root, name);
    const flags = ["setup", dir, "--template", template, "--package-manager", manager, "--yes", "--no-install", ...(workflow ? ["--workflow"] : [])];
    run(process.execPath, [cli, ...flags], root, `${name}-generate`);
    const manifest = await readFile(join(dir, "package.json"), "utf8");
    const pkg = JSON.parse(manifest);
    assert(!JSON.stringify(pkg).match(/workspace:|latest|littledb|little-compute|@little-stack\/compute/));
    if (workflow || harnessTarball) {
      // The candidate version is not on npm yet. Replace only this disposable fixture's
      // Workflow (and optional Harness) dependency with its packed artifact; restore its intended manifest below.
      if (workflow) pkg.dependencies["@little-stack/workflow"] = `file:${tarball}`;
      overrideHarness(pkg, manager);
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
      const url = `http://localhost:${port}`;
      await withNextServer({ command: process.execPath, args: [join(dir, "node_modules/next/dist/bin/next"), "start", "--port", String(port)], cwd: dir, url, logPath: join(root, `${name}-server.log`), env: { ...process.env, LITTLE_DEMO: "1", NEXT_TELEMETRY_DISABLED: "1" } }, async () => {
        const request = { messages: [{ id: "test", role: "user", parts: [{ type: "text", text: "hello" }] }], userId: "not-auth", id: "not-a-server-session" };
        const response = await fetch(`${url}/api/little/chat`, { method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify(request) });
        assert.equal(response.status, 200);
        const stream = await response.text();
        assert.match(stream, /Hello from Little/);
        if (workflow) assert.match(stream, /starter_echo/);
        assert.equal((await fetch(`${url}/api/little/chat`, { method: "POST", body: "{broken" })).status, 400);
        assert.equal((await fetch(`${url}/api/little/chat`, { method: "POST", headers: { origin: "https://untrusted.example" }, body: JSON.stringify(request) })).status, 403);
      });
    }
    evidence.push({ manager, template, workflow, install: "passed", typecheck: "passed", keyless: "passed", build: template === "next" ? "passed" : "n/a", rerun: "no-op" });
    console.log(`Passed ${name}`);
  }
}
// Existing Next layouts use custom scripts, aliases, config, env and a pre-existing chat route.
for (const src of templates.includes("next") ? [false, true] : []) {
  const name = `existing-${src ? "src-app" : "app"}`;
  const dir = join(root, name), app = src ? "src/app" : "app";
  await mkdir(join(dir, app, "api/chat"), { recursive: true });
  const preserved = {
    "package.json": JSON.stringify({ name, private: true, ...(src ? { type: "module" } : {}), scripts: { dev: "custom-dev", build: "custom-build" }, dependencies: { next: src ? "^16.3.8" : "^15.5.27", react: src ? "^19.2.7" : "^18.3.1", "react-dom": src ? "^19.2.7" : "^18.3.1" }, devDependencies: { "@types/react": src ? "^19.2.0" : "^18.3.0", "@types/react-dom": src ? "^19.2.0" : "^18.3.0" } }, null, 2),
    "tsconfig.json": '{ // custom alias\n"compilerOptions":{"moduleResolution":"bundler","paths":{"~/*":["./src/*"]},"jsx":"react-jsx"}}',
    "next.config.mjs": 'export default { poweredByHeader: false };\n',
    ".env.local": "CUSTOM_VALUE=unchanged\n",
    [`${app}/layout.tsx`]: 'import type {ReactNode} from "react"; export default function Layout({children}:{children:ReactNode}) {return <html><body>{children}</body></html>}',
    [`${app}/api/chat/route.ts`]: 'export function POST() {return new Response("existing route");}',
  };
  for (const [path, text] of Object.entries(preserved)) await writeFile(join(dir, path), text);
  run("git", ["init", "-q"], dir);
  const flags = [cli, "setup", "--here", "--template", "existing-next", "--workflow", "--yes", "--no-install"];
  run(process.execPath, flags, dir, `${name}-generate`);
  for (const [path, text] of Object.entries(preserved)) if (path !== "package.json") assert.equal(await readFile(join(dir, path), "utf8"), text);
  const manifest = await readFile(join(dir, "package.json"), "utf8");
  const pkg = JSON.parse(manifest);
  assert.equal(pkg.scripts.dev, "custom-dev"); assert.equal(pkg.scripts.build, "custom-build");
  pkg.dependencies["@little-stack/workflow"] = `file:${tarball}`;
  overrideHarness(pkg, "npm");
  await writeFile(join(dir, "package.json"), JSON.stringify(pkg));
  run("npm", ["install", "--ignore-scripts"], dir, `${name}-install`);
  run("npm", ["rebuild", "better-sqlite3", "--ignore-scripts=false"], dir, `${name}-native`);
  await writeFile(join(dir, "package.json"), manifest);
  run(process.execPath, [...flags, "--verify"], dir, `${name}-verify`);
  run(process.execPath, [join(dir, "node_modules/next/dist/bin/next"), "build"], dir, `${name}-build`);
  assert.deepEqual(JSON.parse(run(process.execPath, [...flags, "--plan"], dir)).files, []);
  const port = src ? 43902 : 43901;
  const url = `http://localhost:${port}`;
  await withNextServer({ command: process.execPath, args: [join(dir, "node_modules/next/dist/bin/next"), "start", "--port", String(port)], cwd: dir, url, logPath: join(root, `${name}-server.log`), env: { ...process.env, LITTLE_DEMO: "1", NEXT_TELEMETRY_DISABLED: "1" } }, async () => {
    const response = await fetch(`${url}/api/little/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ id: "test", role: "user", parts: [{ type: "text", text: "hello" }] }] }) });
    assert.equal(response.status, 200);
    const stream = await response.text();
    assert.match(stream, /Hello from Little/); assert.match(stream, /starter_echo/);
  });

  evidence.push({ template: name, manager: "npm", workflow: true, install: "passed", typecheck: "passed", keyless: "passed", build: "passed", customScripts: "preserved", existingChat: "preserved", rerun: "no-op" });
  console.log(`Passed ${name}`);
}
await writeFile(join(root, "evidence.json"), JSON.stringify({ version: packed.version, tarball, evidence }, null, 2));
console.log(`All ${evidence.length} consumer cases passed. Evidence: ${join(root, "evidence.json")}`);
