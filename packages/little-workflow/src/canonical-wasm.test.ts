import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalBrandProbeDiagnostics,
  canonicalJson,
  canonicalWithWasmSampleForTest,
  sha256Hex,
} from "./canonical.js";
import { canonicalWasmHashFixtures } from "./canonical-wasm-fixtures.js";

afterEach(() => vi.restoreAllMocks());

function wasmScopeWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return Object.assign(Object.defineProperties({}, Object.getOwnPropertyDescriptors(WebAssembly)), overrides);
}

function realInstanceWrapper() {
  function Instance(module: WebAssembly.Module) {
    return new WebAssembly.Instance(module);
  }
  Instance.prototype = WebAssembly.Instance.prototype;
  return Instance;
}

async function moduleThatThrowsWhileConstructingWasm(error: unknown) {
  vi.resetModules();
  const descriptor = Object.getOwnPropertyDescriptor(Reflect, "construct")!;
  const originalConstruct = Reflect.construct;
  const module = WebAssembly.Module;
  Object.defineProperty(Reflect, "construct", {
    ...descriptor,
    value(target: Function, args: ArrayLike<unknown>, newTarget?: Function) {
      if (target === module) throw error;
      return newTarget === undefined
        ? originalConstruct(target, args)
        : originalConstruct(target, args, newTarget);
    },
  });
  try {
    return await import("./canonical.js");
  } finally {
    Object.defineProperty(Reflect, "construct", descriptor);
  }
}

describe("canonical Wasm sample outcomes", () => {
  it("accepts only the native brand behind a JavaScript Instance wrapper", () => {
    const Instance = realInstanceWrapper();
    expect(Function.prototype.toString.call(Instance)).not.toContain("[native code]");
    const wrapped = canonicalWithWasmSampleForTest(undefined, wasmScopeWith({ Instance }));
    expect(wrapped.diagnostics).toEqual({
      wasmSampleState: "sample", compromised: false, wasmInstanceGetterRegistered: true,
    });
    for (const fixture of canonicalWasmHashFixtures) {
      expect(wrapped.sha256Hex(fixture.value), fixture.name).toBe(fixture.sha256Hex);
    }
    const sample = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const instance = Reflect.construct(Instance, [sample]);
    const prototype = Object.getPrototypeOf(instance);
    Object.setPrototypeOf(instance, Object.prototype);
    try {
      expect(() => wrapped.canonicalJson(instance)).toThrow("Built-in exotic objects are not hashable.");
    } finally {
      Object.setPrototypeOf(instance, prototype);
    }
  });

  it("keeps the wrapped Instance getter registered when sample compilation is refused", () => {
    const wrapped = canonicalWithWasmSampleForTest("refused", wasmScopeWith({ Instance: realInstanceWrapper() }));
    expect(wrapped.diagnostics).toEqual({
      wasmSampleState: "refused", compromised: false, wasmInstanceGetterRegistered: true,
    });
    for (const fixture of canonicalWasmHashFixtures) {
      expect(wrapped.sha256Hex(fixture.value), fixture.name).toBe(fixture.sha256Hex);
    }
  });

  it("rejects a JavaScript Instance wrapper that constructs a plain object", () => {
    let constructed = 0;
    function Instance() {
      constructed += 1;
      return {};
    }
    Instance.prototype = WebAssembly.Instance.prototype;
    const wrapped = canonicalWithWasmSampleForTest(undefined, wasmScopeWith({ Instance }));
    expect(constructed).toBe(1);
    expect(wrapped.diagnostics).toEqual({
      wasmSampleState: "sample", compromised: true, wasmInstanceGetterRegistered: false,
    });
    for (const fixture of canonicalWasmHashFixtures) {
      expect(() => wrapped.sha256Hex(fixture.value)).toThrow("Built-in exotic objects are not hashable.");
    }
  });

  it.each([undefined, "refused"] as const)("rejects a wrapped Instance with a non-native getter (%s)", (state) => {
    const getter = vi.fn(() => ({}));
    const Instance = realInstanceWrapper();
    Object.defineProperty(Instance, "prototype", {
      value: Object.defineProperty({}, "exports", { get: getter }),
    });
    const wrapped = canonicalWithWasmSampleForTest(state, wasmScopeWith({ Instance }));
    expect(wrapped.diagnostics.compromised).toBe(true);
    expect(wrapped.diagnostics.wasmInstanceGetterRegistered).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    expect(() => wrapped.sha256Hex({ plan: [] })).toThrow("Built-in exotic objects are not hashable.");
  });

  it.each(["Module", "CompileError", "Memory", "Table", "Global"] as const)("still requires a native %s constructor", (name) => {
    const original = WebAssembly[name];
    function Wrapper(...args: unknown[]) {
      return Reflect.construct(original, args);
    }
    Wrapper.prototype = original.prototype;
    const wrapped = canonicalWithWasmSampleForTest(undefined, wasmScopeWith({ [name]: Wrapper }));
    expect(wrapped.diagnostics.compromised).toBe(true);
    expect(() => wrapped.sha256Hex({ plan: [] })).toThrow("Built-in exotic objects are not hashable.");
  });

  it("requires the wrapped Instance prototype to be an own data property", () => {
    const Instance = realInstanceWrapper().bind(undefined);
    Object.setPrototypeOf(Instance, { prototype: WebAssembly.Instance.prototype });
    expect(Object.hasOwn(Instance, "prototype")).toBe(false);
    const wrapped = canonicalWithWasmSampleForTest(undefined, wasmScopeWith({ Instance }));
    expect(wrapped.diagnostics.compromised).toBe(true);
    expect(wrapped.diagnostics.wasmInstanceGetterRegistered).toBe(false);
  });

  it("rejects a proxied Instance wrapper without inspecting its prototype trap", () => {
    const getOwnPropertyDescriptor = vi.fn(Reflect.getOwnPropertyDescriptor);
    const Instance = new Proxy(realInstanceWrapper(), { getOwnPropertyDescriptor });
    const wrapped = canonicalWithWasmSampleForTest(undefined, wasmScopeWith({ Instance }));
    expect(wrapped.diagnostics.compromised).toBe(true);
    expect(wrapped.diagnostics.wasmInstanceGetterRegistered).toBe(false);
    expect(getOwnPropertyDescriptor).not.toHaveBeenCalled();
  });

  it("keeps the real Node sample path and all getter checks", () => {
    expect(canonicalBrandProbeDiagnostics()).toEqual({
      wasmSampleState: "sample", compromised: false, wasmInstanceGetterRegistered: true,
    });
    expect(canonicalJson({ plain: [true, null] })).toBe('{"plain":[true,null]}');
  });

  it("keeps native and poisoned-receiver checks registered after a compilation refusal", () => {
    const refused = canonicalWithWasmSampleForTest("refused");
    expect(refused.diagnostics).toEqual({
      wasmSampleState: "refused", compromised: false, wasmInstanceGetterRegistered: true,
    });
    const sample = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const instance = new WebAssembly.Instance(sample);
    const prototype = Object.getPrototypeOf(instance);
    Object.setPrototypeOf(instance, Object.prototype);
    try {
      // Even an instance disguised as a plain object is rejected by the registered getter.
      expect(() => refused.canonicalJson(instance)).toThrow("Built-in exotic objects are not hashable.");
    } finally {
      Object.setPrototypeOf(instance, prototype);
    }
  });

  it("classifies an exact native CompileError prototype without inspecting its message", async () => {
    const fresh = await moduleThatThrowsWhileConstructingWasm(new WebAssembly.CompileError("arbitrary native refusal message"));
    expect(fresh.canonicalBrandProbeDiagnostics()).toEqual({
      wasmSampleState: "refused", compromised: false, wasmInstanceGetterRegistered: true,
    });
    expect(fresh.sha256Hex(canonicalWasmHashFixtures[0].value)).toBe(canonicalWasmHashFixtures[0].sha256Hex);
  });

  it.each(["message spoof", "CompileError subclass"])("does not treat a %s as a trusted refusal", async (kind) => {
    class DerivedCompileError extends WebAssembly.CompileError {}
    const error = kind === "message spoof"
      ? new Error("Wasm code generation disallowed by embedder")
      : new DerivedCompileError("Wasm code generation disallowed by embedder");
    const fresh = await moduleThatThrowsWhileConstructingWasm(error);
    expect(fresh.canonicalBrandProbeDiagnostics().wasmSampleState).toBe("failed");
    expect(fresh.canonicalBrandProbeDiagnostics().compromised).toBe(true);
    expect(() => fresh.sha256Hex({ plan: [] })).toThrow("Built-in exotic objects are not hashable.");
  });

  it("rejects a proxy pretending to have the trusted CompileError prototype without reading its trap", async () => {
    const getPrototypeOf = vi.fn(() => WebAssembly.CompileError.prototype);
    const error = new Proxy({}, { getPrototypeOf });
    const fresh = await moduleThatThrowsWhileConstructingWasm(error);
    expect(fresh.canonicalBrandProbeDiagnostics().wasmSampleState).toBe("failed");
    expect(fresh.canonicalBrandProbeDiagnostics().compromised).toBe(true);
    expect(getPrototypeOf).not.toHaveBeenCalled();
  });

  it("rejects a non-native Instance getter even though no sample can be constructed", () => {
    const prototype = WebAssembly.Instance.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "exports")!;
    const getter = vi.fn(() => ({}));
    Object.defineProperty(prototype, "exports", { ...descriptor, get: getter });
    try {
      const refused = canonicalWithWasmSampleForTest("refused");
      expect(refused.diagnostics.compromised).toBe(true);
      expect(refused.diagnostics.wasmInstanceGetterRegistered).toBe(false);
      expect(getter).not.toHaveBeenCalled();
      for (const fixture of canonicalWasmHashFixtures) {
        expect(() => refused.sha256Hex(fixture.value)).toThrow("Built-in exotic objects are not hashable.");
      }
    } finally {
      Object.defineProperty(prototype, "exports", descriptor);
    }
  });

  it("rejects a native-source getter if its poisoned receiver is touched", async () => {
    vi.resetModules();
    const descriptor = Object.getOwnPropertyDescriptor(Reflect, "apply")!;
    const originalApply = Reflect.apply;
    const nativeGetter = Object.getOwnPropertyDescriptor(WebAssembly.Instance.prototype, "exports")!.get!;
    expect(Function.prototype.toString.call(nativeGetter)).toBe("function get exports() { [native code] }");
    let getterChecks = 0;
    Object.defineProperty(Reflect, "apply", {
      ...descriptor,
      value(target: Function, receiver: unknown, args: ArrayLike<unknown>) {
        if (target === nativeGetter) {
          getterChecks += 1;
          // Inject the observable access at the call boundary; the real native getter
          // still supplies both the source identity and its actual receiver rejection.
          Reflect.get(receiver as object, "length");
        }
        return originalApply(target, receiver, args);
      },
    });
    let fresh: typeof import("./canonical.js");
    try {
      fresh = await import("./canonical.js");
    } finally {
      Object.defineProperty(Reflect, "apply", descriptor);
    }
    const before = getterChecks;
    const refused = fresh.canonicalWithWasmSampleForTest("refused");
    expect(getterChecks).toBeGreaterThan(before);
    expect(refused.diagnostics.compromised).toBe(true);
    expect(refused.diagnostics.wasmInstanceGetterRegistered).toBe(false);
    expect(() => refused.sha256Hex({ plan: [] })).toThrow("Built-in exotic objects are not hashable.");
  });

  it("keeps failed sample construction compromised", () => {
    const failed = canonicalWithWasmSampleForTest("failed");
    expect(failed.diagnostics.wasmSampleState).toBe("failed");
    expect(failed.diagnostics.compromised).toBe(true);
    for (const fixture of canonicalWasmHashFixtures) {
      expect(() => failed.sha256Hex(fixture.value)).toThrow("Built-in exotic objects are not hashable.");
    }
  });

  it("marks a refused platform compromised when the Instance getter cannot be registered", () => {
    const descriptor = Object.getOwnPropertyDescriptor(WebAssembly, "Instance")!;
    Reflect.deleteProperty(WebAssembly, "Instance");
    try {
      const refused = canonicalWithWasmSampleForTest("refused");
      expect(refused.diagnostics.wasmSampleState).toBe("refused");
      expect(refused.diagnostics.compromised).toBe(true);
      expect(refused.diagnostics.wasmInstanceGetterRegistered).toBe(false);
      expect(() => refused.sha256Hex({ plan: [] })).toThrow("Built-in exotic objects are not hashable.");
    } finally {
      Object.defineProperty(WebAssembly, "Instance", descriptor);
    }
  });

  it("does not accept a refusal override with an untrusted CompileError constructor", () => {
    const descriptor = Object.getOwnPropertyDescriptor(WebAssembly, "CompileError")!;
    Object.defineProperty(WebAssembly, "CompileError", { ...descriptor, value: function CompileError() {} });
    try {
      const refused = canonicalWithWasmSampleForTest("refused");
      expect(refused.diagnostics.wasmSampleState).toBe("failed");
      expect(refused.diagnostics.compromised).toBe(true);
    } finally {
      Object.defineProperty(WebAssembly, "CompileError", descriptor);
    }
  });

  it("does not accept a refusal override with an untrusted Module constructor", () => {
    const descriptor = Object.getOwnPropertyDescriptor(WebAssembly, "Module")!;
    Object.defineProperty(WebAssembly, "Module", { ...descriptor, value: function Module() {} });
    try {
      const refused = canonicalWithWasmSampleForTest("refused");
      expect(refused.diagnostics.wasmSampleState).toBe("failed");
      expect(refused.diagnostics.compromised).toBe(true);
    } finally {
      Object.defineProperty(WebAssembly, "Module", descriptor);
    }
  });

  it("keeps plan-like fixture hashes identical for Node samples and safe refusals", () => {
    const refused = canonicalWithWasmSampleForTest("refused");
    expect(refused.diagnostics.compromised).toBe(false);
    for (const fixture of canonicalWasmHashFixtures) {
      expect(sha256Hex(fixture.value), fixture.name).toBe(fixture.sha256Hex);
      expect(refused.sha256Hex(fixture.value), fixture.name).toBe(fixture.sha256Hex);
      expect(refused.canonicalJson(fixture.value)).toBe(canonicalJson(fixture.value));
    }
  });
});
