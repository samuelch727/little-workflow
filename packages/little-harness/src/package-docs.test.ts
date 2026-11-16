import { access, readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const packages = ["little-harness", "little-workflow"];

async function docsFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await docsFiles(path));
    else if (/\.mdx?$/.test(entry.name)) files.push(path);
  }
  return files;
}

it("published package README/docs links never escape the package directory", async () => {
  const failures: string[] = [];
  for (const name of packages) {
    const root = join(repo, "packages", name);
    const files = [join(root, "README.md"), ...await docsFiles(join(root, "docs"))];
    const overlay = join(repo, "public/packages", name, "README.md");
    if (await access(overlay).then(() => true, () => false)) files.push(overlay);
    for (const file of files) {
      // Export overlays land at the package path, not under public/.
      const installedFile = file === overlay ? join(root, "README.md") : file;
      const text = await readFile(file, "utf8");
      // Inline Markdown/images, reference definitions, and HTML/MDX links.
      const targets = [
        ...text.matchAll(/\]\(\s*<?([^\s)>]+)>?/g),
        ...text.matchAll(/^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?/gm),
        ...text.matchAll(/\b(?:href|src)=["']([^"']+)["']/g),
      ].map(match => match[1]!);
      for (const target of targets) {
        if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) continue;
        const path = decodeURIComponent(target.split(/[?#]/, 1)[0]!).replaceAll("\\", "/");
        const within = relative(root, resolve(dirname(installedFile), path));
        if (isAbsolute(path) || within === ".." || within.startsWith("../")) {
          failures.push(`${relative(repo, file)}: ${target}`);
        }
      }
    }
  }
  expect(failures, "Use verified absolute documentation URLs for out-of-package targets").toEqual([]);
});

it("each package skill release marker matches the package version", async () => {
  for (const name of packages) {
    const pkg = JSON.parse(await readFile(join(repo, "packages", name, "package.json"), "utf8"));
    const skill = await readFile(join(repo, "skills", name, "SKILL.md"), "utf8");
    const markers = [...skill.matchAll(/^This release: `([^`]+)`/gm)].map(match => match[1]);
    expect(markers, `${name} skill release marker`).toEqual([`${pkg.name}@${pkg.version}`]);
  }
});

it("published Workflow docs contain every site page by relative name", async () => {
  const site = join(repo, "apps/little-workflow-doc/content/docs/workflow/v0.1.0-alpha");
  // The public export intentionally excludes the private documentation app.
  if (!await access(site).then(() => true, () => false)) return;
  const published = join(repo, "packages/little-workflow/docs");
  const pages = (await docsFiles(site)).filter(file => file.endsWith(".mdx")).map(file => relative(site, file));
  const missing: string[] = [];
  for (const page of pages) if (!await access(join(published, page)).then(() => true, () => false)) missing.push(page);
  expect(missing, "Copy missing site pages into the package docs; no current exceptions").toEqual([]);
});
