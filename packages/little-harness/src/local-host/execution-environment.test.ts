import { describe, expect, it } from "vitest";
import { createJustBashRuntime } from "../runtime/just-bash-runtime.js";
import type { HarnessExecutionEnvironmentFactory, HarnessRuntimeOptions } from "../types.js";
import {
  resolveExecutionEnvironment,
  selectExecutionEnvironmentMode,
} from "./execution-environment.js";

/** Locked down enough for the in-process adapter: no model-authored code, no network. */
const sealed: HarnessRuntimeOptions = { python: false, javascript: false };

describe("selectExecutionEnvironmentMode", () => {
  it("stays in-process only when code execution and network are both off", () => {
    expect(selectExecutionEnvironmentMode(sealed)).toBe("in-process");
    expect(selectExecutionEnvironmentMode({ ...sealed, network: false })).toBe("in-process");
    expect(selectExecutionEnvironmentMode({ ...sealed, bash: true, toolBridge: false })).toBe(
      "in-process",
    );
  });

  it("takes the subprocess sandbox whenever the turn can execute model-authored code", () => {
    expect(selectExecutionEnvironmentMode({ ...sealed, python: true })).toBe("subprocess");
    expect(selectExecutionEnvironmentMode({ ...sealed, javascript: true })).toBe("subprocess");
  });

  it("takes the subprocess sandbox for any network policy", () => {
    expect(selectExecutionEnvironmentMode({ ...sealed, network: true })).toBe("subprocess");
    expect(
      selectExecutionEnvironmentMode({ ...sealed, network: { allowedUrlPrefixes: ["https://x/"] } }),
    ).toBe("subprocess");
  });

  it("treats just-bash's defaults as code execution: unset runtime is not in-process", () => {
    // python and javascript default to ON, so "auto" only stays in-process for callers who
    // opt out of both by hand.
    expect(selectExecutionEnvironmentMode(undefined)).toBe("subprocess");
    expect(selectExecutionEnvironmentMode({})).toBe("subprocess");
    expect(selectExecutionEnvironmentMode({ python: false })).toBe("subprocess");
    expect(selectExecutionEnvironmentMode({ javascript: false })).toBe("subprocess");
  });
});

describe("resolveExecutionEnvironment", () => {
  it("defaults to the auto rule when nothing is configured", () => {
    // just-bash enables python and javascript by default, so an unconfigured turn can run
    // model-authored code and takes the subprocess sandbox.
    expect(resolveExecutionEnvironment(undefined, undefined)).not.toBe(createJustBashRuntime);
    expect(resolveExecutionEnvironment(undefined, { network: true })).not.toBe(createJustBashRuntime);
    const sealed: HarnessRuntimeOptions = { python: false, javascript: false };
    expect(resolveExecutionEnvironment(undefined, sealed)).toBe(createJustBashRuntime);
  });

  it("passes an injected factory through untouched", () => {
    const custom: HarnessExecutionEnvironmentFactory = async () => {
      throw new Error("unused");
    };
    expect(resolveExecutionEnvironment(custom, undefined)).toBe(custom);
  });

  it("pins the explicit modes regardless of runtime options", () => {
    expect(resolveExecutionEnvironment("in-process", { network: true })).toBe(createJustBashRuntime);
    expect(resolveExecutionEnvironment("subprocess", sealed)).not.toBe(createJustBashRuntime);
  });

  it("routes each auto branch to its adapter", () => {
    expect(resolveExecutionEnvironment("auto", sealed)).toBe(createJustBashRuntime);
    expect(resolveExecutionEnvironment("auto", { ...sealed, network: true })).not.toBe(
      createJustBashRuntime,
    );
    expect(resolveExecutionEnvironment("auto", undefined)).not.toBe(createJustBashRuntime);
  });
});
