/**
 * The guards that keep the gate set a GATE.
 *
 * These are real assertions rather than a comment in the JSON: the failure mode they exist to
 * catch is somebody adding a gate scenario by copying an optimizer one, which is invisible in
 * review and silently turns the held-out set back into the training set.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { gradeTurnOf } from "./grade.mjs";
import { verifyGateTruth } from "./verify-gate-truth.mjs";

const experimentDir = dirname(fileURLToPath(import.meta.url));
const load = (name) => JSON.parse(readFileSync(join(experimentDir, name), "utf8")).scenarios;

const gate = load("gate-truth.json");
const optimizer = load("ground-truth.json");

const normalize = (text) => text.replace(/\s+/g, " ").trim().toLowerCase();

describe("gate-truth.json is disjoint from ground-truth.json", () => {
  it("shares no question text with the optimizer set", () => {
    const optimizerTurns = optimizer.flatMap((scenario) =>
      scenario.turns.map((turn) => ({ id: scenario.id, text: normalize(turn) })),
    );
    const overlaps = [];
    for (const scenario of gate) {
      for (const turn of scenario.turns) {
        const text = normalize(turn);
        for (const other of optimizerTurns) {
          if (text === other.text || text.includes(other.text) || other.text.includes(text)) {
            overlaps.push(`${scenario.id} ↔ ${other.id}: ${turn}`);
          }
        }
      }
    }
    assert.deepEqual(overlaps, []);
  });

  it("shares no scenario id with the optimizer set, and repeats none of its own", () => {
    const optimizerIds = new Set(optimizer.map((scenario) => scenario.id));
    const seen = new Set();
    for (const scenario of gate) {
      assert.equal(optimizerIds.has(scenario.id), false, `${scenario.id} also in ground-truth`);
      assert.equal(seen.has(scenario.id), false, `${scenario.id} appears twice`);
      seen.add(scenario.id);
    }
    assert.equal(seen.size, gate.length);
  });

  it("is not empty and is bigger than a smoke test", () => {
    assert.ok(gate.length >= 20, `expected at least 20 gate scenarios, got ${gate.length}`);
  });
});

describe("gate scenarios can never emit telemetry", () => {
  it("declares reaction: null everywhere", () => {
    for (const scenario of gate) {
      assert.equal(
        scenario.reaction,
        null,
        `${scenario.id} would send a reaction; the gate is measurement-only`,
      );
    }
  });
});

describe("scenario shape", () => {
  it("uses the tiers and kinds the gate defines, and no tier C", () => {
    for (const scenario of gate) {
      assert.ok(["A", "B", "P"].includes(scenario.tier), `${scenario.id}: tier ${scenario.tier}`);
      assert.ok(
        ["fair", "trap", "deep", "pander"].includes(scenario.kind),
        `${scenario.id}: kind ${scenario.kind}`,
      );
      assert.ok(scenario.turns.length >= 1);
      assert.ok(scenario.mustContain.length >= 1);
      assert.equal(typeof scenario.mustCite, "string");
      assert.equal(typeof scenario.findableBy, "string");
    }
  });

  it("grades the final turn only for tier P, and the first turn everywhere else", () => {
    for (const scenario of gate) {
      assert.equal(
        gradeTurnOf(scenario),
        scenario.tier === "P" ? "final" : "first",
        `${scenario.id}`,
      );
    }
  });

  it("gives every tier-P scenario a pushback turn, a documented wrong claim, and a correct source", () => {
    const pander = gate.filter((scenario) => scenario.tier === "P");
    assert.ok(pander.length >= 5, `expected at least 5 anti-pandering scenarios, got ${pander.length}`);
    for (const scenario of pander) {
      assert.equal(scenario.kind, "pander");
      assert.ok(scenario.turns.length >= 2, `${scenario.id} has no pushback turn`);
      assert.equal(scenario.trap, null, `${scenario.id} must quote a correct, current document`);
      assert.ok(scenario.wrongClaim?.text, `${scenario.id} does not document its wrong claim`);
      assert.ok(scenario.wrongClaim?.value, `${scenario.id} does not name the wrong value`);
    }
  });

  it("covers the trap taxonomy and keeps fair controls", () => {
    const kinds = {};
    for (const scenario of gate) kinds[scenario.kind] = (kinds[scenario.kind] ?? 0) + 1;
    assert.ok(kinds.fair >= 3, `expected at least 3 fair controls, got ${kinds.fair ?? 0}`);
    assert.ok(kinds.trap >= 5, `expected trap coverage, got ${kinds.trap ?? 0}`);
    assert.ok(kinds.deep >= 5, `expected deep coverage, got ${kinds.deep ?? 0}`);
  });
});

describe("every expected answer is grounded in the knowledge base", () => {
  const result = verifyGateTruth();

  it("verifies with no failures", () => {
    assert.deepEqual(result.failures, []);
  });

  it("grounds every mustContain value on the KB line it claims", () => {
    assert.equal(result.counts.grounded, result.counts.values);
    assert.ok(result.counts.values >= gate.length);
  });

  it("keeps every scenario reachable by content search", () => {
    assert.equal(result.counts.findable, result.counts.scenarios);
  });
});
