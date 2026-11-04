import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));

// These are the only production readers of user project/skill files or storage
// adapters. Test utilities and tests are outside this runtime import boundary.
const storageAdapters = new Set(["run-files.ts", "event-storage-sqlite.ts"]);
const diskProjectReaders = new Set(["cli-core.ts", "skills.ts", "workflow-definition-hash.ts"]);

async function files(dir: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await files(full));
    else if (entry.name.endsWith(".ts")) result.push(full);
  }
  return result;
}

it("keeps node:fs imports inside disk adapters and explicit project/skill readers", async () => {
  const forbidden: string[] = [];
  for (const full of await files(root)) {
    const name = relative(root, full).replaceAll("\\", "/");
    if (/\.(?:test|spec)\.ts$/u.test(name) || name === "test-temp.ts" || name === "test-setup.ts") continue;
    if (storageAdapters.has(name) || diskProjectReaders.has(name) || name.startsWith("workspace/") || name.startsWith("cli/")) continue;
    const source = ts.createSourceFile(full, await readFile(full, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      const specifier = ts.isImportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          ts.isIdentifier(node.expression) && node.expression.text === "require")
          ? node.arguments[0]
          : undefined;
      if (specifier && ts.isStringLiteral(specifier) && /^node:fs(?:\/promises)?$/u.test(specifier.text)) {
        forbidden.push(`${name}: ${specifier.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(forbidden).toEqual([]);
});
