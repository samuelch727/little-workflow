import { Bash } from "just-bash";
import { describe, expect, it } from "vitest";
import type { HarnessRuntimeOptions } from "../types.js";
import {
  classifyCommand,
  detectEmulationGap,
  tier0RuntimeCapabilities,
  type ClassificationDecision,
  type ClassificationReason,
  type Tier0ClassificationPolicy,
} from "./command-classification.js";

type CorpusCase = {
  readonly name: string;
  readonly script: string;
  readonly decision: ClassificationDecision;
  readonly reasons: readonly ClassificationReason[];
  readonly runtime?: HarnessRuntimeOptions;
  readonly policy?: Tier0ClassificationPolicy;
};

const supported = (...commands: string[]): ClassificationReason => ({
  kind: "tier0-supported",
  commands,
});

/**
 * Reasons come back sorted by `kind`, so expectations are written in that order:
 * capability-disabled, dynamic-command, empty-script, needs-real-exec, opaque-script,
 * policy-blocked, tier0-supported, unknown-command.
 */
const corpus: readonly CorpusCase[] = [
  // ---- read patterns: the workload Tier-0 exists for -------------------------------
  {
    name: "grep pipeline",
    script: "grep -rn TODO src | head -20",
    decision: "run",
    reasons: [supported("grep", "head")],
  },
  {
    name: "jq over a file",
    script: "cat package.json | jq -r .name",
    decision: "run",
    reasons: [supported("cat", "jq")],
  },
  {
    name: "rg into xargs",
    script: "rg --files-with-matches TODO | xargs wc -l",
    decision: "run",
    // `wc` is xargs' argument, not a command position, so it is not collected. Harmless
    // here; see the documented blind spot below for when it is not.
    reasons: [supported("rg", "xargs")],
  },
  {
    name: "xargs hides its child command — classification says run, the detector catches it",
    script: "rg --files | xargs cargo build",
    decision: "run",
    reasons: [supported("rg", "xargs")],
  },
  {
    name: "find with -exec",
    script: 'find . -name "*.ts" -newer tsconfig.json',
    decision: "run",
    reasons: [supported("find")],
  },
  {
    name: "yq / sqlite3 / xan are emulated too",
    script: "yq -o json config.yaml | sqlite3 :memory: && xan headers data.csv",
    decision: "run",
    reasons: [supported("sqlite3", "xan", "yq")],
  },
  {
    name: "loop body commands are seen",
    script: 'for f in *.json; do jq . "$f"; done',
    decision: "run",
    reasons: [supported("jq")],
  },
  {
    name: "command substitution is seen",
    script: "echo $(wc -l < notes.md)",
    decision: "run",
    reasons: [supported("echo", "wc")],
  },

  // ---- git: not emulated at all ----------------------------------------------------
  {
    name: "git read operation",
    script: "git status --short",
    decision: "escalate",
    reasons: [{ kind: "needs-real-exec", command: "git", reason: "version-control" }],
  },
  {
    name: "git write operation",
    script: "git add -A && git commit -m wip && git push origin main",
    decision: "escalate",
    reasons: [{ kind: "needs-real-exec", command: "git", reason: "version-control" }],
  },

  // ---- package managers ------------------------------------------------------------
  {
    name: "npm install",
    script: "npm install",
    decision: "escalate",
    reasons: [{ kind: "needs-real-exec", command: "npm", reason: "package-manager" }],
  },
  {
    name: "pnpm install",
    script: "pnpm install --frozen-lockfile",
    decision: "escalate",
    reasons: [{ kind: "needs-real-exec", command: "pnpm", reason: "package-manager" }],
  },
  {
    name: "pip install",
    script: "pip install -r requirements.txt",
    decision: "escalate",
    reasons: [{ kind: "needs-real-exec", command: "pip", reason: "package-manager" }],
  },
  {
    name: "sudo apt-get",
    script: "sudo apt-get install -y jq",
    decision: "escalate",
    reasons: [{ kind: "needs-real-exec", command: "sudo", reason: "process-control" }],
  },

  // ---- compilers and build tools ---------------------------------------------------
  {
    name: "make",
    script: "make -j4 all",
    decision: "escalate",
    reasons: [{ kind: "needs-real-exec", command: "make", reason: "build-toolchain" }],
  },
  {
    name: "cargo build",
    script: "cargo build --release",
    decision: "escalate",
    reasons: [{ kind: "needs-real-exec", command: "cargo", reason: "build-toolchain" }],
  },
  {
    name: "gcc",
    script: "gcc -O2 -o out main.c",
    decision: "escalate",
    reasons: [{ kind: "needs-real-exec", command: "gcc", reason: "build-toolchain" }],
  },
  {
    name: "playwright",
    script: "playwright test --reporter=list",
    decision: "escalate",
    reasons: [{ kind: "needs-real-exec", command: "playwright", reason: "build-toolchain" }],
  },
  {
    name: "unlisted command still escalates, just less specifically",
    script: "frobnicate --all",
    decision: "escalate",
    reasons: [{ kind: "unknown-command", command: "frobnicate" }],
  },

  // ---- network ---------------------------------------------------------------------
  {
    name: "curl with network off is escalate, not deny",
    script: "curl -sS https://api.example.com/v1 | jq .",
    decision: "escalate",
    reasons: [
      { kind: "capability-disabled", command: "curl", capability: "network" },
      supported("jq"),
    ],
  },
  {
    name: "curl with network on runs",
    script: "curl -sS https://api.example.com/v1 | jq .",
    runtime: { network: true },
    decision: "run",
    reasons: [supported("curl", "jq")],
  },
  {
    name: "curl with an allowlist policy runs",
    script: "curl -sS https://api.example.com/v1",
    runtime: { network: { allowedUrlPrefixes: ["https://api.example.com/"] } },
    decision: "run",
    reasons: [supported("curl")],
  },
  {
    name: "wget is not emulated at any network setting",
    script: "wget https://example.com/file.tar.gz",
    runtime: { network: true },
    decision: "escalate",
    reasons: [{ kind: "needs-real-exec", command: "wget", reason: "network-client" }],
  },

  // ---- python / javascript ---------------------------------------------------------
  {
    name: "python heredoc runs on the WASM interpreter",
    script: "python3 <<'PY'\nprint(sum(range(10)))\nPY",
    decision: "run",
    reasons: [supported("python3")],
  },
  {
    name: "python with the capability off escalates",
    script: "python3 analyze.py",
    runtime: { python: false },
    decision: "escalate",
    reasons: [{ kind: "capability-disabled", command: "python3", capability: "python" }],
  },
  {
    name: "js heredoc runs on QuickJS",
    script: "js-exec <<'JS'\nconsole.log(1 + 1);\nJS",
    decision: "run",
    reasons: [supported("js-exec")],
  },
  {
    name: "node is the QuickJS command, gated on javascript",
    script: "node -e 'console.log(1)'",
    runtime: { javascript: false },
    decision: "escalate",
    reasons: [{ kind: "capability-disabled", command: "node", capability: "javascript" }],
  },
  {
    name: "node runs when javascript is on",
    script: "node script.js",
    decision: "run",
    reasons: [supported("node")],
  },

  // ---- compound pipelines: one unsupported member escalates the whole thing ---------
  {
    name: "supported prefix does not get to run",
    script: "rm -rf build && cargo build --release",
    decision: "escalate",
    reasons: [
      { kind: "needs-real-exec", command: "cargo", reason: "build-toolchain" },
      supported("rm"),
    ],
  },
  {
    name: "unsupported member mid-pipe",
    script: "ls -1 | grep '^src' | docker build -",
    decision: "escalate",
    reasons: [
      { kind: "needs-real-exec", command: "docker", reason: "containers" },
      supported("grep", "ls"),
    ],
  },
  {
    name: "unsupported inside a subshell",
    script: "(cd src && make test) | tee build.log",
    decision: "escalate",
    reasons: [
      { kind: "needs-real-exec", command: "make", reason: "build-toolchain" },
      supported("cd", "tee"),
    ],
  },
  {
    name: "unsupported inside a command substitution",
    script: "VERSION=$(git describe --tags); echo $VERSION",
    decision: "escalate",
    reasons: [
      { kind: "needs-real-exec", command: "git", reason: "version-control" },
      supported("echo"),
    ],
  },
  {
    name: "unsupported inside an if condition",
    script: "if docker info > /dev/null; then echo up; fi",
    decision: "escalate",
    reasons: [
      { kind: "needs-real-exec", command: "docker", reason: "containers" },
      supported("echo"),
    ],
  },
  {
    name: "unsupported behind a heredoc-fed pipe",
    script: "cat <<'EOF' | docker build -\nFROM scratch\nEOF",
    decision: "escalate",
    reasons: [
      { kind: "needs-real-exec", command: "docker", reason: "containers" },
      supported("cat"),
    ],
  },
  {
    name: "several unsupported commands each get a reason",
    script: "npm ci && cargo build && git push",
    decision: "escalate",
    reasons: [
      { kind: "needs-real-exec", command: "cargo", reason: "build-toolchain" },
      { kind: "needs-real-exec", command: "git", reason: "version-control" },
      { kind: "needs-real-exec", command: "npm", reason: "package-manager" },
    ],
  },

  // ---- quoting -----------------------------------------------------------------------
  {
    name: "a quoted command name is an argument, not a command",
    script: "echo 'cargo build'",
    decision: "run",
    reasons: [supported("echo")],
  },
  {
    name: "double quotes likewise",
    script: 'echo "docker ps"',
    decision: "run",
    reasons: [supported("echo")],
  },
  {
    name: "a command name in a heredoc body is data",
    script: "cat <<'EOF'\ngit push --force\nEOF",
    decision: "run",
    reasons: [supported("cat")],
  },
  {
    name: "grep for a command name is not a command",
    script: "grep -F 'docker run' Makefile",
    decision: "run",
    reasons: [supported("grep")],
  },
  {
    name: "escaped and quoted fragments still resolve to one literal name",
    script: "e\\cho hi",
    decision: "run",
    reasons: [supported("echo")],
  },

  // ---- shell functions shadow the matrix ---------------------------------------------
  {
    name: "a function defined in the script shadows an unsupported name",
    script: "cargo() { echo stub; }; cargo build",
    decision: "run",
    reasons: [supported("cargo", "echo")],
  },
  {
    name: "a defined-but-uncalled function does not make its body disappear",
    script: "deploy() { kubectl apply -f .; }",
    decision: "escalate",
    reasons: [{ kind: "needs-real-exec", command: "kubectl", reason: "containers" }],
  },

  // ---- names that cannot be read statically ------------------------------------------
  {
    name: "a variable command name escalates rather than half-running",
    script: "CMD=cargo; $CMD build",
    decision: "escalate",
    reasons: [{ kind: "dynamic-command", source: "${CMD}" }],
  },
  {
    name: "a command-substitution command name escalates",
    script: "$(which cargo) build",
    decision: "escalate",
    reasons: [{ kind: "dynamic-command", source: "$(...)" }, supported("which")],
  },

  // ---- nested interpreters -------------------------------------------------------------
  {
    name: "bash -c payload is classified, not trusted",
    script: "bash -c 'cargo build'",
    decision: "escalate",
    reasons: [
      { kind: "needs-real-exec", command: "cargo", reason: "build-toolchain" },
      supported("bash"),
    ],
  },
  {
    name: "a supported bash -c payload still runs",
    script: "sh -c 'echo hi | wc -c'",
    decision: "run",
    reasons: [supported("echo", "sh", "wc")],
  },
  {
    name: "an unreadable eval payload escalates",
    script: 'eval "$SETUP_COMMANDS"',
    decision: "escalate",
    reasons: [{ kind: "dynamic-command", source: "eval" }, supported("eval")],
  },
  {
    name: "a literal eval payload is classified",
    script: "eval 'git fetch --all'",
    decision: "escalate",
    reasons: [
      { kind: "needs-real-exec", command: "git", reason: "version-control" },
      supported("eval"),
    ],
  },

  // ---- script files: runnable, but their contents are invisible ------------------------
  {
    name: "a relative script runs — just-bash interprets it",
    script: "./build.sh",
    decision: "run",
    reasons: [{ kind: "opaque-script", command: "./build.sh" }],
  },
  {
    name: "a sourced script is flagged the same way",
    script: "source ./env.sh && echo ready",
    decision: "run",
    reasons: [{ kind: "opaque-script", command: "./env.sh" }, supported("echo", "source")],
  },
  {
    name: "bash <file> is an opaque script, not a bash -c payload",
    script: "bash scripts/setup.sh",
    decision: "run",
    reasons: [{ kind: "opaque-script", command: "scripts/setup.sh" }, supported("bash")],
  },

  // ---- builtins -------------------------------------------------------------------------
  {
    name: "implemented builtins are supported",
    script: "cd /session; export FOO=1; test -f x && echo ok",
    decision: "run",
    reasons: [supported("cd", "echo", "export", "test")],
  },
  {
    name: "a builtin `help` advertises but does not implement escalates",
    script: "trap 'echo bye' EXIT; echo hi",
    decision: "escalate",
    reasons: [
      { kind: "needs-real-exec", command: "trap", reason: "unimplemented-builtin" },
      supported("echo"),
    ],
  },
  {
    name: "job control is not emulated",
    script: "jobs -l",
    decision: "escalate",
    reasons: [{ kind: "needs-real-exec", command: "jobs", reason: "unimplemented-builtin" }],
  },

  // ---- policy ----------------------------------------------------------------------------
  {
    name: "a denied command is deny, not escalate",
    script: "curl -s https://example.com | jq .",
    runtime: { network: true },
    policy: { denyCommands: ["curl"] },
    decision: "deny",
    reasons: [
      { kind: "policy-blocked", command: "curl", rule: "denyCommands" },
      supported("jq"),
    ],
  },
  {
    name: "deny outranks escalate in the same script",
    script: "cargo build && curl https://example.com",
    policy: { denyCommands: ["curl"], rule: "egress" },
    decision: "deny",
    reasons: [
      { kind: "needs-real-exec", command: "cargo", reason: "build-toolchain" },
      { kind: "policy-blocked", command: "curl", rule: "egress" },
    ],
  },
  {
    name: "a function cannot shadow its way past a denial",
    script: "curl() { echo spoofed; }; curl https://example.com",
    policy: { denyCommands: ["curl"] },
    decision: "deny",
    reasons: [
      { kind: "policy-blocked", command: "curl", rule: "denyCommands" },
      supported("echo"),
    ],
  },

  // ---- degenerate scripts ------------------------------------------------------------------
  { name: "empty script", script: "", decision: "run", reasons: [{ kind: "empty-script" }] },
  {
    name: "whitespace only",
    script: "   \n\t ",
    decision: "run",
    reasons: [{ kind: "empty-script" }],
  },
  {
    name: "comment only",
    script: "# build the thing\n",
    decision: "run",
    reasons: [{ kind: "empty-script" }],
  },
  {
    name: "assignment only",
    script: "FOO=bar",
    decision: "run",
    reasons: [{ kind: "empty-script" }],
  },
];

describe("classifyCommand corpus", () => {
  for (const entry of corpus) {
    it(entry.name, () => {
      const classification = classifyCommand(entry.script, {
        ...(entry.runtime === undefined ? {} : { runtime: entry.runtime }),
        ...(entry.policy === undefined ? {} : { policy: entry.policy }),
      });
      expect(classification.decision).toBe(entry.decision);
      expect(classification.reasons).toEqual(entry.reasons);
    });
  }

  it("gives every decision at least one reason", () => {
    for (const entry of corpus) {
      const classification = classifyCommand(entry.script, {
        ...(entry.runtime === undefined ? {} : { runtime: entry.runtime }),
        ...(entry.policy === undefined ? {} : { policy: entry.policy }),
      });
      expect(classification.reasons.length).toBeGreaterThan(0);
    }
  });

  it("is deterministic — same input, byte-identical output", () => {
    for (const entry of corpus) {
      const options = {
        ...(entry.runtime === undefined ? {} : { runtime: entry.runtime }),
        ...(entry.policy === undefined ? {} : { policy: entry.policy }),
      };
      const first = JSON.stringify(classifyCommand(entry.script, options));
      const second = JSON.stringify(classifyCommand(entry.script, options));
      expect(second).toBe(first);
    }
  });

  it("deduplicates repeated commands into one reason", () => {
    const classification = classifyCommand("cargo fmt && cargo clippy && cargo test");
    expect(classification.reasons).toEqual([
      { kind: "needs-real-exec", command: "cargo", reason: "build-toolchain" },
    ]);
  });
});

describe("classifyCommand parse failures", () => {
  it("escalates a script just-bash cannot parse", () => {
    // Process substitution is valid bash that just-bash's parser rejects. Running it at
    // Tier-0 would report a syntax error for a script a real shell runs fine, and no
    // runtime signal could tell that apart from a genuine typo — so it escalates.
    const classification = classifyCommand("diff <(sort a.txt) <(sort b.txt)");
    expect(classification.decision).toBe("escalate");
    expect(classification.reasons).toHaveLength(1);
    expect(classification.reasons[0]?.kind).toBe("parse-failed");
  });

  it("escalates an unterminated quote the same way", () => {
    const classification = classifyCommand("echo 'unterminated");
    expect(classification.decision).toBe("escalate");
    expect(classification.reasons[0]?.kind).toBe("parse-failed");
  });
});

describe("tier0RuntimeCapabilities", () => {
  it("mirrors bashOptionsForRuntime: python and javascript default on, network off", () => {
    expect(tier0RuntimeCapabilities(undefined)).toEqual({
      python: true,
      javascript: true,
      network: false,
    });
    expect(tier0RuntimeCapabilities({})).toEqual({
      python: true,
      javascript: true,
      network: false,
    });
    expect(tier0RuntimeCapabilities({ python: false, javascript: false, network: false })).toEqual({
      python: false,
      javascript: false,
      network: false,
    });
    expect(tier0RuntimeCapabilities({ network: { allowedUrlPrefixes: [] } }).network).toBe(true);
  });
});

describe("detectEmulationGap", () => {
  it("matches just-bash's real command-not-found output", async () => {
    const result = await new Bash().exec("cargo build");
    expect(result.exitCode).toBe(127);
    expect(detectEmulationGap(result)).toEqual({
      kind: "emulation-gap",
      signal: "command-not-found",
      command: "cargo",
    });
  });

  it("matches the command-unavailable variant python3 produces when it is not registered", async () => {
    const result = await new Bash().exec("python3 -c 'print(1)'");
    expect(detectEmulationGap(result)).toEqual({
      kind: "emulation-gap",
      signal: "command-unavailable",
      command: "python3",
    });
  });

  it("matches a real unrecognized long option from an emulated command", async () => {
    const result = await new Bash().exec("ls --color=always");
    expect(detectEmulationGap(result)).toEqual({
      kind: "emulation-gap",
      signal: "unsupported-option",
      command: "ls",
      option: "--color=always",
    });
  });

  it("matches a real invalid short option from an emulated command", async () => {
    const result = await new Bash().exec("grep -Z pattern file.txt");
    expect(detectEmulationGap(result)).toEqual({
      kind: "emulation-gap",
      signal: "unsupported-option",
      command: "grep",
      option: "-Z",
    });
  });

  it("does not read an option rejection from a command outside the matrix as a coverage gap", () => {
    expect(
      detectEmulationGap({ stderr: "cargo: unrecognized option '--frob'\n", exitCode: 1 }),
    ).toBeUndefined();
  });

  it("finds the gap even when the pipeline's exit code is 0", () => {
    // A pipeline's status is its last command's, so `cargo build | cat` succeeds.
    expect(
      detectEmulationGap({ stderr: "bash: cargo: command not found\n", exitCode: 0 }),
    ).toEqual({ kind: "emulation-gap", signal: "command-not-found", command: "cargo" });
  });

  it("ignores failures a real shell would report identically", async () => {
    const bash = new Bash({ files: { "/script.sh": "echo hi\n" }, cwd: "/" });
    const denied = await bash.exec("./script.sh");
    expect(denied.exitCode).toBe(126);
    expect(detectEmulationGap(denied)).toBeUndefined();

    const missing = await bash.exec("cat /nope.txt");
    expect(detectEmulationGap(missing)).toBeUndefined();

    expect(detectEmulationGap({ stderr: "", exitCode: 1 })).toBeUndefined();
    expect(detectEmulationGap({ stderr: "grep: no matches\n", exitCode: 1 })).toBeUndefined();
  });

  it("closes the loop on the xargs blind spot classification cannot see", async () => {
    const script = "echo /a.txt | xargs cargo build";
    expect(classifyCommand(script).decision).toBe("run");
    const result = await new Bash({ files: { "/a.txt": "x\n" }, cwd: "/" }).exec(script);
    expect(detectEmulationGap(result)).toEqual({
      kind: "emulation-gap",
      signal: "command-not-found",
      command: "cargo",
    });
  });

  it("cannot see a flag gap that just-bash swallows silently", async () => {
    // Documented limitation, not an aspiration: just-bash's grep does not implement
    // --include and rejects it without going through the shared option parser, so the
    // run fails with an empty stderr that neither layer can distinguish from "no match".
    const bash = new Bash({ files: { "/data.txt": "alpha\n" }, cwd: "/" });
    const result = await bash.exec("grep --include=*.txt alpha /data.txt");
    expect(result.stderr).toBe("");
    expect(detectEmulationGap(result)).toBeUndefined();
  });

  it("does not match a message merely containing the phrase", () => {
    expect(
      detectEmulationGap({
        stderr: "note: bash: cargo: command not found was reported earlier\n",
        exitCode: 1,
      }),
    ).toBeUndefined();
  });
});
