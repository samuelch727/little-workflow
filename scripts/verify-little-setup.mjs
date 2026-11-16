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
const tarball = resolve(value("--tarball") || join(tmpdir(), "little-setup-packs/little-stack-workflow-0.2.0-alpha.4.tgz"));
const managers = args.includes("--existing-only") ? [] : args.includes("--managers") ? value("--managers").split(",") : ["npm", "pnpm"];
const templates = args.includes("--templates") ? value("--templates").split(",") : ["node", "next"];
// An unpublished Harness candidate: generated fixtures and the CLI consumer resolve it from this tarball.
const harnessTarball = value("--harness-tarball") && resolve(value("--harness-tarball"));
const littledbTarball = value("--littledb-tarball") && resolve(value("--littledb-tarball"));
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
function assertPackedSkill(archive, name, manifest) {
  const path = `package/skills/${name}/SKILL.md`;
  const listing = run("tar", ["-tzf", archive], root).split("\n");
  assert(listing.includes(path), `Missing packed skill: ${path}`);
  const skill = run("tar", ["-xOf", archive, path], root);
  assert.deepEqual([...skill.matchAll(/^This release: `([^`]+)`/gm)].map(match => match[1]),
    [`${manifest.name}@${manifest.version}`], `Packed ${name} skill release must match package version`);
}
assertPackedSkill(tarball, "little-workflow", packed);
if (harnessTarball) {
  const harnessPacked = JSON.parse(run("tar", ["-xOf", harnessTarball, "package/package.json"], root));
  assert.equal(harnessPacked.name, "@little-stack/harness");
  assertPackedSkill(harnessTarball, "little-harness", harnessPacked);
}
const consumer = join(root, "cli-consumer");
await mkdir(consumer);
if (harnessTarball) {
  const pkg = { private: true, dependencies: {} };
  overrideHarness(pkg, "npm");
  await writeFile(join(consumer, "package.json"), JSON.stringify(pkg));
}
run("npm", ["install", "--ignore-scripts", "--prefix", consumer, tarball, ...(littledbTarball ? [littledbTarball] : []), "ai@^7"], root, "cli-install");
await readFile(join(consumer, "node_modules/@little-stack/workflow/skills/little-workflow/SKILL.md"));
if (harnessTarball) await readFile(join(consumer, "node_modules/@little-stack/harness/skills/little-harness/SKILL.md"));
const cli = join(consumer, "node_modules/@little-stack/workflow/dist/cli.js");
assert.match(run(process.execPath, [cli, "setup", "--help"], consumer), /--rollback/);
if (littledbTarball) {
  const client = JSON.parse(run("tar", ["-xOf", littledbTarball, "package/package.json"], root));
  assert.equal(client.name, "@little-stack/littledb");
  assert.equal(client.version, packed.version);
  assert.notEqual(client.private, true);
  for (const peer of ["@little-stack/harness", "@little-stack/workflow"]) {
    assert.equal(client.peerDependencies[peer], `^${packed.version}`);
    assert.equal(client.peerDependenciesMeta[peer].optional, true);
  }
  const listing = run("tar", ["-tzf", littledbTarball], root).trim().split("\n");
  for (const file of ["package/README.md", "package/LICENSE", "package/dist/cli.js"]) assert(listing.includes(file), file);
  assert(!listing.some(file => /(?:^|\/)(?:vendor|src|test|tests|node_modules)\/|\.(?:test|spec)\.[^/]+$/.test(file)), "client pack must exclude source, tests and vendor folders");
  assert.match(run("tar", ["-xOf", littledbTarball, "package/dist/cli.js"], root), /^#!\/usr\/bin\/env node\n/);
  const installedClient = join(consumer, "node_modules/.bin/littledb");
  assert.match(run(installedClient, ["--help"], consumer, "littledb-help-with-peers"), /login --url/);
  for (const command of ["login", "deploy", "chat", "secrets"]) {
    assert.match(run(installedClient, [command, "--help"], consumer), /littledb/);
  }
  const empty = join(root, "littledb-plan");
  const plan = JSON.parse(run(process.execPath, [cli, "setup", empty, "--plan", "--littledb"], root, "littledb-setup-plan"));
  assert(plan.files.length > 0);
  assert(!JSON.stringify(plan).includes("LittleDB is unpublished"));
  const standalone = join(root, "client-without-peers");
  await mkdir(standalone);
  await writeFile(join(standalone, "package.json"), JSON.stringify({ private: true, type: "module" }));
  run("npm", ["install", "--ignore-scripts", littledbTarball], standalone, "littledb-standalone-install");
  for (const peer of ["harness", "workflow"]) {
    assert.throws(() => run(process.execPath, ["-e", `require.resolve('@little-stack/${peer}')`], standalone));
  }
  assert.match(run(join(standalone, "node_modules/.bin/littledb"), ["--help"], standalone, "littledb-help-without-peers"), /login --url/);
  assert.match(run(process.execPath, ["--input-type=module", "-e", "import {createLittleDB} from '@little-stack/littledb'; console.log(typeof createLittleDB)"], standalone), /function/);
  console.log("Passed LittleDB packed metadata, bin, CLI help with/without peers, root import and managed setup plan");
}
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
      // Below Linux's ephemeral range (32768-60999): the installs above can leave an
      // outgoing connection or TIME_WAIT on a port in that range, and listen() then fails.
      const port = 23000 + evidence.length;
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
  const port = src ? 23902 : 23901; // below the ephemeral range, as above
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
