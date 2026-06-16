import { createHash, subtle, webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type CanonicalApi = {
  canonicalJson: (value: unknown) => string;
  sha256Hex: (value: unknown) => string;
  sha256Digest: (value: unknown) => string;
};

async function loadCanonicalApi(): Promise<Partial<CanonicalApi>> {
  return import("./index.js") as Promise<Partial<CanonicalApi>>;
}

const HEX_64 = /^[0-9a-f]{64}$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const EMPTY_WASM = new Uint8Array([
  0x00,
  0x61,
  0x73,
  0x6d,
  0x01,
  0x00,
  0x00,
  0x00,
]);

function createCurrentPlatformExotics(): object[] {
  const values: object[] = [];
  const globalScope = globalThis as unknown as Record<string, unknown>;
  const intlScope =
    typeof globalScope.Intl === "object" && globalScope.Intl !== null
      ? (globalScope.Intl as Record<string, unknown>)
      : {};

  pushConstructed(values, globalScope, "URLPattern", [
    "https://example.com/:path*",
  ]);
  pushConstructed(values, intlScope, "DurationFormat", ["en-US"]);

  pushGlobalObject(values, globalScope, "navigator");
  pushGlobalObject(values, globalScope, "crypto");

  const module = maybeConstructed(
    WebAssembly.Module as unknown as new (...args: unknown[]) => object,
    [EMPTY_WASM],
  );
  if (module !== undefined) {
    values.push(module);
    const instance = maybeConstructed(
      WebAssembly.Instance as unknown as new (...args: unknown[]) => object,
      [module],
    );
    if (instance !== undefined) {
      values.push(instance);
    }
  }
  pushConstructed(values, WebAssembly as unknown as Record<string, unknown>, "Memory", [
    { initial: 1 },
  ]);
  pushConstructed(values, WebAssembly as unknown as Record<string, unknown>, "Table", [
    { element: "anyfunc", initial: 1 },
  ]);
  pushConstructed(values, WebAssembly as unknown as Record<string, unknown>, "Global", [
    { mutable: true, value: "i32" },
    0,
  ]);

  return values;
}

function pushConstructed(
  values: object[],
  scope: Record<string, unknown>,
  name: string,
  args: readonly unknown[] = [],
): void {
  const constructor = scope[name];
  if (typeof constructor !== "function") {
    return;
  }

  const value = maybeConstructed(
    constructor as unknown as new (...args: unknown[]) => object,
    args,
  );
  if (value !== undefined) {
    values.push(value);
  }
}

function maybeConstructed(
  constructor: new (...args: unknown[]) => object,
  args: readonly unknown[],
): object | undefined {
  try {
    return Reflect.construct(constructor, [...args]) as object;
  } catch {
    return undefined;
  }
}

function pushGlobalObject(
  values: object[],
  scope: Record<string, unknown>,
  name: string,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(scope, name);
  if (
    descriptor === undefined ||
    !Object.hasOwn(descriptor, "value") ||
    typeof descriptor.value !== "object" ||
    descriptor.value === null
  ) {
    return;
  }

  const value = descriptor.value;
  if (typeof value === "object" && value !== null) {
    values.push(value);
  }
}

describe("canonical json", () => {
  it("serializes primitives with JSON.stringify-compatible output", async () => {
    const { canonicalJson } = await loadCanonicalApi();
    expect(canonicalJson).toBeTypeOf("function");

    expect(canonicalJson?.(null)).toBe("null");
    expect(canonicalJson?.(true)).toBe("true");
    expect(canonicalJson?.(false)).toBe("false");
    expect(canonicalJson?.(0)).toBe("0");
    expect(canonicalJson?.(-1.5)).toBe("-1.5");
    expect(canonicalJson?.(42)).toBe("42");
    expect(canonicalJson?.("hello")).toBe('"hello"');
    expect(canonicalJson?.('quote: "" \\ \n')).toBe('"quote: \\"\\" \\\\ \\n"');
  });

  it("preserves array order and serializes nested arrays", async () => {
    const { canonicalJson } = await loadCanonicalApi();

    expect(canonicalJson?.([])).toBe("[]");
    expect(canonicalJson?.([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson?.([[1, 2], [3, [4, 5]]])).toBe("[[1,2],[3,[4,5]]]");
  });

  it("sorts object keys recursively by code-unit order", async () => {
    const { canonicalJson } = await loadCanonicalApi();

    expect(canonicalJson?.({})).toBe("{}");
    expect(canonicalJson?.({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(
      canonicalJson?.({
        b: { y: 1, x: 2 },
        a: [{ b: 1, a: 2 }, { d: 3, c: 4 }],
      }),
    ).toBe('{"a":[{"a":2,"b":1},{"c":4,"d":3}],"b":{"x":2,"y":1}}');
    expect(canonicalJson?.({ A: 1, a: 2, B: 3, b: 4 })).toBe(
      '{"A":1,"B":3,"a":2,"b":4}',
    );
  });

  it("produces identical canonical output regardless of object key insertion order", async () => {
    const { canonicalJson, sha256Hex, sha256Digest } = await loadCanonicalApi();
    const left = { z: 1, a: { c: 3, b: 2 }, m: [1, 2, 3] };
    const right = { m: [1, 2, 3], a: { b: 2, c: 3 }, z: 1 };

    expect(canonicalJson?.(left)).toBe(canonicalJson?.(right));
    expect(sha256Hex?.(left)).toBe(sha256Hex?.(right));
    expect(sha256Digest?.(left)).toBe(sha256Digest?.(right));
  });

  it("differentiates values with different content", async () => {
    const { sha256Hex } = await loadCanonicalApi();

    expect(sha256Hex?.({ a: 1 })).not.toBe(sha256Hex?.({ a: 2 }));
    expect(sha256Hex?.([1, 2, 3])).not.toBe(sha256Hex?.([3, 2, 1]));
    expect(sha256Hex?.(null)).not.toBe(sha256Hex?.("null"));
    expect(sha256Hex?.(0)).not.toBe(sha256Hex?.(false));
  });

  it("returns sha256 hex and sha256:<hex> digest", async () => {
    const { canonicalJson, sha256Hex, sha256Digest } = await loadCanonicalApi();
    expect(sha256Hex).toBeTypeOf("function");
    expect(sha256Digest).toBeTypeOf("function");

    const value = { id: "support.summarize", version: 1 };
    const expectedCanonical = '{"id":"support.summarize","version":1}';
    const expected = "d7124fd8390a3a0dc3352797f909ef01035131c84cc9095df31d7d96110c4956";

    expect(canonicalJson?.(value)).toBe(expectedCanonical);
    expect(createHash("sha256").update(expectedCanonical).digest("hex")).toBe(expected);
    expect(sha256Hex?.(value)).toBe(expected);
    expect(sha256Hex?.(value)).toMatch(HEX_64);
    expect(sha256Digest?.(value)).toBe(`sha256:${expected}`);
    expect(sha256Digest?.(value)).toMatch(SHA256_DIGEST);
  });

  it("matches the RFC 8785 UTF-16 property ordering vector", async () => {
    const { canonicalJson } = await loadCanonicalApi();
    const value = {
      "\u20ac": "Euro Sign",
      "\r": "Carriage Return",
      "\ufb33": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "\ud83d\ude00": "Emoji: Grinning Face",
      "\u0080": "Control",
      "\u00f6": "Latin Small Letter O With Diaeresis",
    };

    expect(canonicalJson?.(value)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis","\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it("accepts prototype-less plain objects", async () => {
    const { canonicalJson } = await loadCanonicalApi();
    const bareObject = Object.create(null) as Record<string, unknown>;
    bareObject.b = 1;
    bareObject.a = 2;

    expect(canonicalJson?.(bareObject)).toBe('{"a":2,"b":1}');
  });

  it("accepts cross-realm plain records and arrays", async () => {
    const { canonicalJson } = await loadCanonicalApi();
    const crossRealmValue = runInNewContext(
      "({ b: 1, a: [2, { d: 4, c: 3 }] })",
    ) as unknown;

    expect(canonicalJson?.(crossRealmValue)).toBe(
      '{"a":[2,{"c":3,"d":4}],"b":1}',
    );
  });

  it("rejects non-finite numbers", async () => {
    const { canonicalJson, sha256Hex } = await loadCanonicalApi();

    expect(() => canonicalJson?.(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson?.(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalJson?.(Number.NEGATIVE_INFINITY)).toThrow(TypeError);
    expect(() => sha256Hex?.({ value: Number.NaN })).toThrow(TypeError);
  });

  it("rejects undefined values", async () => {
    const { canonicalJson } = await loadCanonicalApi();

    expect(() => canonicalJson?.(undefined)).toThrow(TypeError);
    expect(() => canonicalJson?.({ a: undefined })).toThrow(TypeError);
    expect(() => canonicalJson?.([undefined])).toThrow(TypeError);
  });

  it("rejects functions, bigint, and symbols", async () => {
    const { canonicalJson } = await loadCanonicalApi();

    expect(() => canonicalJson?.(() => 1)).toThrow(TypeError);
    expect(() => canonicalJson?.({ run: () => 1 })).toThrow(TypeError);
    expect(() => canonicalJson?.(BigInt(10))).toThrow(TypeError);
    expect(() => canonicalJson?.({ n: BigInt(10) })).toThrow(TypeError);
    expect(() => canonicalJson?.(Symbol("x"))).toThrow(TypeError);
    expect(() => canonicalJson?.({ s: Symbol("x") })).toThrow(TypeError);
  });

  it("rejects lone surrogate strings and keys", async () => {
    const { canonicalJson } = await loadCanonicalApi();
    const loneHighSurrogate = String.fromCharCode(0xd800);
    const loneLowSurrogate = String.fromCharCode(0xdead);
    const validSurrogatePair = "\ud83d\ude00";

    expect(canonicalJson?.(validSurrogatePair)).toBe(JSON.stringify(validSurrogatePair));
    expect(() => canonicalJson?.(loneHighSurrogate)).toThrow(TypeError);
    expect(() => canonicalJson?.(loneLowSurrogate)).toThrow(TypeError);
    expect(() => canonicalJson?.([loneLowSurrogate])).toThrow(TypeError);
    expect(() => canonicalJson?.({ [loneHighSurrogate]: "x" })).toThrow(TypeError);
    expect(() => canonicalJson?.({ value: loneLowSurrogate })).toThrow(TypeError);
  });

  it("rejects cycles", async () => {
    const { canonicalJson, sha256Hex } = await loadCanonicalApi();
    const cyclicObject: Record<string, unknown> = {};
    cyclicObject.self = cyclicObject;
    const cyclicArray: unknown[] = [];
    cyclicArray.push(cyclicArray);

    expect(() => canonicalJson?.(cyclicObject)).toThrow(TypeError);
    expect(() => canonicalJson?.(cyclicArray)).toThrow(TypeError);
    expect(() => sha256Hex?.(cyclicObject)).toThrow(TypeError);
  });

  it("rejects nested accessors without invoking them", async () => {
    const { canonicalJson } = await loadCanonicalApi();
    const inner: Record<string, unknown> = {};
    let getterCalls = 0;
    Object.defineProperty(inner, "lazy", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return "value";
      },
    });

    expect(() => canonicalJson?.({ inner })).toThrow(TypeError);
    expect(getterCalls).toBe(0);
  });

  it("accepts shared acyclic references", async () => {
    const { canonicalJson } = await loadCanonicalApi();
    const shared = { b: 2, a: 1 };

    expect(canonicalJson?.([shared, shared])).toBe(
      '[{"a":1,"b":2},{"a":1,"b":2}]',
    );
  });

  it("rejects sparse arrays", async () => {
    const { canonicalJson } = await loadCanonicalApi();
    const sparse = new Array<number>(2);
    sparse[1] = 5;

    expect(() => canonicalJson?.(sparse)).toThrow(TypeError);
  });

  it("rejects non-plain object containers", async () => {
    const { canonicalJson } = await loadCanonicalApi();
    class Wrapper {
      readonly id = "x";
    }
    class List extends Array<number> {}
    const customPrototype = Object.create(null) as Record<string, unknown>;
    const objectWithCustomPrototype = Object.create(customPrototype) as Record<
      string,
      unknown
    >;
    objectWithCustomPrototype.value = "x";

    expect(() => canonicalJson?.(new Map([["a", 1]]))).toThrow(TypeError);
    expect(() => canonicalJson?.(new Set([1, 2, 3]))).toThrow(TypeError);
    expect(() => canonicalJson?.(new Wrapper())).toThrow(TypeError);
    expect(() => canonicalJson?.(new List(1, 2))).toThrow(TypeError);
    expect(() => canonicalJson?.(new Date(0))).toThrow(TypeError);
    expect(() => canonicalJson?.(objectWithCustomPrototype)).toThrow(TypeError);
  });

  it("rejects containers with forged realm prototypes", async () => {
    const { canonicalJson } = await loadCanonicalApi();

    const objectPrototype = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(objectPrototype, "constructor", {
      value: Object,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    const objectWithForgedPrototype = Object.create(objectPrototype) as Record<
      string,
      unknown
    >;
    objectWithForgedPrototype.value = "x";

    const arrayPrototype: unknown[] = [];
    Object.setPrototypeOf(arrayPrototype, Object.prototype);
    Object.defineProperty(arrayPrototype, "constructor", {
      value: Array,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    const arrayWithForgedPrototype = ["x"];
    Object.setPrototypeOf(arrayWithForgedPrototype, arrayPrototype);

    expect(() => canonicalJson?.(objectWithForgedPrototype)).toThrow(TypeError);
    expect(() => canonicalJson?.(arrayWithForgedPrototype)).toThrow(TypeError);
  });

  it("rejects branded exotic containers with forged plain prototypes", async () => {
    const { canonicalJson } = await loadCanonicalApi();
    const brandedExotics: object[] = [
      new Date(0),
      new Map([["key", "value"]]),
      new Set(["value"]),
      /value/u,
      new Error("value"),
      new ArrayBuffer(4),
      new DataView(new ArrayBuffer(4)),
      new Uint8Array([1, 2]),
      Promise.resolve("value"),
      new WeakMap(),
      new WeakSet(),
      new Number(1),
      new String("value"),
      new Boolean(false),
      Object(BigInt(1)) as object,
      Object(Symbol("value")) as object,
      runInNewContext("new Date(0)") as object,
      new WeakRef({}),
      new FinalizationRegistry(() => {}),
      new Intl.DateTimeFormat("en-US"),
      new Intl.NumberFormat("en-US"),
      new Intl.Collator("en-US"),
      new AbortController().signal,
      ...createCurrentPlatformExotics(),
    ];

    for (const [index, value] of brandedExotics.entries()) {
      const originalPrototype = Object.getPrototypeOf(value);
      Object.setPrototypeOf(value, Object.prototype);
      try {
        expect(
          () => canonicalJson?.(value),
          `brandedExotics[${index}] ${Object.prototype.toString.call(value)}`,
        ).toThrow(TypeError);
      } finally {
        Object.setPrototypeOf(value, originalPrototype);
      }
    }
  });

  it("rejects data-backed platform singletons with own properties", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    const subtle = { foo: 1 };

    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      enumerable: true,
      value: { subtle },
    });

    try {
      vi.resetModules();
      const { canonicalJson } = (await import("./index.js")) as Partial<
        CanonicalApi
      >;
      expect(() => canonicalJson?.(subtle)).toThrow(TypeError);
    } finally {
      if (descriptor === undefined) {
        delete (globalThis as unknown as Record<string, unknown>).crypto;
      } else {
        Object.defineProperty(globalThis, "crypto", descriptor);
      }
      vi.resetModules();
    }
  });

  it("rejects node crypto singleton without invoking global crypto accessor", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    expect(descriptor).toBeDefined();
    let getterCalls = 0;

    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return webcrypto;
      },
    });

    try {
      vi.resetModules();
      const { canonicalJson } = (await import("./index.js")) as Partial<
        CanonicalApi
      >;
      const originalPrototype = Object.getPrototypeOf(webcrypto);
      Object.setPrototypeOf(webcrypto, Object.prototype);
      try {
        expect(() => canonicalJson?.(webcrypto)).toThrow(TypeError);
      } finally {
        Object.setPrototypeOf(webcrypto, originalPrototype);
      }
    } finally {
      if (descriptor === undefined) {
        delete (globalThis as unknown as Record<string, unknown>).crypto;
      } else {
        Object.defineProperty(globalThis, "crypto", descriptor);
      }
      vi.resetModules();
    }

    expect(getterCalls).toBe(0);
  });

  it("rejects node subtle crypto singleton without invoking global crypto accessor", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    expect(descriptor).toBeDefined();
    let getterCalls = 0;

    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return webcrypto;
      },
    });

    try {
      vi.resetModules();
      const { canonicalJson } = (await import("./index.js")) as Partial<
        CanonicalApi
      >;
      const originalPrototype = Object.getPrototypeOf(subtle);
      Object.setPrototypeOf(subtle, Object.prototype);
      try {
        expect(() => canonicalJson?.(subtle)).toThrow(TypeError);
      } finally {
        Object.setPrototypeOf(subtle, originalPrototype);
      }
    } finally {
      if (descriptor === undefined) {
        delete (globalThis as unknown as Record<string, unknown>).crypto;
      } else {
        Object.defineProperty(globalThis, "crypto", descriptor);
      }
      vi.resetModules();
    }

    expect(getterCalls).toBe(0);
  });

  it("rejects process.env even with a forged plain prototype", async () => {
    const { canonicalJson } = await loadCanonicalApi();
    const originalPrototype = Object.getPrototypeOf(process.env);

    Object.setPrototypeOf(process.env, Object.prototype);
    try {
      expect(() => canonicalJson?.(process.env)).toThrow(TypeError);
    } finally {
      Object.setPrototypeOf(process.env, originalPrototype);
    }
  });

  it("does not disable plain hashing for accessor-backed process.env", async () => {
    const { canonicalJson } = await loadCanonicalApi();
    const descriptor = Object.getOwnPropertyDescriptor(process, "env");
    expect(descriptor).toBeDefined();
    const env = { FOO: "bar" };

    Object.defineProperty(process, "env", {
      configurable: true,
      enumerable: true,
      get() {
        return env;
      },
    });

    try {
      expect(canonicalJson?.(process.env)).toBe('{"FOO":"bar"}');
    } finally {
      if (descriptor !== undefined) {
        Object.defineProperty(process, "env", descriptor);
      }
    }
  });

  it("does not invoke accessor-backed process.env while hashing", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "env");
    expect(descriptor).toBeDefined();
    const env = { FOO: "bar" };
    let getterCalls = 0;
    let result: string | undefined;
    let callsBeforeHash = 0;
    let callsAfterHash = 0;

    Object.defineProperty(process, "env", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return env;
      },
    });

    try {
      vi.resetModules();
      const { canonicalJson } = (await import("./index.js")) as Partial<
        CanonicalApi
      >;
      callsBeforeHash = getterCalls;
      result = canonicalJson?.(env);
      callsAfterHash = getterCalls;
    } finally {
      if (descriptor !== undefined) {
        Object.defineProperty(process, "env", descriptor);
      }
      vi.resetModules();
    }

    expect(callsAfterHash).toBe(callsBeforeHash);
    expect(result).toBe('{"FOO":"bar"}');
  });

  it("loads with an accessor-backed global process", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "process");
    expect(descriptor).toBeDefined();
    const processValue = process;

    Object.defineProperty(globalThis, "process", {
      configurable: true,
      enumerable: true,
      get() {
        return processValue;
      },
    });

    try {
      vi.resetModules();
      await expect(import("./index.js")).resolves.toBeDefined();
    } finally {
      if (descriptor === undefined) {
        delete (globalThis as unknown as Record<string, unknown>).process;
      } else {
        Object.defineProperty(globalThis, "process", descriptor);
      }
      vi.resetModules();
    }
  });

  it("fails closed without invoking patched platform brand probes", async () => {
    if (typeof URLPattern === "undefined") {
      return;
    }

    const descriptor = Object.getOwnPropertyDescriptor(
      URLPattern.prototype,
      "test",
    );
    expect(descriptor).toBeDefined();
    let calls = 0;
    Object.defineProperty(URLPattern.prototype, "test", {
      value() {
        /* [native code] */
        calls += 1;
        return "";
      },
      enumerable: false,
      configurable: true,
      writable: true,
    });
    const boundCalls = { count: 0 };

    try {
      vi.resetModules();
      const { canonicalJson } = (await import("./index.js")) as Partial<
        CanonicalApi
      >;
      expect(() => canonicalJson?.({ a: 1 })).toThrow(TypeError);
      expect(calls).toBe(0);
    } finally {
      if (descriptor !== undefined) {
        Object.defineProperty(URLPattern.prototype, "test", descriptor);
      }
      vi.resetModules();
    }

    Object.defineProperty(URLPattern.prototype, "test", {
      value: function patched() {
        boundCalls.count += 1;
        return false;
      }.bind(undefined),
      enumerable: false,
      configurable: true,
      writable: true,
    });

    try {
      vi.resetModules();
      const { canonicalJson } = (await import("./index.js")) as Partial<
        CanonicalApi
      >;
      expect(() => canonicalJson?.({ a: 1 })).toThrow(TypeError);
      expect(boundCalls.count).toBe(0);
    } finally {
      if (descriptor !== undefined) {
        Object.defineProperty(URLPattern.prototype, "test", descriptor);
      }
      vi.resetModules();
    }
  });

  it("does not trust borrowed native platform brand probes", async () => {
    if (typeof FinalizationRegistry === "undefined") {
      return;
    }

    const descriptor = Object.getOwnPropertyDescriptor(
      FinalizationRegistry.prototype,
      "unregister",
    );
    expect(descriptor).toBeDefined();
    let lengthCalls = 0;

    Object.defineProperty(FinalizationRegistry.prototype, "unregister", {
      value: Array.prototype.includes,
      enumerable: false,
      configurable: true,
      writable: true,
    });

    try {
      vi.resetModules();
      const { canonicalJson } = (await import("./index.js")) as Partial<
        CanonicalApi
      >;
      const value: Record<string, unknown> = { a: 1 };
      Object.defineProperty(value, "length", {
        enumerable: true,
        configurable: true,
        get() {
          lengthCalls += 1;
          return 0;
        },
      });

      expect(() => canonicalJson?.(value)).toThrow(TypeError);
      expect(lengthCalls).toBe(0);
    } finally {
      if (descriptor !== undefined) {
        Object.defineProperty(
          FinalizationRegistry.prototype,
          "unregister",
          descriptor,
        );
      }
      vi.resetModules();
    }
  });

  it("does not trust same-name borrowed native platform brand probes", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      Intl.DateTimeFormat.prototype,
      "resolvedOptions",
    );
    expect(descriptor).toBeDefined();

    Object.defineProperty(Intl.DateTimeFormat.prototype, "resolvedOptions", {
      value: Intl.NumberFormat.prototype.resolvedOptions,
      enumerable: false,
      configurable: true,
      writable: true,
    });

    try {
      vi.resetModules();
      const { canonicalJson } = (await import("./index.js")) as Partial<
        CanonicalApi
      >;
      const value = new Intl.DateTimeFormat("en-US");
      const originalPrototype = Object.getPrototypeOf(value);
      Object.setPrototypeOf(value, Object.prototype);
      try {
        expect(() => canonicalJson?.(value)).toThrow(TypeError);
      } finally {
        Object.setPrototypeOf(value, originalPrototype);
      }
    } finally {
      if (descriptor !== undefined) {
        Object.defineProperty(
          Intl.DateTimeFormat.prototype,
          "resolvedOptions",
          descriptor,
        );
      }
      vi.resetModules();
    }
  });

  it("fails closed when a sample-backed platform method probe is patched", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      Intl.DateTimeFormat.prototype,
      "resolvedOptions",
    );
    expect(descriptor).toBeDefined();
    const value = new Intl.DateTimeFormat("en-US");

    Object.defineProperty(Intl.DateTimeFormat.prototype, "resolvedOptions", {
      value: function resolvedOptions() {
        return {};
      },
      configurable: true,
      writable: true,
    });

    try {
      vi.resetModules();
      const { canonicalJson } = (await import("./index.js")) as Partial<
        CanonicalApi
      >;
      const originalPrototype = Object.getPrototypeOf(value);
      Object.setPrototypeOf(value, Object.prototype);
      try {
        expect(() => canonicalJson?.(value)).toThrow(TypeError);
      } finally {
        Object.setPrototypeOf(value, originalPrototype);
      }
    } finally {
      if (descriptor !== undefined) {
        Object.defineProperty(
          Intl.DateTimeFormat.prototype,
          "resolvedOptions",
          descriptor,
        );
      }
      vi.resetModules();
    }
  });

  it("fails closed when a sample-backed platform getter probe is patched", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      WebAssembly.Memory.prototype,
      "buffer",
    );
    expect(descriptor).toBeDefined();
    const value = new WebAssembly.Memory({ initial: 1 });

    Object.defineProperty(WebAssembly.Memory.prototype, "buffer", {
      configurable: true,
      get() {
        return new ArrayBuffer(0);
      },
    });

    try {
      vi.resetModules();
      const { canonicalJson } = (await import("./index.js")) as Partial<
        CanonicalApi
      >;
      const originalPrototype = Object.getPrototypeOf(value);
      Object.setPrototypeOf(value, Object.prototype);
      try {
        expect(() => canonicalJson?.(value)).toThrow(TypeError);
      } finally {
        Object.setPrototypeOf(value, originalPrototype);
      }
    } finally {
      if (descriptor !== undefined) {
        Object.defineProperty(
          WebAssembly.Memory.prototype,
          "buffer",
          descriptor,
        );
      }
      vi.resetModules();
    }
  });

  it("fails closed when a platform constructor is patched before module load", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Intl, "DateTimeFormat");
    expect(descriptor).toBeDefined();
    const value = new Intl.DateTimeFormat("en-US");

    Object.defineProperty(Intl, "DateTimeFormat", {
      value: function DateTimeFormat() {},
      configurable: true,
      writable: true,
    });

    try {
      vi.resetModules();
      const { canonicalJson } = (await import("./index.js")) as Partial<
        CanonicalApi
      >;
      const originalPrototype = Object.getPrototypeOf(value);
      Object.setPrototypeOf(value, Object.prototype);
      try {
        expect(() => canonicalJson?.(value)).toThrow(TypeError);
      } finally {
        Object.setPrototypeOf(value, originalPrototype);
      }
    } finally {
      if (descriptor !== undefined) {
        Object.defineProperty(Intl, "DateTimeFormat", descriptor);
      }
      vi.resetModules();
    }
  });

  it("does not invoke accessor-backed platform constructor probes and fails closed", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Intl, "DateTimeFormat");
    expect(descriptor).toBeDefined();
    const value = new Intl.DateTimeFormat("en-US");
    let getterCalls = 0;

    Object.defineProperty(Intl, "DateTimeFormat", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return function DateTimeFormat() {};
      },
    });

    try {
      vi.resetModules();
      const { canonicalJson } = (await import("./index.js")) as Partial<
        CanonicalApi
      >;
      const originalPrototype = Object.getPrototypeOf(value);
      Object.setPrototypeOf(value, Object.prototype);
      try {
        expect(() => canonicalJson?.(value)).toThrow(TypeError);
      } finally {
        Object.setPrototypeOf(value, originalPrototype);
      }
    } finally {
      if (descriptor !== undefined) {
        Object.defineProperty(Intl, "DateTimeFormat", descriptor);
      }
      vi.resetModules();
    }

    expect(getterCalls).toBe(0);
  });

  it("fails closed when WebAssembly module sampling is unavailable", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(WebAssembly, "Module");
    expect(descriptor).toBeDefined();
    const module = new WebAssembly.Module(EMPTY_WASM);
    const value = new WebAssembly.Instance(module);

    Object.defineProperty(WebAssembly, "Module", {
      value: function Module() {},
      configurable: true,
      writable: true,
    });

    try {
      vi.resetModules();
      const { canonicalJson } = (await import("./index.js")) as Partial<
        CanonicalApi
      >;
      const originalPrototype = Object.getPrototypeOf(value);
      Object.setPrototypeOf(value, Object.prototype);
      try {
        expect(() => canonicalJson?.(value)).toThrow(TypeError);
      } finally {
        Object.setPrototypeOf(value, originalPrototype);
      }
    } finally {
      if (descriptor !== undefined) {
        Object.defineProperty(WebAssembly, "Module", descriptor);
      }
      vi.resetModules();
    }
  });

  it("does not trust same-name borrowed native platform brand getters", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      WebAssembly.Memory.prototype,
      "buffer",
    );
    const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
    const typedArrayBufferDescriptor = Object.getOwnPropertyDescriptor(
      typedArrayPrototype,
      "buffer",
    );
    expect(descriptor).toBeDefined();
    expect(typedArrayBufferDescriptor).toBeDefined();

    Object.defineProperty(WebAssembly.Memory.prototype, "buffer", {
      get: typedArrayBufferDescriptor?.get,
      enumerable: true,
      configurable: true,
    });

    try {
      vi.resetModules();
      const { canonicalJson } = (await import("./index.js")) as Partial<
        CanonicalApi
      >;
      const value = new WebAssembly.Memory({ initial: 1 });
      const originalPrototype = Object.getPrototypeOf(value);
      Object.setPrototypeOf(value, Object.prototype);
      try {
        expect(() => canonicalJson?.(value)).toThrow(TypeError);
      } finally {
        Object.setPrototypeOf(value, originalPrototype);
      }
    } finally {
      if (descriptor !== undefined) {
        Object.defineProperty(WebAssembly.Memory.prototype, "buffer", descriptor);
      }
      vi.resetModules();
    }
  });

  it("does not invoke patched structuredClone for empty records", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "structuredClone",
    );
    expect(descriptor).toBeDefined();
    let calls = 0;
    Object.defineProperty(globalThis, "structuredClone", {
      value() {
        calls += 1;
        throw new Error("patched structuredClone");
      },
      enumerable: false,
      configurable: true,
      writable: true,
    });

    try {
      vi.resetModules();
      const { canonicalJson } = (await import("./index.js")) as Partial<
        CanonicalApi
      >;
      expect(canonicalJson?.({})).toBe("{}");
      expect(calls).toBe(0);
    } finally {
      if (descriptor !== undefined) {
        Object.defineProperty(globalThis, "structuredClone", descriptor);
      }
      vi.resetModules();
    }
  });

  it("does not invoke patched intrinsics after module load", async () => {
    vi.resetModules();
    const { canonicalJson, sha256Digest, sha256Hex } = (await import(
      "./index.js"
    )) as Partial<CanonicalApi>;
    const cryptoModule = await import("node:crypto");
    const { syncBuiltinESMExports } = await import("node:module");
    const { types: utilTypes } = await import("node:util");
    const defineProperty = Object.defineProperty;
    const cryptoDefault = cryptoModule.default;
    const expectedCanonical = '{"a":1,"b":"ok"}';
    const expectedHash = createHash("sha256")
      .update(expectedCanonical, "utf8")
      .digest("hex");
    const reflectApplyDescriptor = Object.getOwnPropertyDescriptor(
      Reflect,
      "apply",
    );
    const numberIsFiniteDescriptor = Object.getOwnPropertyDescriptor(
      Number,
      "isFinite",
    );
    const jsonStringifyDescriptor = Object.getOwnPropertyDescriptor(
      JSON,
      "stringify",
    );
    const functionToStringDescriptor = Object.getOwnPropertyDescriptor(
      Function.prototype,
      "toString",
    );
    const arrayIsArrayDescriptor = Object.getOwnPropertyDescriptor(
      Array,
      "isArray",
    );
    const arraySortDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      "sort",
    );
    const charCodeAtDescriptor = Object.getOwnPropertyDescriptor(
      String.prototype,
      "charCodeAt",
    );
    const arrayPushDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      "push",
    );
    const arrayJoinDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      "join",
    );
    const arrayIncludesDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      "includes",
    );
    const arrayIteratorDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      Symbol.iterator,
    );
    const regexpTestDescriptor = Object.getOwnPropertyDescriptor(
      RegExp.prototype,
      "test",
    );
    const regexpExecDescriptor = Object.getOwnPropertyDescriptor(
      RegExp.prototype,
      "exec",
    );
    const arrayBufferIsViewDescriptor = Object.getOwnPropertyDescriptor(
      ArrayBuffer,
      "isView",
    );
    const numberIsSafeIntegerDescriptor = Object.getOwnPropertyDescriptor(
      Number,
      "isSafeInteger",
    );
    const stringDescriptor = Object.getOwnPropertyDescriptor(globalThis, "String");
    const arrayDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Array");
    const objectDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Object");
    const numberDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Number");
    const weakSetDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WeakSet");
    const weakSetHasDescriptor = Object.getOwnPropertyDescriptor(
      WeakSet.prototype,
      "has",
    );
    const weakSetAddDescriptor = Object.getOwnPropertyDescriptor(
      WeakSet.prototype,
      "add",
    );
    const weakSetDeleteDescriptor = Object.getOwnPropertyDescriptor(
      WeakSet.prototype,
      "delete",
    );
    const objectSetPrototypeOfDescriptor = Object.getOwnPropertyDescriptor(
      Object,
      "setPrototypeOf",
    );
    const objectGetOwnPropertyDescriptorDescriptor =
      Object.getOwnPropertyDescriptor(Object, "getOwnPropertyDescriptor");
    const objectGetOwnPropertyNamesDescriptor = Object.getOwnPropertyDescriptor(
      Object,
      "getOwnPropertyNames",
    );
    const objectGetOwnPropertySymbolsDescriptor =
      Object.getOwnPropertyDescriptor(Object, "getOwnPropertySymbols");
    const objectGetPrototypeOfDescriptor = Object.getOwnPropertyDescriptor(
      Object,
      "getPrototypeOf",
    );
    const objectHasOwnDescriptor = Object.getOwnPropertyDescriptor(
      Object,
      "hasOwn",
    );
    const typeErrorNameDescriptor = Object.getOwnPropertyDescriptor(
      TypeError.prototype,
      "name",
    );
    const cryptoCreateHashDescriptor = Object.getOwnPropertyDescriptor(
      cryptoDefault,
      "createHash",
    );
    const hashPrototype = Object.getPrototypeOf(createHash("sha256"));
    const hashUpdateDescriptor = Object.getOwnPropertyDescriptor(
      hashPrototype,
      "update",
    );
    const hashDigestDescriptor = Object.getOwnPropertyDescriptor(
      hashPrototype,
      "digest",
    );
    const utilIsProxyDescriptor = Object.getOwnPropertyDescriptor(
      utilTypes,
      "isProxy",
    );
    const utilTypeNames = [
      "isDate",
      "isArgumentsObject",
      "isMap",
      "isSet",
      "isRegExp",
      "isNativeError",
      "isPromise",
      "isWeakMap",
      "isWeakSet",
      "isGeneratorObject",
      "isMapIterator",
      "isSetIterator",
      "isModuleNamespaceObject",
      "isExternal",
      "isKeyObject",
      "isCryptoKey",
      "isAnyArrayBuffer",
      "isBoxedPrimitive",
    ] as const;
    const utilTypeDescriptors = new Map<string, PropertyDescriptor | undefined>();
    for (const name of utilTypeNames) {
      utilTypeDescriptors.set(
        name,
        Object.getOwnPropertyDescriptor(utilTypes, name),
      );
    }
    const originalReflectApply = Reflect.apply;
    const originalNumberIsFinite = Number.isFinite;
    const originalNumberIsSafeInteger = Number.isSafeInteger;
    const originalJsonStringify = JSON.stringify;
    const originalFunctionToString = Function.prototype.toString;
    const originalString = String;
    const originalArray = Array;
    const originalObject = Object;
    const originalArrayIsArray = Array.isArray;
    const originalArraySort = Array.prototype.sort;
    const originalStringCharCodeAt = String.prototype.charCodeAt;
    const originalNumber = Number;
    const originalWeakSet = WeakSet;
    const originalWeakSetPrototype = WeakSet.prototype;
    const originalArrayPush = Array.prototype.push;
    const originalArrayJoin = Array.prototype.join;
    const originalArrayIncludes = Array.prototype.includes;
    const originalArrayIterator = Array.prototype[Symbol.iterator];
    const originalRegExpTest = RegExp.prototype.test;
    const originalRegExpExec = RegExp.prototype.exec;
    const originalArrayBufferIsView = ArrayBuffer.isView;
    const originalObjectSetPrototypeOf = Object.setPrototypeOf;
    const originalObjectGetOwnPropertyDescriptor =
      Object.getOwnPropertyDescriptor;
    const originalObjectGetOwnPropertyNames = Object.getOwnPropertyNames;
    const originalObjectGetOwnPropertySymbols = Object.getOwnPropertySymbols;
    const originalObjectGetPrototypeOf = Object.getPrototypeOf;
    const originalObjectHasOwn = Object.hasOwn;
    const originalCryptoCreateHash =
      cryptoDefault.createHash as (...args: unknown[]) => unknown;
    const originalHashUpdate = hashUpdateDescriptor?.value as
      | ((this: unknown, ...args: unknown[]) => unknown)
      | undefined;
    const originalHashDigest = hashDigestDescriptor?.value as
      | ((this: unknown, ...args: unknown[]) => unknown)
      | undefined;
    const nonFiniteValue = Number.NaN;
    let calls = 0;
    const count = () => {
      calls += 1;
    };

    Object.defineProperty(Reflect, "apply", {
      value(target: (...args: unknown[]) => unknown, receiver: unknown, args: unknown[]) {
        count();
        return originalReflectApply(target, receiver, args);
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(Number, "isFinite", {
      value(value: unknown) {
        count();
        return originalNumberIsFinite(value as number);
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(JSON, "stringify", {
      value(value: unknown) {
        count();
        return originalJsonStringify(value);
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(Function.prototype, "toString", {
      value(this: Function) {
        count();
        return originalFunctionToString.call(this);
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(Array, "isArray", {
      value(value: unknown) {
        count();
        return originalArrayIsArray(value);
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(Array.prototype, "sort", {
      value(this: unknown[]) {
        count();
        return originalArraySort.call(this);
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(String.prototype, "charCodeAt", {
      value(this: string, index: number) {
        count();
        return originalStringCharCodeAt.call(this, index);
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(Array.prototype, "push", {
      value(this: unknown[], ...items: unknown[]) {
        count();
        return originalArrayPush.apply(this, items);
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(Array.prototype, "join", {
      value(this: unknown[], separator?: string) {
        count();
        return originalArrayJoin.call(this, separator);
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(Array.prototype, "includes", {
      value(this: unknown[], value: unknown) {
        count();
        return originalArrayIncludes.call(this, value);
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(Array.prototype, Symbol.iterator, {
      value(this: unknown[]) {
        count();
        return originalArrayIterator.call(this);
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(RegExp.prototype, "test", {
      value(this: RegExp, value: string) {
        count();
        return originalRegExpTest.call(this, value);
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(RegExp.prototype, "exec", {
      value(this: RegExp, value: string) {
        count();
        return originalRegExpExec.call(this, value);
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(ArrayBuffer, "isView", {
      value(value: unknown) {
        count();
        return originalArrayBufferIsView(value);
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(Number, "isSafeInteger", {
      value(value: unknown) {
        count();
        return originalNumberIsSafeInteger(value as number);
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "String", {
      value: new Proxy(originalString, {
        apply(target, thisArg, args) {
          count();
          return originalReflectApply(target, thisArg, args);
        },
      }),
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "Array", {
      value: new Proxy(originalArray, {
        get(target, property, receiver) {
          if (property === "prototype") {
            count();
          }
          return Reflect.get(target, property, receiver);
        },
      }),
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "Number", {
      value(value: unknown) {
        count();
        return originalNumber(value);
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "WeakSet", {
      value: class PatchedWeakSet<T extends object> extends originalWeakSet<T> {
        constructor(values?: readonly T[] | null) {
          count();
          super(values);
        }
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(originalWeakSetPrototype, "has", {
      value(this: WeakSet<object>, value: object) {
        count();
        return weakSetHasDescriptor?.value.call(this, value);
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(originalWeakSetPrototype, "add", {
      value(this: WeakSet<object>, value: object) {
        count();
        return weakSetAddDescriptor?.value.call(this, value);
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(originalWeakSetPrototype, "delete", {
      value(this: WeakSet<object>, value: object) {
        count();
        return weakSetDeleteDescriptor?.value.call(this, value);
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(Object, "setPrototypeOf", {
      value(value: object, prototype: object | null) {
        count();
        return originalObjectSetPrototypeOf(value, prototype);
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(Object, "getOwnPropertyDescriptor", {
      value(value: object, property: PropertyKey) {
        count();
        return originalObjectGetOwnPropertyDescriptor(value, property);
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(Object, "getOwnPropertyNames", {
      value(value: object) {
        count();
        return originalObjectGetOwnPropertyNames(value);
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(Object, "getOwnPropertySymbols", {
      value(value: object) {
        count();
        return originalObjectGetOwnPropertySymbols(value);
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(Object, "getPrototypeOf", {
      value(value: object) {
        count();
        return originalObjectGetPrototypeOf(value);
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(Object, "hasOwn", {
      value(value: object, property: PropertyKey) {
        count();
        return originalObjectHasOwn(value, property);
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(cryptoDefault, "createHash", {
      value(...args: unknown[]) {
        count();
        return originalReflectApply(originalCryptoCreateHash, cryptoDefault, args);
      },
      configurable: true,
      writable: true,
    });
    syncBuiltinESMExports();
    if (originalHashUpdate !== undefined) {
      Object.defineProperty(hashPrototype, "update", {
        value(this: unknown, ...args: unknown[]) {
          count();
          return originalHashUpdate.apply(this, args);
        },
        configurable: true,
        writable: true,
      });
    }
    if (originalHashDigest !== undefined) {
      Object.defineProperty(hashPrototype, "digest", {
        value(this: unknown, ...args: unknown[]) {
          count();
          return originalHashDigest.apply(this, args);
        },
        configurable: true,
        writable: true,
      });
    }
    Object.defineProperty(utilTypes, "isProxy", {
      value(value: unknown) {
        count();
        return utilIsProxyDescriptor?.value(value);
      },
      configurable: true,
      writable: true,
    });
    for (const name of utilTypeNames) {
      const descriptor = utilTypeDescriptors.get(name);
      if (
        descriptor === undefined ||
        descriptor.configurable !== true ||
        typeof descriptor.value !== "function"
      ) {
        continue;
      }
      Object.defineProperty(utilTypes, name, {
        value(value: unknown) {
          count();
          return descriptor.value(value);
        },
        configurable: true,
        writable: true,
      });
    }
    Object.defineProperty(globalThis, "Object", {
      value: new Proxy(originalObject, {
        get(target, property, receiver) {
          if (property === "prototype") {
            count();
          }
          return Reflect.get(target, property, receiver);
        },
      }),
      configurable: true,
      writable: true,
    });

    let result: string | undefined;
    let arrayResult: string | undefined;
    let crossRealmResult: string | undefined;
    let hashResult: string | undefined;
    let digestResult: string | undefined;
    let rejectedNonFinite = false;
    let rejectedUndefined = false;
    let observedCalls = 0;

    try {
      calls = 0;
      result = canonicalJson?.({ b: "ok", a: 1 });
      arrayResult = canonicalJson?.([1]);
      crossRealmResult = canonicalJson?.(
        runInNewContext("({ b: 2, a: 1 })"),
      );
      hashResult = sha256Hex?.({ b: "ok", a: 1 });
      digestResult = sha256Digest?.({ b: "ok", a: 1 });
      try {
        canonicalJson?.(nonFiniteValue);
      } catch (error) {
        rejectedNonFinite = error instanceof TypeError;
      }
      Object.defineProperty(TypeError.prototype, "name", {
        configurable: true,
        get() {
          calls += 1;
          return "TypeError";
        },
        set() {
          calls += 1;
        },
      });
      try {
        canonicalJson?.(undefined);
      } catch (error) {
        rejectedUndefined = error instanceof TypeError;
      }
      observedCalls = calls;
    } finally {
      if (objectDescriptor !== undefined) {
        defineProperty(globalThis, "Object", objectDescriptor);
      }
      if (arrayDescriptor !== undefined) {
        defineProperty(globalThis, "Array", arrayDescriptor);
      }
      if (stringDescriptor !== undefined) {
        defineProperty(globalThis, "String", stringDescriptor);
      }
      if (numberDescriptor !== undefined) {
        Object.defineProperty(globalThis, "Number", numberDescriptor);
      }
      if (weakSetDescriptor !== undefined) {
        Object.defineProperty(globalThis, "WeakSet", weakSetDescriptor);
      }
      if (reflectApplyDescriptor !== undefined) {
        Object.defineProperty(Reflect, "apply", reflectApplyDescriptor);
      }
      if (numberIsFiniteDescriptor !== undefined) {
        Object.defineProperty(originalNumber, "isFinite", numberIsFiniteDescriptor);
      }
      if (jsonStringifyDescriptor !== undefined) {
        Object.defineProperty(JSON, "stringify", jsonStringifyDescriptor);
      }
      if (functionToStringDescriptor !== undefined) {
        Object.defineProperty(
          Function.prototype,
          "toString",
          functionToStringDescriptor,
        );
      }
      if (arrayIsArrayDescriptor !== undefined) {
        Object.defineProperty(originalArray, "isArray", arrayIsArrayDescriptor);
      }
      if (arraySortDescriptor !== undefined) {
        Object.defineProperty(Array.prototype, "sort", arraySortDescriptor);
      }
      if (charCodeAtDescriptor !== undefined) {
        Object.defineProperty(
          String.prototype,
          "charCodeAt",
          charCodeAtDescriptor,
        );
      }
      if (arrayPushDescriptor !== undefined) {
        Object.defineProperty(Array.prototype, "push", arrayPushDescriptor);
      }
      if (arrayJoinDescriptor !== undefined) {
        Object.defineProperty(Array.prototype, "join", arrayJoinDescriptor);
      }
      if (arrayIncludesDescriptor !== undefined) {
        Object.defineProperty(Array.prototype, "includes", arrayIncludesDescriptor);
      }
      if (arrayIteratorDescriptor !== undefined) {
        Object.defineProperty(
          Array.prototype,
          Symbol.iterator,
          arrayIteratorDescriptor,
        );
      }
      if (regexpTestDescriptor !== undefined) {
        Object.defineProperty(RegExp.prototype, "test", regexpTestDescriptor);
      }
      if (regexpExecDescriptor !== undefined) {
        Object.defineProperty(RegExp.prototype, "exec", regexpExecDescriptor);
      }
      if (arrayBufferIsViewDescriptor !== undefined) {
        Object.defineProperty(ArrayBuffer, "isView", arrayBufferIsViewDescriptor);
      }
      if (numberIsSafeIntegerDescriptor !== undefined) {
        Object.defineProperty(
          originalNumber,
          "isSafeInteger",
          numberIsSafeIntegerDescriptor,
        );
      }
      if (weakSetHasDescriptor !== undefined) {
        Object.defineProperty(originalWeakSetPrototype, "has", weakSetHasDescriptor);
      }
      if (weakSetAddDescriptor !== undefined) {
        Object.defineProperty(originalWeakSetPrototype, "add", weakSetAddDescriptor);
      }
      if (weakSetDeleteDescriptor !== undefined) {
        Object.defineProperty(originalWeakSetPrototype, "delete", weakSetDeleteDescriptor);
      }
      if (objectSetPrototypeOfDescriptor !== undefined) {
        Object.defineProperty(Object, "setPrototypeOf", objectSetPrototypeOfDescriptor);
      }
      if (objectGetOwnPropertyDescriptorDescriptor !== undefined) {
        Object.defineProperty(
          Object,
          "getOwnPropertyDescriptor",
          objectGetOwnPropertyDescriptorDescriptor,
        );
      }
      if (objectGetOwnPropertyNamesDescriptor !== undefined) {
        Object.defineProperty(
          Object,
          "getOwnPropertyNames",
          objectGetOwnPropertyNamesDescriptor,
        );
      }
      if (objectGetOwnPropertySymbolsDescriptor !== undefined) {
        Object.defineProperty(
          Object,
          "getOwnPropertySymbols",
          objectGetOwnPropertySymbolsDescriptor,
        );
      }
      if (objectGetPrototypeOfDescriptor !== undefined) {
        Object.defineProperty(
          Object,
          "getPrototypeOf",
          objectGetPrototypeOfDescriptor,
        );
      }
      if (objectHasOwnDescriptor !== undefined) {
        Object.defineProperty(Object, "hasOwn", objectHasOwnDescriptor);
      }
      if (typeErrorNameDescriptor !== undefined) {
        Object.defineProperty(
          TypeError.prototype,
          "name",
          typeErrorNameDescriptor,
        );
      } else {
        delete (TypeError.prototype as { name?: string }).name;
      }
      if (cryptoCreateHashDescriptor !== undefined) {
        defineProperty(cryptoDefault, "createHash", cryptoCreateHashDescriptor);
        syncBuiltinESMExports();
      }
      if (hashUpdateDescriptor !== undefined) {
        Object.defineProperty(hashPrototype, "update", hashUpdateDescriptor);
      }
      if (hashDigestDescriptor !== undefined) {
        Object.defineProperty(hashPrototype, "digest", hashDigestDescriptor);
      }
      if (utilIsProxyDescriptor !== undefined) {
        Object.defineProperty(utilTypes, "isProxy", utilIsProxyDescriptor);
      }
      for (const name of utilTypeNames) {
        const descriptor = utilTypeDescriptors.get(name);
        if (descriptor !== undefined) {
          Object.defineProperty(utilTypes, name, descriptor);
        }
      }
      vi.resetModules();
    }

    expect(result).toBe('{"a":1,"b":"ok"}');
    expect(arrayResult).toBe("[1]");
    expect(crossRealmResult).toBe('{"a":1,"b":2}');
    expect(hashResult).toBe(expectedHash);
    expect(digestResult).toBe(`sha256:${expectedHash}`);
    expect(rejectedNonFinite).toBe(true);
    expect(rejectedUndefined).toBe(true);
    expect(observedCalls).toBe(0);
  });

  it("does not let inherited array indexes affect canonical output", async () => {
    vi.resetModules();
    const { canonicalJson } = (await import("./index.js")) as Partial<
      CanonicalApi
    >;
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, "0");
    let calls = 0;
    let result: string | undefined;
    let observedCalls = 0;

    Object.defineProperty(Array.prototype, "0", {
      configurable: true,
      get() {
        calls += 1;
        return '"evil":0';
      },
      set() {
        calls += 1;
      },
    });

    try {
      calls = 0;
      result = canonicalJson?.({ a: 1 });
      observedCalls = calls;
    } finally {
      if (descriptor === undefined) {
        delete Array.prototype[0];
      } else {
        Object.defineProperty(Array.prototype, "0", descriptor);
      }
      vi.resetModules();
    }

    expect(result).toBe('{"a":1}');
    expect(observedCalls).toBe(0);
  });

  it("does not use inherited descriptor value properties", async () => {
    vi.resetModules();
    const { canonicalJson } = (await import("./index.js")) as Partial<
      CanonicalApi
    >;
    const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, "value");
    const objectWithGetter: Record<string, unknown> = {};
    const arrayWithGetter: unknown[] = [];
    let calls = 0;
    let rejectedObject = false;
    let rejectedArray = false;
    let observedCalls = 0;

    Object.defineProperty(objectWithGetter, "lazy", {
      enumerable: true,
      configurable: true,
      get() {
        return 1;
      },
    });
    Object.defineProperty(arrayWithGetter, "0", {
      enumerable: true,
      configurable: true,
      get() {
        return 1;
      },
    });
    Object.defineProperty(arrayWithGetter, "length", {
      value: 1,
      writable: true,
      configurable: false,
    });
    Object.defineProperty(Object.prototype, "value", {
      configurable: true,
      get() {
        calls += 1;
        return 123;
      },
    });

    try {
      calls = 0;
      try {
        canonicalJson?.(objectWithGetter);
      } catch (error) {
        rejectedObject = error instanceof TypeError;
      }
      try {
        canonicalJson?.(arrayWithGetter);
      } catch (error) {
        rejectedArray = error instanceof TypeError;
      }
      observedCalls = calls;
    } finally {
      if (descriptor === undefined) {
        delete (Object.prototype as { value?: unknown }).value;
      } else {
        Object.defineProperty(Object.prototype, "value", descriptor);
      }
      vi.resetModules();
    }

    expect(rejectedObject).toBe(true);
    expect(rejectedArray).toBe(true);
    expect(observedCalls).toBe(0);
  });

  it("rejects prototype constructor proxies without invoking traps", async () => {
    const { canonicalJson } = await loadCanonicalApi();
    let constructorTrapCalls = 0;
    const proxiedConstructor = new Proxy(function Object() {}, {
      get(target, property, receiver) {
        constructorTrapCalls += 1;
        return Reflect.get(target, property, receiver);
      },
      getOwnPropertyDescriptor(target, property) {
        constructorTrapCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });

    const prototype = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(prototype, "constructor", {
      value: proxiedConstructor,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    const value = Object.create(prototype) as Record<string, unknown>;
    value.visible = true;

    expect(() => canonicalJson?.(value)).toThrow(TypeError);
    expect(constructorTrapCalls).toBe(0);
  });

  it("rejects proxy containers without invoking traps", async () => {
    const { canonicalJson } = await loadCanonicalApi();
    let objectTrapCalls = 0;
    let arrayTrapCalls = 0;

    const proxyObject = new Proxy({ value: 1 } as Record<string, unknown>, {
      getPrototypeOf(target) {
        objectTrapCalls += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys(target) {
        objectTrapCalls += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, property) {
        objectTrapCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      get(target, property, receiver) {
        objectTrapCalls += 1;
        return Reflect.get(target, property, receiver);
      },
    });

    const proxyArray = new Proxy(["value"], {
      getPrototypeOf(target) {
        arrayTrapCalls += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys(target) {
        arrayTrapCalls += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, property) {
        arrayTrapCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      get(target, property, receiver) {
        arrayTrapCalls += 1;
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() => canonicalJson?.(proxyObject)).toThrow(TypeError);
    expect(() => canonicalJson?.(proxyArray)).toThrow(TypeError);
    expect(objectTrapCalls).toBe(0);
    expect(arrayTrapCalls).toBe(0);
  });

  it("rejects accessor properties without invoking them", async () => {
    const { canonicalJson } = await loadCanonicalApi();
    const objectWithGetter: Record<string, unknown> = {};
    let getterCalls = 0;
    Object.defineProperty(objectWithGetter, "value", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return "lazy";
      },
    });

    expect(() => canonicalJson?.(objectWithGetter)).toThrow(TypeError);
    expect(getterCalls).toBe(0);

    const arrayWithGetter: unknown[] = [];
    Object.defineProperty(arrayWithGetter, "0", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return "lazy-index";
      },
    });
    Object.defineProperty(arrayWithGetter, "length", {
      value: 1,
      writable: true,
      configurable: false,
    });
    expect(() => canonicalJson?.(arrayWithGetter)).toThrow(TypeError);
    expect(getterCalls).toBe(0);
  });

  it("rejects symbol keys", async () => {
    const { canonicalJson } = await loadCanonicalApi();
    const objectWithSymbolKey: Record<string, unknown> = { name: "ok" };
    Object.defineProperty(objectWithSymbolKey, Symbol("hidden"), {
      value: "boo",
      enumerable: true,
      configurable: true,
      writable: true,
    });

    expect(() => canonicalJson?.(objectWithSymbolKey)).toThrow(TypeError);

    const arrayWithSymbolKey = ["ok"];
    Object.defineProperty(arrayWithSymbolKey, Symbol("hidden"), {
      value: "boo",
      enumerable: true,
      configurable: true,
      writable: true,
    });

    expect(() => canonicalJson?.(arrayWithSymbolKey)).toThrow(TypeError);

    const objectWithHiddenSymbol: Record<string, unknown> = { name: "ok" };
    Object.defineProperty(objectWithHiddenSymbol, Symbol("hidden"), {
      value: "boo",
      enumerable: false,
      configurable: true,
      writable: true,
    });

    expect(() => canonicalJson?.(objectWithHiddenSymbol)).toThrow(TypeError);
  });

  it("rejects non-enumerable own properties without invoking getters", async () => {
    const { canonicalJson } = await loadCanonicalApi();
    const objectWithHiddenValue: Record<string, unknown> = { visible: 1 };
    Object.defineProperty(objectWithHiddenValue, "hidden", {
      value: "boo",
      enumerable: false,
      configurable: true,
      writable: true,
    });

    expect(() => canonicalJson?.(objectWithHiddenValue)).toThrow(TypeError);

    const objectWithHiddenGetter: Record<string, unknown> = { visible: 1 };
    let hiddenGetterCalls = 0;
    Object.defineProperty(objectWithHiddenGetter, "hidden", {
      enumerable: false,
      configurable: true,
      get() {
        hiddenGetterCalls += 1;
        return "boo";
      },
    });

    expect(() => canonicalJson?.(objectWithHiddenGetter)).toThrow(TypeError);
    expect(hiddenGetterCalls).toBe(0);
  });

  it("rejects non-enumerable array indexes", async () => {
    const { canonicalJson } = await loadCanonicalApi();
    const arrayWithHiddenIndex = ["visible"];
    Object.defineProperty(arrayWithHiddenIndex, "0", {
      value: "hidden",
      enumerable: false,
      configurable: true,
      writable: true,
    });

    expect(() => canonicalJson?.(arrayWithHiddenIndex)).toThrow(TypeError);
  });

  it("rejects arrays with extra own properties", async () => {
    const { canonicalJson } = await loadCanonicalApi();
    const arrayWithExtraProperty = ["visible"] as string[] & { extra?: string };
    arrayWithExtraProperty.extra = "metadata";

    expect(() => canonicalJson?.(arrayWithExtraProperty)).toThrow(TypeError);
  });
});
