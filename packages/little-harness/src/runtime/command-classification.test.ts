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
  {
    name: "mktemp substitution uses turn scratch",
    script: 't=$(mktemp); echo hi > "$t"',
    decision: "run",
    reasons: [supported("echo", "mktemp")],
  },
  {
    name: "quoted mktemp directory uses turn scratch",
    script: '"mktemp" -d',
    decision: "run",
    reasons: [supported("mktemp")],
  },
  {
    name: "yes remains emulated",
    script: "yes | head -1",
    decision: "run",
    reasons: [supported("head", "yes")],
  },
  {
    name: "literal cargo \"cargo\" build",
    script: "\"cargo\" build",
    decision: "escalate",
    reasons: [
      {
        kind: "needs-real-exec",
        command: "cargo",
        reason: "build-toolchain"
      }
    ]
  },
  {
    name: "literal cargo 'ca'rgo build",
    script: "'ca'rgo build",
    decision: "escalate",
    reasons: [
      {
        kind: "needs-real-exec",
        command: "cargo",
        reason: "build-toolchain"
      }
    ]
  },
  {
    name: "literal cargo ca\"rg\"o build",
    script: "ca\"rg\"o build",
    decision: "escalate",
    reasons: [
      {
        kind: "needs-real-exec",
        command: "cargo",
        reason: "build-toolchain"
      }
    ]
  },
  {
    name: "literal cargo \\cargo build",
    script: "\\cargo build",
    decision: "escalate",
    reasons: [
      {
        kind: "needs-real-exec",
        command: "cargo",
        reason: "build-toolchain"
      }
    ]
  },
  {
    name: "literal denied \"curl\" https://x",
    script: "\"curl\" https://x",
    decision: "deny",
    policy: {
      denyCommands: [
        "curl",
        "rm"
      ]
    },
    reasons: [
      {
        kind: "policy-blocked",
        command: "curl",
        rule: "denyCommands"
      }
    ]
  },
  {
    name: "literal denied 'rm' -rf build",
    script: "'rm' -rf build",
    decision: "deny",
    policy: {
      denyCommands: [
        "curl",
        "rm"
      ]
    },
    reasons: [
      {
        kind: "policy-blocked",
        command: "rm",
        rule: "denyCommands"
      }
    ]
  },
  {
    name: "literal denied r\"m\" -rf x",
    script: "r\"m\" -rf x",
    decision: "deny",
    policy: {
      denyCommands: [
        "curl",
        "rm"
      ]
    },
    reasons: [
      {
        kind: "policy-blocked",
        command: "rm",
        rule: "denyCommands"
      }
    ]
  },
  {
    name: "literal denied \\rm -rf x",
    script: "\\rm -rf x",
    decision: "deny",
    policy: {
      denyCommands: [
        "curl",
        "rm"
      ]
    },
    reasons: [
      {
        kind: "policy-blocked",
        command: "rm",
        rule: "denyCommands"
      }
    ]
  },
  {
    name: "quoted echo",
    script: "\"echo\" hi",
    decision: "run",
    reasons: [
      {
        kind: "tier0-supported",
        commands: [
          "echo"
        ]
      }
    ]
  },
  {
    name: "process cargo",
    script: "diff <(cargo metadata) <(sort b.txt)",
    decision: "escalate",
    reasons: [
      {
        kind: "needs-real-exec",
        command: "cargo",
        reason: "build-toolchain"
      },
      {
        kind: "tier0-supported",
        commands: [
          "diff",
          "sort"
        ]
      }
    ]
  },
  {
    name: "process denied curl",
    script: "diff <(curl https://x) b.txt",
    decision: "deny",
    policy: {
      denyCommands: [
        "curl"
      ]
    },
    reasons: [
      {
        kind: "policy-blocked",
        command: "curl",
        rule: "denyCommands"
      },
      {
        kind: "tier0-supported",
        commands: [
          "diff"
        ]
      }
    ]
  },
  {
    name: "process dynamic",
    script: "cat <($CMD)",
    decision: "escalate",
    reasons: [
      {
        kind: "dynamic-command",
        source: "${CMD}"
      },
      {
        kind: "tier0-supported",
        commands: [
          "cat"
        ]
      }
    ]
  },
  {
    name: "process docker",
    script: "tee >(docker load) < x.tar",
    decision: "escalate",
    reasons: [
      {
        kind: "needs-real-exec",
        command: "docker",
        reason: "containers"
      },
      {
        kind: "tier0-supported",
        commands: [
          "tee"
        ]
      }
    ]
  },
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
    reasons: [supported("rg", "wc", "xargs")],
  },
  {
    name: "xargs child command escalates before execution",
    script: "rg --files | xargs cargo build",
    decision: "escalate",
    reasons: [{ kind: "needs-real-exec", command: "cargo", reason: "build-toolchain" }, supported("rg", "xargs")],
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
    reasons: [{ kind: "needs-real-exec", command: "apt-get", reason: "package-manager" }, { kind: "needs-real-exec", command: "sudo", reason: "process-control" }],
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
    // A package launcher is a Node program, not a shell script: it needs what `node`
    // needs, so a Tier-0 without javascript escalates instead of failing "No such file".
    name: "a node_modules/.bin launcher is classified as node",
    script: "cd /session && ./node_modules/.bin/vite build 2>&1; echo \"EXIT=$?\"",
    runtime: { javascript: false },
    decision: "escalate",
    reasons: [
      { kind: "capability-disabled", command: "./node_modules/.bin/vite", capability: "javascript" },
      supported("cd", "echo"),
    ],
  },
  {
    name: "a node_modules/.bin launcher runs where node runs",
    script: "node_modules/.bin/tsc --noEmit",
    decision: "run",
    reasons: [supported("node")],
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
  it("runs supported process substitution and classifies its inner commands", () => {
    // just-bash 3.6.0 parses process substitution; both outer and inner names matter.
    const classification = classifyCommand("diff <(sort a.txt) <(sort b.txt)");
    expect(classification).toEqual({ decision: "run", reasons: [supported("diff", "sort")] });
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

  it("detects the same xargs miss if used without classification", async () => {
    const script = "echo /a.txt | xargs cargo build";
    expect(classifyCommand(script).decision).toBe("escalate");
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

it("keeps explicit managed mktemp destinations escalating before execution", () => {
  expect(classifyCommand("mktemp -p /session").decision).toBe("escalate");
  expect(classifyCommand('mktemp "$TEMPLATE"').decision).toBe("escalate");
});

it.each([
  "TMPDIR=/session mktemp",
  "export TMPDIR=/session; mktemp",
  "TMPDIR=/session; export TMPDIR; mktemp -d",
  'export TMPDIR="$DEST"; mktemp',
])("keeps TMPDIR assignments explicit before mktemp: %s", (script) => {
  expect(classifyCommand(script).decision).toBe("escalate");
});

it.each([
  "env TMPDIR=/session mktemp",
  "env -i TMPDIR=/session mktemp -d",
  'env TMPDIR="$DEST" mktemp',
  "env A=1 TMPDIR=/session B=2 mktemp",
  "command env TMPDIR=/session mktemp",
  "timeout 5 mktemp -p /session",
  "echo /session/x.XXXXXX | xargs mktemp",
  "echo /session/x.XXXXXX | xargs -n 1 env mktemp",
  "find /session -name '*.XXXXXX' -exec mktemp {} \\;",
])("keeps a mktemp destination explicit through a runner: %s", (script) => {
  const result = classifyCommand(script);
  expect(result.decision).toBe("escalate");
  expect(result.reasons).toContainEqual(expect.objectContaining({ kind: "needs-real-exec", command: "mktemp" }));
});

it.each([
  "env mktemp",
  "env -i mktemp -d",
  "env FOO=1 mktemp -d",
  "command mktemp",
  "timeout 5 mktemp",
  "env - mktemp",
])("runs a mktemp with no destination through a runner at tier 0: %s", (script) => {
  expect(classifyCommand(script).decision).toBe("run");
});

describe("runner targets", () => {
  it.each([
    "command cat /session/f", "env cat /session/f", "echo /session/f | xargs cat",
    "timeout 5 cat /session/f", "find /session -name f -exec cat {} \\;",
    "command rm /session/f", "builtin command cat /session/f", "exec cat /session/f",
    "env A=1 cat /session/f", "nice cat /session/f", "nohup cat /session/f",
    "find /session -execdir cat {} +", "find /session -ok cat {} \\;", "find /session -okdir cat {} \\;",
    "env -u A -- cat /session/f", "timeout -s TERM 5 cat /session/f", "nice -n 4 cat /session/f",
    "xargs -n 1 cat", "setsid cat /session/f", "stdbuf -o L cat /session/f", "sudo -u nobody cat /session/f",
  ])("denies literal target through %s", script => {
    expect(classifyCommand(script, { policy: { denyCommands: ["cat", "rm"] } }).decision).toBe("deny");
  });
  it.each(['xargs "$tool"', 'env $x', 'command env "$tool"']) ("does not follow expanded target: %s", script => {
    expect(classifyCommand(script).decision).toBe("run");
  });
  it.each(["xargs cargo build", "timeout 5 docker ps"])("escalates %s", script => {
    expect(classifyCommand(script).decision).toBe("escalate");
  });
  it.each(["command -v rm", "command -V rm"])("allows name lookup: %s", script => {
    expect(classifyCommand(script, { policy: { denyCommands: ["rm"] } }).decision).toBe("run");
  });
});

describe("runner option positions", () => {
  it.each(["command rm -v /session/f", "command cat -v /session/f", "command -p rm /session/f", 'env FOO="$BAR" rm f', "env -iu FOO rm /session/f", "xargs -tI {} rm {}", "xargs -tI{} rm {}"])("keeps target policy through %s", script => {
    expect(classifyCommand(script, { policy: { denyCommands: ["rm", "cat"] } }).decision).toBe("deny");
  });
  it.each(['env FOO="$BAR" grep x f', 'env FOO=$BAR grep x f', 'timeout "$T" grep x f', 'xargs -n "$N" echo', 'env -u "$NAME" grep x f', 'timeout -s "$SIG" "$T" grep x f', 'command -pv rm', 'command -V rm'])("does not mistake data for a target: %s", script => {
    expect(classifyCommand(script).decision).toBe("run");
  });
  it('keeps the actual expanded env target at tier zero', () => {
    expect(classifyCommand('env "$TOOL" f', { policy: { denyCommands: ["rm"] } }).decision).toBe("run");
  });
});


describe("runner expansion preserves baseline decisions", () => {
  it.each(['exec "$@"', 'env "$@"', 'timeout 5 "$@"', 'xargs "$1"', 'command "$1"', 'find . -exec "$T" {} \\;', 'env - grep x f', 'env -S "$ARGS"', 'env --split-string="$ARGS"', 'command env command env rm f'])("leaves %s at tier zero with or without policy", script => {
    for (const policy of [undefined, { denyCommands: ["rm", "cat"] }]) {
      expect(classifyCommand(script, { policy }).decision).toBe("run");
    }
  });
  it.each(["env - rm /session/f", "env -S 'rm f'", "env --split-string='rm f'", "env -iS 'rm f'", "env '-Srm f'"])("denies literal payload %s", script => {
    expect(classifyCommand(script, { policy: { denyCommands: ["rm"] } }).decision).toBe("deny");
  });
  it("keeps bare dynamic command behavior", () => {
    expect(classifyCommand('"$tool" f').decision).toBe("escalate");
  });
  it("stops nested split payloads without inventing an escalation reason", () => {
    let script = "rm f";
    for (let depth = 0; depth < 5; depth++) script = `env -S '${script.replaceAll("'", "'\\''")}'`;
    expect(classifyCommand(script, { policy: { denyCommands: ["rm"] } }).decision).toBe("run");
  });
});
