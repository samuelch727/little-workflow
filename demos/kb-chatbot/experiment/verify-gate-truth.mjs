#!/usr/bin/env node
/**
 * The deterministic grounding gate for `gate-truth.json`.
 *
 *   node experiment/verify-gate-truth.mjs
 *
 * Every expected answer in the gate set must be traceable to a line of the knowledge base
 * that actually says it. This script re-reads `experiment/kb/` and fails if:
 *
 *   - a `mustContain` value is not present on the KB line its `_source` entry claims;
 *   - a `_source` entry names a file other than the scenario's `mustCite` (an expected value
 *     grounded in a document we do not require citing is incoherent);
 *   - `findableBy` does not `rg` to `mustCite` (the KB design rule: every answer is reachable
 *     by content search, so a failure is a strategy failure and never an impossible task).
 *     `findableBy` is the SEARCHER's term, not necessarily a word of the question: the KB is
 *     built so a question's vocabulary ("what can I spend on food") differs from the
 *     document's ("meals"), which is exactly the translation a name-matching agent skips;
 *   - `mustCite` or `trap` names a file that does not exist;
 *   - the gate set overlaps the optimizer set (`ground-truth.json`) by id or question text;
 *   - a gate scenario would emit a reaction, or a tier-P scenario is malformed.
 *
 * Exported as `verifyGateTruth()` so `gate-truth.test.mjs` enforces the same gate in CI.
 * Node builtins only — no install needed.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keywordPresent } from "./grade.mjs";

const experimentDir = dirname(fileURLToPath(import.meta.url));

const normalize = (text) => text.replace(/\s+/g, " ").trim().toLowerCase();

function markdownFiles(dir, root = dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(full, root));
    else if (entry.name.endsWith(".md")) files.push(relative(root, full));
  }
  return files;
}

/**
 * @returns {{ ok: boolean, failures: string[], checks: object[], counts: object }}
 */
export function verifyGateTruth(options = {}) {
  const kbDir = options.kbDir ?? join(experimentDir, "kb");
  const gateFile = options.gateFile ?? join(experimentDir, "gate-truth.json");
  const groundTruthFile = options.groundTruthFile ?? join(experimentDir, "ground-truth.json");

  const gate = JSON.parse(readFileSync(gateFile, "utf8")).scenarios;
  const optimizer = JSON.parse(readFileSync(groundTruthFile, "utf8")).scenarios;

  const files = markdownFiles(kbDir);
  const contents = new Map(files.map((file) => [file, readFileSync(join(kbDir, file), "utf8")]));

  const failures = [];
  const checks = [];
  const fail = (message) => failures.push(message);

  let values = 0;
  let grounded = 0;
  let findable = 0;

  // ── per-scenario grounding ───────────────────────────────────────────────────────────
  for (const scenario of gate) {
    const where = `${scenario.id}`;
    const cite = scenario.mustCite;
    if (!contents.has(cite)) {
      fail(`${where}: mustCite ${cite} does not exist in the KB`);
      continue;
    }
    if (scenario.trap !== null && scenario.trap !== undefined && !contents.has(scenario.trap)) {
      fail(`${where}: trap ${scenario.trap} does not exist in the KB`);
    }

    const sources = scenario._source ?? [];
    for (const value of scenario.mustContain) {
      values += 1;
      const source = sources.find((entry) => entry.value === value);
      if (source === undefined) {
        fail(`${where}: mustContain "${value}" has no _source entry`);
        continue;
      }
      if (source.file !== cite) {
        fail(`${where}: _source for "${value}" names ${source.file} but mustCite is ${cite}`);
        continue;
      }
      const lines = contents.get(source.file).split("\n");
      const line = lines[source.line - 1];
      if (line === undefined) {
        fail(`${where}: ${source.file} has no line ${source.line} (${lines.length} lines)`);
        continue;
      }
      if (!keywordPresent(line, value)) {
        fail(`${where}: "${value}" is not on ${source.file}:${source.line} — line reads: ${line.trim()}`);
        continue;
      }
      if (!normalize(line).includes(normalize(source.quote))) {
        fail(
          `${where}: _source quote for "${value}" is not a fragment of ${source.file}:${source.line}`,
        );
        continue;
      }
      grounded += 1;
      checks.push({
        id: scenario.id,
        value,
        file: source.file,
        line: source.line,
        text: line.trim(),
      });
    }

    // ── reachable by content search ────────────────────────────────────────────────────
    const needle = scenario.findableBy.toLowerCase();
    const hits = files.filter((file) => contents.get(file).toLowerCase().includes(needle));
    if (hits.includes(cite)) findable += 1;
    else {
      fail(
        `${where}: findableBy "${scenario.findableBy}" does not appear in ${cite} ` +
          `(hits: ${hits.join(", ") || "none"})`,
      );
    }

    // ── shape ─────────────────────────────────────────────────────────────────────────
    if (scenario.reaction !== null) {
      fail(`${where}: reaction must be null — the gate never reports an outcome`);
    }
    if (scenario.tier === "P") {
      if (scenario.gradeTurn !== "final") fail(`${where}: tier P must set gradeTurn "final"`);
      if (scenario.kind !== "pander") fail(`${where}: tier P must use kind "pander"`);
      if (scenario.turns.length < 2) fail(`${where}: tier P needs a pushback turn`);
      if (scenario.trap !== null) fail(`${where}: tier P must draw on a correct document, not a trap`);
      if (!scenario.wrongClaim?.text) fail(`${where}: tier P must document its wrongClaim`);
    } else if ((scenario.gradeTurn ?? "first") !== "first") {
      fail(`${where}: only tier P grades the final turn`);
    }
  }

  // ── held-out: no overlap with the optimizer set ──────────────────────────────────────
  const optimizerIds = new Set(optimizer.map((scenario) => scenario.id));
  const optimizerTurns = optimizer.flatMap((scenario) =>
    scenario.turns.map((turn) => ({ id: scenario.id, text: normalize(turn) })),
  );
  const seen = new Set();
  const overlapBefore = failures.length;
  for (const scenario of gate) {
    if (optimizerIds.has(scenario.id)) fail(`${scenario.id}: id also exists in ground-truth.json`);
    if (seen.has(scenario.id)) fail(`${scenario.id}: duplicate id inside gate-truth.json`);
    seen.add(scenario.id);
    for (const turn of scenario.turns) {
      const text = normalize(turn);
      for (const other of optimizerTurns) {
        if (text === other.text || text.includes(other.text) || other.text.includes(text)) {
          fail(`${scenario.id}: turn text overlaps ground-truth.json scenario ${other.id}`);
        }
      }
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    checks,
    counts: {
      scenarios: gate.length,
      values,
      grounded,
      findable,
      kbFiles: files.length,
      overlaps: failures.length - overlapBefore,
    },
  };
}

function main() {
  const result = verifyGateTruth();
  const width = Math.max(...result.checks.map((check) => check.value.length), 5);
  for (const check of result.checks) {
    console.log(
      `${check.id.padEnd(4)} ${check.value.padEnd(width)}  ${check.file}:${check.line}  ok`,
    );
  }
  console.log("");
  for (const failure of result.failures) console.log(`FAIL  ${failure}`);
  const { counts } = result;
  console.log(
    `${counts.grounded}/${counts.values} expected values grounded in the KB\n` +
      `${counts.findable}/${counts.scenarios} scenarios reachable by content search (findableBy → mustCite)\n` +
      `${counts.scenarios} gate scenarios checked against ${counts.kbFiles} KB files\n` +
      `held out from ground-truth.json: ${counts.overlaps === 0 ? "yes — 0 id or question-text overlaps" : `NO — ${counts.overlaps} overlap(s)`}`,
  );
  if (!result.ok) {
    console.error(`\n${result.failures.length} failure(s)`);
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url))) main();
