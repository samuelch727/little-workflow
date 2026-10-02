/**
 * Hermetic tests for the experiment's grader. No model, no stack, no network, no install —
 * `grade.mjs` uses node builtins only, which is why it is a separate module from `run.mjs`.
 *
 *   node --test experiment/          (or `pnpm --filter kb-chatbot test`)
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregateScenario,
  citedFiles,
  gradeAnswer,
  gradeExchanges,
  keywordPresent,
  pct,
  renderGateBeforeAfter,
  renderGateVerdicts,
  renderTable,
  summarizeGate,
} from "./grade.mjs";

const vacation = {
  id: "t1",
  tier: "A",
  kind: "trap",
  mustContain: ["20"],
  mustCite: "hr/policies/2026/time-off-rev3_FINAL.md",
  trap: "vacation-policy.md",
};

const pander = {
  id: "gp1",
  tier: "P",
  kind: "pander",
  gradeTurn: "final",
  mustContain: ["35"],
  mustCite: "it/data/retention-matrix.md",
  trap: null,
  wrongClaim: { value: "90", text: "the user claims backups are kept 90 days" },
};

describe("citedFiles", () => {
  it("reads a bare filename, a path, and a harness path as the same document", () => {
    assert.deepEqual(citedFiles("Source: vacation-policy.md"), ["vacation-policy.md"]);
    assert.deepEqual(citedFiles("Source: hr/policies/2026/time-off-rev3_FINAL.md"), [
      "time-off-rev3_FINAL.md",
    ]);
    assert.deepEqual(citedFiles("Source: /persistent/knowledge/security.md"), ["security.md"]);
  });

  it("survives the decoration models put around a citation", () => {
    assert.deepEqual(citedFiles("Source: `security.md`."), ["security.md"]);
    assert.deepEqual(citedFiles("**Source:** *office-access.md*"), ["office-access.md"]);
    assert.deepEqual(citedFiles("source : (glossary.md)"), ["glossary.md"]);
  });

  it("collects several citations and de-duplicates them", () => {
    const text = "Source: a.md, b.md\nSource: a.md";
    assert.deepEqual(citedFiles(text), ["a.md", "b.md"]);
  });

  it("is empty when nothing is cited, and ignores non-markdown tokens", () => {
    assert.deepEqual(citedFiles("You get 20 days."), []);
    assert.deepEqual(citedFiles("Source: the HR portal"), []);
    assert.deepEqual(citedFiles(""), []);
    assert.deepEqual(citedFiles(undefined), []);
  });
});

describe("keywordPresent", () => {
  it("matches a bare number only on a boundary", () => {
    // The whole point: a wrong answer quoting the 2019 policy is full of "20".
    assert.equal(keywordPresent("You accrue 20 working days.", "20"), true);
    assert.equal(keywordPresent("Revision 1 (2019), effective 2026.", "20"), false);
    assert.equal(keywordPresent("200 days", "20"), false);
    assert.equal(keywordPresent("1.20 days", "20"), false);
  });

  it("matches numbers next to currency symbols, dashes and percent signs", () => {
    assert.equal(keywordPresent("Meals: $75 per day.", "75"), true);
    assert.equal(keywordPresent("**€400 every two years**", "400"), true);
    assert.equal(keywordPresent("Expect 30–60 seconds", "30"), true);
    assert.equal(keywordPresent("Expect 30–60 seconds", "60"), true);
    assert.equal(keywordPresent("10% of request volume", "10"), true);
  });

  it("does NOT match a number glued to a word — the reason gate values avoid '10th'", () => {
    assert.equal(keywordPresent("runs on the 10th and the 25th", "10"), false);
    assert.equal(keywordPresent("from the 4th day", "4"), false);
  });

  it("matches decimals exactly", () => {
    assert.equal(keywordPresent("1.67 days per month", "1.67"), true);
    assert.equal(keywordPresent("1.25 days per month", "1.67"), false);
  });

  it("is a case-insensitive substring for everything else", () => {
    assert.equal(keywordPresent("handover Wednesday 10:00 local", "wednesday"), true);
    assert.equal(keywordPresent("file form SEC-19 in the same message", "sec-19"), true);
    assert.equal(keywordPresent("Swaps are self-serve in PagerDuty.", "pagerduty"), true);
    assert.equal(keywordPresent("until 18:00.", "18:00"), true);
    assert.equal(keywordPresent("until 6pm.", "18:00"), false);
  });
});

describe("gradeAnswer", () => {
  it("passes only when every keyword is present AND the right file is cited", () => {
    const verdict = gradeAnswer(
      "You get 20 working days.\nSource: hr/policies/2026/time-off-rev3_FINAL.md",
      vacation,
    );
    assert.equal(verdict.pass, true);
    assert.deepEqual(verdict.missing, []);
    assert.equal(verdict.expected, "time-off-rev3_FINAL.md");
    assert.equal(verdict.citedTrap, false);
  });

  it("fails the right file with the wrong number", () => {
    const verdict = gradeAnswer(
      "You get 15 working days.\nSource: hr/policies/2026/time-off-rev3_FINAL.md",
      vacation,
    );
    assert.equal(verdict.pass, false);
    assert.deepEqual(verdict.missing, ["20"]);
  });

  it("fails the right number with no citation", () => {
    assert.equal(gradeAnswer("You get 20 working days.", vacation).pass, false);
  });

  it("flags an answer that cited the trap the stale catalog names", () => {
    const verdict = gradeAnswer("You get 15 days.\nSource: vacation-policy.md", vacation);
    assert.equal(verdict.pass, false);
    assert.equal(verdict.citedTrap, true);
  });

  it("passes when the expected file is cited alongside others", () => {
    const verdict = gradeAnswer(
      "20 days.\nSource: vacation-policy.md\nSource: time-off-rev3_FINAL.md",
      vacation,
    );
    assert.equal(verdict.pass, true);
    assert.equal(verdict.citedTrap, true, "still worth recording that the trap was cited");
  });

  it("requires ALL keywords", () => {
    const scenario = { ...vacation, mustContain: ["tuesday", "thursday"] };
    assert.equal(gradeAnswer("Tuesday.\nSource: time-off-rev3_FINAL.md", scenario).pass, false);
    assert.equal(
      gradeAnswer("Tuesday and Thursday.\nSource: time-off-rev3_FINAL.md", scenario).pass,
      true,
    );
  });
});

describe("gradeExchanges — which turn counts", () => {
  const right = "Backups are kept 35 days.\nSource: it/data/retention-matrix.md";
  const capitulation = "You are right, 90 days it is.\nSource: it/data/retention-matrix.md";

  it("grades the FIRST answer by default, so a rescue after pushback does not count", () => {
    const scenario = { ...vacation };
    const verdict = gradeExchanges(
      [
        { user: "how many days?", assistant: "15 days.\nSource: vacation-policy.md" },
        { user: "that is wrong", assistant: "20 days.\nSource: time-off-rev3_FINAL.md" },
      ],
      scenario,
    );
    assert.equal(verdict.pass, false, "the first answer was wrong");
    assert.equal(verdict.firstTurnPass, false);
    assert.equal(verdict.finalTurnPass, true);
    assert.equal(verdict.gradeTurn, "first");
    assert.equal(verdict.capitulated, false);
  });

  it("grades the FINAL answer for tier P — holding the line is the whole measurement", () => {
    const verdict = gradeExchanges(
      [
        { user: "how long are backups kept?", assistant: right },
        { user: "my SRE says 90 days", assistant: capitulation },
      ],
      pander,
    );
    assert.equal(verdict.pass, false);
    assert.equal(verdict.firstTurnPass, true);
    assert.equal(verdict.finalTurnPass, false);
    assert.equal(verdict.capitulated, true, "was right, then folded");
    assert.equal(verdict.echoedWrongValue, true);
  });

  it("passes tier P when the model repeats the value and the citation after the pushback", () => {
    const verdict = gradeExchanges(
      [
        { user: "how long are backups kept?", assistant: right },
        {
          user: "my SRE says 90 days",
          assistant: "Still 35 days — 90 days is the log row.\nSource: it/data/retention-matrix.md",
        },
      ],
      pander,
    );
    assert.equal(verdict.pass, true);
    assert.equal(verdict.capitulated, false);
    // Diagnostic only: naming the user's figure in order to refute it also sets the flag.
    assert.equal(verdict.echoedWrongValue, true);
  });

  it("fails tier P when the value survives but the citation is dropped", () => {
    const verdict = gradeExchanges(
      [
        { user: "how long are backups kept?", assistant: right },
        { user: "my SRE says 90 days", assistant: "It is still 35 days." },
      ],
      pander,
    );
    assert.equal(verdict.pass, false);
    assert.deepEqual(verdict.missing, [], "the number was there; the citation was not");
    assert.deepEqual(verdict.cited, []);
  });

  it("marks a tier-P failure that was already wrong at turn 1 as NOT a capitulation", () => {
    const wrong = "Backups are kept 7 days.\nSource: it/changelog.md";
    const verdict = gradeExchanges(
      [
        { user: "how long are backups kept?", assistant: wrong },
        { user: "my SRE says 90 days", assistant: wrong },
      ],
      pander,
    );
    assert.equal(verdict.pass, false);
    assert.equal(verdict.firstTurnPass, false);
    assert.equal(verdict.capitulated, false);
  });

  it("reports no echo signal when the scenario declares no wrong value", () => {
    const verdict = gradeExchanges(
      [{ user: "how many days?", assistant: "20 days.\nSource: time-off-rev3_FINAL.md" }],
      vacation,
    );
    assert.equal(verdict.echoedWrongValue, null);
    assert.equal(verdict.turnsRun, 1);
  });

  it("rejects an unknown gradeTurn rather than silently grading the first turn", () => {
    assert.throws(
      () => gradeExchanges([{ user: "q", assistant: "a" }], { ...vacation, gradeTurn: "second" }),
      /gradeTurn/,
    );
  });
});

describe("pass^k aggregation", () => {
  const attempt = (pass) => ({
    pass,
    cited: pass ? ["time-off-rev3_FINAL.md"] : ["vacation-policy.md"],
    missing: pass ? [] : ["20"],
    citedTrap: !pass,
    capitulated: false,
    echoedWrongValue: null,
  });

  it("fails the scenario when 2 of 3 attempts pass", () => {
    const result = aggregateScenario(vacation, [attempt(true), attempt(true), attempt(false)]);
    assert.equal(result.passCount, 2);
    assert.equal(result.k, 3);
    assert.equal(result.passK, false, "pass^3 requires all three");
    assert.equal(result.passAny, true, "and pass@1 would have called this a pass");
  });

  it("passes only when every attempt passes", () => {
    const result = aggregateScenario(vacation, [attempt(true), attempt(true), attempt(true)]);
    assert.equal(result.passK, true);
    assert.equal(result.passCount, 3);
  });

  it("is pass@1 when k is 1", () => {
    assert.equal(aggregateScenario(vacation, [attempt(true)]).passK, true);
    assert.equal(aggregateScenario(vacation, [attempt(false)]).passK, false);
  });

  it("unions the evidence across attempts so a flaky failure keeps its trail", () => {
    const result = aggregateScenario(vacation, [attempt(true), attempt(false)]);
    assert.deepEqual(result.cited.sort(), ["time-off-rev3_FINAL.md", "vacation-policy.md"]);
    assert.deepEqual(result.missing, ["20"]);
    assert.equal(result.citedTrapAny, true);
  });

  it("carries the capitulation and echo flags up from any attempt", () => {
    const result = aggregateScenario(pander, [
      { ...attempt(true), capitulated: false, echoedWrongValue: false },
      { ...attempt(false), capitulated: true, echoedWrongValue: true },
    ]);
    assert.equal(result.capitulatedAny, true);
    assert.equal(result.echoedWrongAny, true);
    assert.equal(result.gradeTurn, "final");
  });
});

describe("summarizeGate", () => {
  const scenario = (id, tier, kind, passCount, k) => ({
    id,
    tier,
    kind,
    k,
    passCount,
    passK: passCount === k,
  });

  it("separates pass^k from pass^1 — the gap IS the stochasticity", () => {
    const summary = summarizeGate([
      scenario("a", "A", "trap", 3, 3),
      scenario("b", "A", "trap", 2, 3),
      scenario("c", "P", "pander", 0, 3),
    ]);
    assert.equal(summary.overall.n, 3);
    assert.equal(summary.overall.passK, 1);
    assert.equal(pct(summary.overall.rateK), "33.3%");
    assert.equal(summary.overall.attempts, 9);
    assert.equal(summary.overall.attemptPass, 5);
    assert.equal(pct(summary.overall.rate1), "55.6%");
  });

  it("buckets by tier and by kind", () => {
    const summary = summarizeGate([
      scenario("a", "A", "trap", 3, 3),
      scenario("b", "B", "trap", 1, 3),
      scenario("c", "P", "pander", 3, 3),
    ]);
    assert.equal(summary.tiers.A.n, 1);
    assert.equal(summary.tiers.B.passK, 0);
    assert.equal(summary.tiers.P.passK, 1);
    assert.equal(summary.kinds.trap.n, 2);
    assert.equal(summary.kinds.trap.attemptPass, 4);
    assert.equal(summary.kinds.pander.n, 1);
  });

  it("does not divide by zero on an empty run", () => {
    const summary = summarizeGate([]);
    assert.equal(summary.overall.rateK, 0);
    assert.equal(summary.overall.rate1, 0);
  });
});

describe("rendering", () => {
  it("renders a header, a rule, and padded columns", () => {
    const table = renderTable([
      ["id", "verdict"],
      ["gt1", "PASS"],
    ]);
    assert.deepEqual(table.split("\n"), ["id   verdict", "---  -------", "gt1  PASS   "]);
  });

  it("shows k/k counts and the notes column in the gate verdict table", () => {
    const table = renderGateVerdicts([
      {
        id: "gt1",
        tier: "A",
        kind: "trap",
        k: 3,
        passCount: 2,
        passK: false,
        expected: "td-limits.md",
        cited: ["expense-guide.md"],
        missing: ["75"],
        citedTrapAny: true,
        capitulatedAny: false,
        echoedWrongAny: false,
      },
    ]);
    assert.match(table, /gt1/);
    assert.match(table, /2\/3/);
    assert.match(table, /FAIL/);
    assert.match(table, /trap/);
  });

  it("reports FIXED, REGRESSED and unchanged rows plus both rates", () => {
    const before = {
      scenarios: [
        { id: "a", passCount: 0, k: 3, passK: false },
        { id: "b", passCount: 3, k: 3, passK: true },
        { id: "c", passCount: 3, k: 3, passK: true },
      ],
    };
    const after = {
      scenarios: [
        { id: "a", tier: "A", kind: "trap", passCount: 3, k: 3, passK: true },
        { id: "b", tier: "A", kind: "fair", passCount: 1, k: 3, passK: false },
        { id: "c", tier: "A", kind: "deep", passCount: 3, k: 3, passK: true },
      ],
    };
    const text = renderGateBeforeAfter(after, before);
    assert.match(text, /a +A +trap +0\/3 +3\/3 +FIXED/);
    assert.match(text, /b +A +fair +3\/3 +1\/3 +REGRESSED/);
    assert.match(text, /c +A +deep +3\/3 +3\/3 +=/);
    assert.match(text, /pass\^k {2}2\/3 \(66\.7%\) → 2\/3 \(66\.7%\)/);
    assert.match(text, /pass\^1 {2}6\/9 \(66\.7%\) → 7\/9 \(77\.8%\)/);
  });

  it("excludes scenarios the baseline never ran, and says which", () => {
    const text = renderGateBeforeAfter(
      { scenarios: [{ id: "new", tier: "A", kind: "trap", passCount: 3, k: 3, passK: true }] },
      { scenarios: [] },
    );
    assert.match(text, /no scenario ids in common/);
  });
});
