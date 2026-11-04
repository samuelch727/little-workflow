import { describe, expect, it } from "vitest";
import { justBashSandbox } from "../runtime/just-bash-runtime.js";
import type { HarnessSandboxFactory, HarnessRuntimeOptions } from "../types.js";
import {
  resolveSandbox,
  selectSandboxMode,
} from "./execution-environment.js";

/** Locked down enough for the in-process adapter: no model-authored code, no network. */
const sealed: HarnessRuntimeOptions = { python: false, javascript: false };

describe("selectSandboxMode", () => {
  it("stays in-process only when code execution and network are both off", () => {
    expect(selectSandboxMode(sealed)).toBe("in-process");
    expect(selectSandboxMode({ ...sealed, network: false })).toBe("in-process");
    expect(selectSandboxMode({ ...sealed, bash: true, toolBridge: false })).toBe(
      "in-process",
    );
  });

  it("takes the subprocess sandbox whenever the turn can execute model-authored code", () => {
    expect(selectSandboxMode({ ...sealed, python: true })).toBe("subprocess");
    expect(selectSandboxMode({ ...sealed, javascript: true })).toBe("subprocess");
  });

  it("takes the subprocess sandbox for any network policy", () => {
    expect(selectSandboxMode({ ...sealed, network: true })).toBe("subprocess");
    expect(
      selectSandboxMode({ ...sealed, network: { allowedUrlPrefixes: ["https://x/"] } }),
    ).toBe("subprocess");
  });

  it("treats just-bash's defaults as code execution: unset runtime is not in-process", () => {
    // python and javascript default to ON, so "auto" only stays in-process for callers who
    // opt out of both by hand.
    expect(selectSandboxMode(undefined)).toBe("subprocess");
    expect(selectSandboxMode({})).toBe("subprocess");
    expect(selectSandboxMode({ python: false })).toBe("subprocess");
    expect(selectSandboxMode({ javascript: false })).toBe("subprocess");
  });
});

describe("resolveSandbox", () => {
  it("defaults to the auto rule when nothing is configured", () => {
    // just-bash enables python and javascript by default, so an unconfigured turn can run
    // model-authored code and takes the subprocess sandbox.
    expect(resolveSandbox(undefined, undefined)).not.toBe(justBashSandbox());
    expect(resolveSandbox(undefined, { network: true })).not.toBe(justBashSandbox());
    const sealed: HarnessRuntimeOptions = { python: false, javascript: false };
    expect(resolveSandbox(undefined, sealed)).toBe(justBashSandbox());
  });

  it("passes an injected factory through untouched", () => {
    const custom: HarnessSandboxFactory = async () => {
      throw new Error("unused");
    };
    expect(resolveSandbox(custom, undefined)).toBe(custom);
  });

  it("pins the explicit modes regardless of runtime options", () => {
    expect(resolveSandbox("in-process", { network: true })).toBe(justBashSandbox());
    expect(resolveSandbox("subprocess", sealed)).not.toBe(justBashSandbox());
  });

  it("routes each auto branch to its adapter", () => {
    expect(resolveSandbox("auto", sealed)).toBe(justBashSandbox());
    expect(resolveSandbox("auto", { ...sealed, network: true })).not.toBe(
      justBashSandbox(),
    );
    expect(resolveSandbox("auto", undefined)).not.toBe(justBashSandbox());
  });
});
