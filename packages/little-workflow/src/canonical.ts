import { createHash, subtle, webcrypto } from "node:crypto";
import nodeProcess from "node:process";
import { types as utilTypes } from "node:util";

const createHashFn = createHash;
const functionToString = Function.prototype.toString;
const arrayCtor = Array;
const arrayIsArray = Array.isArray;
const arrayBufferIsView = ArrayBuffer.isView;
const arrayIncludes = Array.prototype.includes;
const arrayPrototype = Array.prototype;
const arraySort = Array.prototype.sort;
const jsonStringify = JSON.stringify;
const numberCtor = Number;
const numberIsFinite = Number.isFinite;
const numberIsSafeInteger = Number.isSafeInteger;
const objectCtor = Object;
const objectDefineProperty = Object.defineProperty;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetOwnPropertyNames = Object.getOwnPropertyNames;
const objectGetOwnPropertySymbols = Object.getOwnPropertySymbols;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.hasOwn;
const objectPrototype = Object.prototype;
const objectSetPrototypeOf = Object.setPrototypeOf;
const reflectApply = Reflect.apply;
const reflectConstruct = Reflect.construct;
const stringCtor = String;
const stringCharCodeAt = String.prototype.charCodeAt;
const stringFromCharCode = String.fromCharCode;
const symbolIterator = Symbol.iterator;
const uint8ArrayCtor = Uint8Array;
const weakSetCtor = WeakSet;
const weakSetAdd = WeakSet.prototype.add;
const weakSetDelete = WeakSet.prototype.delete;
const weakSetHas = WeakSet.prototype.has;
const utilIsAnyArrayBuffer = utilTypes.isAnyArrayBuffer;
const utilIsArgumentsObject = utilTypes.isArgumentsObject;
const utilIsBoxedPrimitive = utilTypes.isBoxedPrimitive;
const utilIsCryptoKey = utilTypes.isCryptoKey;
const utilIsDate = utilTypes.isDate;
const utilIsExternal = utilTypes.isExternal;
const utilIsGeneratorObject = utilTypes.isGeneratorObject;
const utilIsKeyObject = utilTypes.isKeyObject;
const utilIsMap = utilTypes.isMap;
const utilIsMapIterator = utilTypes.isMapIterator;
const utilIsModuleNamespaceObject = utilTypes.isModuleNamespaceObject;
const utilIsNativeError = utilTypes.isNativeError;
const utilIsPromise = utilTypes.isPromise;
const utilIsProxy = utilTypes.isProxy;
const utilIsRegExp = utilTypes.isRegExp;
const utilIsSet = utilTypes.isSet;
const utilIsSetIterator = utilTypes.isSetIterator;
const utilIsWeakMap = utilTypes.isWeakMap;
const utilIsWeakSet = utilTypes.isWeakSet;
type Hash = ReturnType<typeof createHashFn>;
type HashUpdate = (this: Hash, data: string, inputEncoding: BufferEncoding) => Hash;
type HashDigest = (this: Hash, encoding: "hex") => string;
const hashPrototype = objectGetPrototypeOf(createHashFn("sha256"));
const hashUpdate = objectGetOwnPropertyDescriptor(hashPrototype, "update")
  ?.value as HashUpdate;
const hashDigest = objectGetOwnPropertyDescriptor(hashPrototype, "digest")
  ?.value as HashDigest;
const nativeConstructorSources = {
  Array: reflectApply(functionToString, arrayCtor, []),
  Object: reflectApply(functionToString, objectCtor, []),
} as const;
const finalizationRegistryProbeToken = {};
const processObject = nodeProcess as unknown;
const platformBrandRegistry = createPlatformBrandChecks();
const platformBrandChecks = platformBrandRegistry.checks;
const platformBrandProbesCompromised = platformBrandRegistry.compromised;
const platformSingletons = createPlatformSingletons();

type NonHashableErrorOptions = {
  readonly value?: unknown;
  readonly path: string;
};

type PlainRecord = Record<string, unknown>;

class NonHashableValueError extends TypeError {
  readonly value?: unknown;
  readonly path: string;

  constructor(message: string, options: NonHashableErrorOptions) {
    super(message, { cause: { path: options.path } });
    reflectApply(objectDefineProperty, objectCtor, [
      this,
      "name",
      {
        configurable: true,
        enumerable: false,
        value: "NonHashableValueError",
        writable: true,
      },
    ]);
    this.value = options.value;
    this.path = options.path;
    objectSetPrototypeOf(this, new.target.prototype);
  }
}

export function canonicalJson(value: unknown): string {
  return serialize(value, "$", new weakSetCtor<object>());
}

export function sha256Hex(value: unknown): string {
  const hash = createHashFn("sha256");
  reflectApply(hashUpdate, hash, [canonicalJson(value), "utf8"]);
  return reflectApply(hashDigest, hash, ["hex"]);
}

export function sha256Digest(value: unknown): string {
  return `sha256:${sha256Hex(value)}`;
}

function serialize(value: unknown, path: string, seen: WeakSet<object>): string {
  if (value === null) {
    return "null";
  }

  const type = typeof value;

  if (type === "boolean") {
    return value === true ? "true" : "false";
  }

  if (type === "string") {
    const stringValue = value as string;
    validateWellFormedString(stringValue, path);
    return jsonStringify(stringValue);
  }

  if (type === "number") {
    if (!numberIsFinite(value)) {
      throw nonHashable("Non-finite numbers are not hashable.", value, path);
    }
    return jsonStringify(value);
  }

  if (type === "undefined") {
    throw nonHashable("undefined is not hashable.", value, path);
  }

  if (type === "bigint") {
    throw nonHashable("bigint values are not hashable.", value, path);
  }

  if (type === "function") {
    throw nonHashable("Functions are not hashable.", value, path);
  }

  if (type === "symbol") {
    throw nonHashable("Symbols are not hashable.", value, path);
  }

  const object = value as object;

  if (utilIsProxy(object)) {
    throw nonHashable("Proxy objects are not hashable.", value, path);
  }

  if (isBrandedExoticObject(object)) {
    throw nonHashable("Built-in exotic objects are not hashable.", value, path);
  }

  if (reflectApply(weakSetHas, seen, [object])) {
    throw nonHashable("Cyclic references are not hashable.", value, path);
  }

  if (arrayIsArray(value)) {
    if (!isPlainArray(value)) {
      throw nonHashable(
        "Array subclasses and non-plain arrays are not hashable.",
        value,
        path,
      );
    }
    reflectApply(weakSetAdd, seen, [object]);
    validateArrayShape(value, path);
    let result = "[";
    for (let index = 0; index < value.length; index += 1) {
      const itemPath = `${path}[${index}]`;
      const descriptor = objectGetOwnPropertyDescriptor(value, stringCtor(index));
      if (descriptor === undefined) {
        throw nonHashable("Sparse arrays are not hashable.", value, itemPath);
      }
      if (!objectHasOwn(descriptor, "value")) {
        throw nonHashable("Accessors are not hashable.", value, itemPath);
      }
      if (!descriptor.enumerable) {
        throw nonHashable("Non-enumerable array indexes are not hashable.", value, itemPath);
      }
      if (index > 0) {
        result += ",";
      }
      result += serialize(descriptor.value, itemPath, seen);
    }
    reflectApply(weakSetDelete, seen, [object]);
    return `${result}]`;
  }

  if (!isPlainRecord(value)) {
    throw nonHashable(
      "Class instances and non-plain objects are not hashable.",
      value,
      path,
    );
  }

  reflectApply(weakSetAdd, seen, [object]);

  const symbolKeys = objectGetOwnPropertySymbols(value);
  for (let index = 0; index < symbolKeys.length; index += 1) {
    const symbolKey = symbolKeys[index];
    if (symbolKey === undefined) {
      continue;
    }
    if (objectHasOwn(value, symbolKey)) {
      throw nonHashable("Symbol keys are not hashable.", value, path);
    }
  }

  const keys = reflectApply(arraySort, objectGetOwnPropertyNames(value), []);
  let result = "{";
  let resultParts = 0;

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) {
      continue;
    }
    const propertyPath = pathForKey(path, key);
    validateWellFormedString(key, propertyPath);
    const descriptor = objectGetOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      continue;
    }
    if (!objectHasOwn(descriptor, "value")) {
      throw nonHashable("Accessors are not hashable.", value, propertyPath);
    }
    if (!descriptor.enumerable) {
      throw nonHashable(
        "Non-enumerable properties are not hashable.",
        value,
        propertyPath,
      );
    }
    if (resultParts > 0) {
      result += ",";
    }
    result += `${jsonStringify(key)}:${serialize(descriptor.value, propertyPath, seen)}`;
    resultParts += 1;
  }

  reflectApply(weakSetDelete, seen, [object]);
  return `${result}}`;
}

function validateArrayShape(value: readonly unknown[], path: string): void {
  const symbolKeys = objectGetOwnPropertySymbols(value);
  for (let index = 0; index < symbolKeys.length; index += 1) {
    const symbolKey = symbolKeys[index];
    if (symbolKey === undefined) {
      continue;
    }
    const descriptor = objectGetOwnPropertyDescriptor(value, symbolKey);
    if (descriptor !== undefined) {
      throw nonHashable("Symbol keys are not hashable.", value, path);
    }
  }

  const keys = objectGetOwnPropertyNames(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) {
      continue;
    }
    if (key === "length" || isCanonicalArrayIndex(key, value.length)) {
      continue;
    }
    throw nonHashable(
      "Arrays must not contain extra own properties.",
      value,
      pathForKey(path, key),
    );
  }
}

function isBrandedExoticObject(value: object): boolean {
  return (
    platformBrandProbesCompromised ||
    reflectApply(arrayIncludes, platformSingletons, [value]) ||
    isCurrentProcessEnv(value) ||
    utilIsDate(value) ||
    utilIsArgumentsObject(value) ||
    utilIsMap(value) ||
    utilIsSet(value) ||
    utilIsRegExp(value) ||
    utilIsNativeError(value) ||
    utilIsPromise(value) ||
    utilIsWeakMap(value) ||
    utilIsWeakSet(value) ||
    utilIsGeneratorObject(value) ||
    utilIsMapIterator(value) ||
    utilIsSetIterator(value) ||
    utilIsModuleNamespaceObject(value) ||
    utilIsExternal(value) ||
    utilIsKeyObject(value) ||
    utilIsCryptoKey(value) ||
    utilIsAnyArrayBuffer(value) ||
    utilIsBoxedPrimitive(value) ||
    arrayBufferIsView(value) ||
    matchesPlatformBrand(value)
  );
}

type BrandCheck = (value: object) => unknown;
type PlatformBrandRegistry = {
  readonly checks: readonly BrandCheck[];
  readonly compromised: boolean;
};

function createPlatformSingletons(): readonly object[] {
  const singletons: object[] = [];
  const globalScope = globalThis as unknown as Record<string, unknown>;
  pushObject(singletons, webcrypto);
  pushObject(singletons, subtle);
  // Accessor-backed globals are not read here. In Node, `webcrypto` and
  // `subtle` are accessor-free handles to `globalThis.crypto` and
  // `crypto.subtle`; `navigator` has no equivalent public source, so forged
  // Navigator singletons are residual risk.
  pushDataPropertyObject(singletons, globalScope, "navigator");
  pushDataPropertyObject(singletons, globalScope, "crypto");

  if (typeof processObject === "object" && processObject !== null) {
    const envDescriptor = objectGetOwnPropertyDescriptor(processObject, "env");
    if (envDescriptor !== undefined && objectHasOwn(envDescriptor, "value")) {
      pushObject(singletons, envDescriptor.value);
    }
  }

  const cryptoDescriptor = objectGetOwnPropertyDescriptor(globalScope, "crypto");
  if (
    cryptoDescriptor !== undefined &&
    objectHasOwn(cryptoDescriptor, "value") &&
    typeof cryptoDescriptor.value === "object" &&
    cryptoDescriptor.value !== null
  ) {
    pushDataPropertyObject(
      singletons,
      cryptoDescriptor.value as Record<string, unknown>,
      "subtle",
    );
  }

  return singletons;
}

function pushObject(values: object[], value: unknown): void {
  if (typeof value === "object" && value !== null) {
    setArrayIndex(values, values.length, value);
  }
}

function pushDataPropertyObject(
  values: object[],
  object: Record<string, unknown>,
  property: string,
): void {
  const descriptor = objectGetOwnPropertyDescriptor(object, property);
  if (descriptor !== undefined && objectHasOwn(descriptor, "value")) {
    pushObject(values, descriptor.value);
  }
}

function isCurrentProcessEnv(value: object): boolean {
  if (typeof processObject !== "object" || processObject === null) {
    return false;
  }

  const descriptor = objectGetOwnPropertyDescriptor(processObject, "env");
  return (
    descriptor !== undefined &&
    objectHasOwn(descriptor, "value") &&
    descriptor.value === value
  );
}

function createPlatformBrandChecks(): PlatformBrandRegistry {
  const checks: BrandCheck[] = [];
  let compromised = false;
  const markCompromised = () => {
    compromised = true;
  };
  const globalScope = globalThis as unknown as Record<string, unknown>;
  const intlValue = ownDataPropertyValue(globalScope, "Intl");
  if (intlValue === undefined && hasOwnProperty(globalScope, "Intl")) {
    markCompromised();
  }
  const intlScope =
    typeof intlValue === "object" && intlValue !== null
      ? (intlValue as Record<string, unknown>)
      : {};
  const webAssemblyValue = ownDataPropertyValue(globalScope, "WebAssembly");
  if (
    webAssemblyValue === undefined &&
    hasOwnProperty(globalScope, "WebAssembly")
  ) {
    markCompromised();
  }
  const webAssemblyScope =
    typeof webAssemblyValue === "object" && webAssemblyValue !== null
      ? (webAssemblyValue as Record<string, unknown>)
      : {};
  const wasmSampleModule = createWasmSampleModule(webAssemblyScope);
  if (
    hasOwnProperty(webAssemblyScope, "Module") &&
    wasmSampleModule === undefined
  ) {
    markCompromised();
  }

  addPrototypeMethod(
    checks,
    markCompromised,
    globalScope,
    "WeakRef",
    "deref",
    [],
    [{}],
  );
  addPrototypeMethod(
    checks,
    markCompromised,
    globalScope,
    "FinalizationRegistry",
    "unregister",
    [finalizationRegistryProbeToken],
    [() => ""],
  );
  addPrototypeMethod(
    checks,
    markCompromised,
    globalScope,
    "URLPattern",
    "test",
    ["https://example.com/"],
    ["https://example.com/:path*"],
  );

  addPrototypeMethod(
    checks,
    markCompromised,
    intlScope,
    "DateTimeFormat",
    "resolvedOptions",
    [],
    ["en-US"],
  );
  addPrototypeMethod(
    checks,
    markCompromised,
    intlScope,
    "NumberFormat",
    "resolvedOptions",
    [],
    ["en-US"],
  );
  addPrototypeMethod(
    checks,
    markCompromised,
    intlScope,
    "Collator",
    "resolvedOptions",
    [],
    ["en-US"],
  );
  addPrototypeMethod(
    checks,
    markCompromised,
    intlScope,
    "DurationFormat",
    "resolvedOptions",
    [],
    ["en-US"],
  );
  addPrototypeMethod(
    checks,
    markCompromised,
    intlScope,
    "PluralRules",
    "resolvedOptions",
    [],
    ["en-US"],
  );
  addPrototypeMethod(
    checks,
    markCompromised,
    intlScope,
    "RelativeTimeFormat",
    "resolvedOptions",
    [],
    ["en-US"],
  );
  addPrototypeMethod(
    checks,
    markCompromised,
    intlScope,
    "ListFormat",
    "resolvedOptions",
    [],
    ["en-US"],
  );
  addPrototypeMethod(
    checks,
    markCompromised,
    intlScope,
    "Segmenter",
    "resolvedOptions",
    [],
    ["en-US"],
  );
  addPrototypeMethod(
    checks,
    markCompromised,
    intlScope,
    "DisplayNames",
    "resolvedOptions",
    [],
    ["en-US", { type: "language" }],
  );
  addPrototypeMethod(
    checks,
    markCompromised,
    intlScope,
    "Locale",
    "toString",
    [],
    ["en-US"],
  );

  addPrototypeGetter(
    checks,
    markCompromised,
    globalScope,
    "Navigator",
    "userAgent",
  );
  addPrototypeGetter(checks, markCompromised, globalScope, "Crypto", "subtle");
  addPrototypeGetter(
    checks,
    markCompromised,
    globalScope,
    "AbortController",
    "signal",
  );
  addPrototypeGetter(
    checks,
    markCompromised,
    globalScope,
    "AbortSignal",
    "aborted",
  );
  addPrototypeGetter(checks, markCompromised, globalScope, "Blob", "size");
  addPrototypeGetter(checks, markCompromised, globalScope, "Request", "url");
  addPrototypeGetter(checks, markCompromised, globalScope, "Response", "status");
  addPrototypeGetter(
    checks,
    markCompromised,
    globalScope,
    "ReadableStream",
    "locked",
  );
  addPrototypeGetter(
    checks,
    markCompromised,
    globalScope,
    "WritableStream",
    "locked",
  );
  addPrototypeGetter(
    checks,
    markCompromised,
    globalScope,
    "TransformStream",
    "readable",
  );
  addPrototypeGetter(
    checks,
    markCompromised,
    globalScope,
    "CompressionStream",
    "readable",
  );
  addPrototypeGetter(
    checks,
    markCompromised,
    globalScope,
    "DecompressionStream",
    "readable",
  );
  addPrototypeGetter(
    checks,
    markCompromised,
    globalScope,
    "TextEncoderStream",
    "readable",
  );
  addPrototypeGetter(
    checks,
    markCompromised,
    globalScope,
    "TextDecoderStream",
    "readable",
  );
  addPrototypeGetter(
    checks,
    markCompromised,
    globalScope,
    "ByteLengthQueuingStrategy",
    "highWaterMark",
  );
  addPrototypeGetter(
    checks,
    markCompromised,
    globalScope,
    "CountQueuingStrategy",
    "highWaterMark",
  );
  addPrototypeSymbolMethod(
    checks,
    globalScope,
    "PerformanceObserver",
    Symbol.for("nodejs.util.inspect.custom"),
    [0, {}, () => ""],
  );

  addStaticMethod(
    checks,
    markCompromised,
    webAssemblyScope,
    "Module",
    "exports",
  );
  if (wasmSampleModule !== undefined) {
    addPrototypeGetter(
      checks,
      markCompromised,
      webAssemblyScope,
      "Instance",
      "exports",
      [wasmSampleModule],
    );
  }
  addPrototypeGetter(
    checks,
    markCompromised,
    webAssemblyScope,
    "Memory",
    "buffer",
    [{ initial: 1 }],
  );
  addPrototypeGetter(
    checks,
    markCompromised,
    webAssemblyScope,
    "Table",
    "length",
    [{ element: "anyfunc", initial: 1 }],
  );
  addPrototypeGetter(
    checks,
    markCompromised,
    webAssemblyScope,
    "Global",
    "value",
    [{ mutable: true, value: "i32" }, 0],
  );

  // Iterator exotics are intentionally omitted: their native `next` brand checks
  // mutate caller-provided iterators, which would make rejection observable.
  return { checks, compromised };
}

function createWasmSampleModule(
  webAssemblyScope: Record<string, unknown>,
): object | undefined {
  const moduleConstructor = ownDataPropertyValue(webAssemblyScope, "Module");
  if (!isTrustedBrandProbe(moduleConstructor, "Module")) {
    return undefined;
  }

  try {
    const bytes = reflectApply(reflectConstruct, Reflect, [
      uint8ArrayCtor,
      [[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]],
    ]);
    const module = reflectApply(reflectConstruct, Reflect, [
      moduleConstructor,
      [bytes],
    ]);
    return typeof module === "object" && module !== null ? module : undefined;
  } catch {
    return undefined;
  }
}

function addPrototypeMethod(
  checks: BrandCheck[],
  markCompromised: () => void,
  scope: Record<string, unknown>,
  constructorName: string,
  methodName: string,
  args: readonly unknown[] = [],
  sampleConstructorArgs?: readonly unknown[],
): void {
  const prototype = prototypeFor(scope, constructorName);
  if (prototype === undefined) {
    if (
      sampleConstructorArgs !== undefined &&
      hasOwnProperty(scope, constructorName)
    ) {
      markCompromised();
    }
    return;
  }

  const descriptor = objectGetOwnPropertyDescriptor(prototype, methodName);
  if (descriptor === undefined || !objectHasOwn(descriptor, "value")) {
    if (sampleConstructorArgs !== undefined) {
      markCompromised();
    }
    return;
  }

  const method = descriptor.value;
  if (
    !isTrustedBrandProbe(method, methodName) ||
    !rejectsPoisonedPrototypeReceiver(method, args)
  ) {
    if (sampleConstructorArgs !== undefined) {
      markCompromised();
    }
    return;
  }

  if (
    sampleConstructorArgs !== undefined &&
    !acceptsSamplePrototypeReceiver(
      scope,
      constructorName,
      method,
      args,
      sampleConstructorArgs,
    )
  ) {
    markCompromised();
    return;
  }

  setArrayIndex(checks, checks.length, (value: object) =>
    reflectApply(method, value, args),
  );
}

function acceptsSamplePrototypeReceiver(
  scope: Record<string, unknown>,
  constructorName: string,
  method: Function,
  args: readonly unknown[],
  sampleConstructorArgs: readonly unknown[],
): boolean {
  const sample = constructSample(scope, constructorName, sampleConstructorArgs);
  if (sample === undefined) {
    return false;
  }

  try {
    reflectApply(method, sample, args);
    return true;
  } catch {
    return false;
  }
}

function constructSample(
  scope: Record<string, unknown>,
  constructorName: string,
  args: readonly unknown[],
): object | undefined {
  const constructor = ownDataPropertyValue(scope, constructorName);
  if (!isTrustedBrandProbe(constructor, constructorName)) {
    return undefined;
  }

  try {
    const sample = reflectApply(reflectConstruct, Reflect, [constructor, args]);
    return typeof sample === "object" && sample !== null ? sample : undefined;
  } catch {
    return undefined;
  }
}

function addStaticMethod(
  checks: BrandCheck[],
  markCompromised: () => void,
  scope: Record<string, unknown>,
  constructorName: string,
  methodName: string,
  args: readonly unknown[] = [],
): void {
  const constructor = ownDataPropertyValue(scope, constructorName);
  if (!isTrustedBrandProbe(constructor, constructorName)) {
    if (hasOwnProperty(scope, constructorName)) {
      markCompromised();
    }
    return;
  }

  const descriptor = objectGetOwnPropertyDescriptor(constructor, methodName);
  if (descriptor === undefined || !objectHasOwn(descriptor, "value")) {
    markCompromised();
    return;
  }

  const method = descriptor.value;
  if (
    !isTrustedBrandProbe(method, methodName) ||
    !rejectsPoisonedStaticArgument(method, constructor, args)
  ) {
    markCompromised();
    return;
  }

  setArrayIndex(
    checks,
    checks.length,
    (value: object) =>
      reflectApply(method, constructor, prependArgument(value, args)),
  );
}

function addPrototypeSymbolMethod(
  checks: BrandCheck[],
  scope: Record<string, unknown>,
  constructorName: string,
  methodName: symbol,
  args: readonly unknown[] = [],
): void {
  const prototype = prototypeFor(scope, constructorName);
  if (prototype === undefined) {
    return;
  }

  const descriptor = objectGetOwnPropertyDescriptor(prototype, methodName);
  if (descriptor === undefined || !objectHasOwn(descriptor, "value")) {
    return;
  }

  const method = descriptor.value;
  if (
    !isTrustedBrandProbe(method) ||
    !rejectsPoisonedPrototypeReceiver(method, args)
  ) {
    return;
  }

  setArrayIndex(checks, checks.length, (value: object) =>
    reflectApply(method, value, args),
  );
}

function addPrototypeGetter(
  checks: BrandCheck[],
  markCompromised: () => void,
  scope: Record<string, unknown>,
  constructorName: string,
  propertyName: string,
  sampleConstructorArgs?: readonly unknown[],
): void {
  const prototype = prototypeFor(scope, constructorName);
  if (prototype === undefined) {
    if (
      sampleConstructorArgs !== undefined &&
      hasOwnProperty(scope, constructorName)
    ) {
      markCompromised();
    }
    return;
  }

  const descriptor = objectGetOwnPropertyDescriptor(prototype, propertyName);
  if (
    descriptor === undefined ||
    !objectHasOwn(descriptor, "get") ||
    typeof descriptor.get !== "function"
  ) {
    if (sampleConstructorArgs !== undefined) {
      markCompromised();
    }
    return;
  }

  const getter = descriptor.get;
  if (
    !isTrustedBrandProbe(getter, `get ${propertyName}`) ||
    !rejectsPoisonedPrototypeReceiver(getter, [])
  ) {
    if (sampleConstructorArgs !== undefined) {
      markCompromised();
    }
    return;
  }

  if (
    sampleConstructorArgs !== undefined &&
    !acceptsSamplePrototypeReceiver(
      scope,
      constructorName,
      getter,
      [],
      sampleConstructorArgs,
    )
  ) {
    markCompromised();
    return;
  }

  setArrayIndex(checks, checks.length, (value: object) =>
    reflectApply(getter, value, []),
  );
}

function setArrayIndex<T>(values: T[], index: number, value: T): void {
  reflectApply(objectDefineProperty, objectCtor, [
    values,
    stringCtor(index),
    {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    },
  ]);
}

function prependArgument(value: object, args: readonly unknown[]): unknown[] {
  const nextArgs: unknown[] = [];
  setArrayIndex(nextArgs, 0, value);
  for (let index = 0; index < args.length; index += 1) {
    setArrayIndex(nextArgs, index + 1, args[index]);
  }
  return nextArgs;
}

function prototypeFor(
  scope: Record<string, unknown>,
  constructorName: string,
): object | undefined {
  const constructor = ownDataPropertyValue(scope, constructorName);
  if (!isTrustedBrandProbe(constructor, constructorName)) {
    return undefined;
  }

  const descriptor = objectGetOwnPropertyDescriptor(constructor, "prototype");
  if (descriptor === undefined || !objectHasOwn(descriptor, "value")) {
    return undefined;
  }

  return typeof descriptor.value === "object" && descriptor.value !== null
    ? descriptor.value
    : undefined;
}

function ownDataPropertyValue(
  scope: Record<string, unknown>,
  property: string,
): unknown {
  const descriptor = objectGetOwnPropertyDescriptor(scope, property);
  return descriptor !== undefined && objectHasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
}

function hasOwnProperty(
  scope: Record<string, unknown>,
  property: string,
): boolean {
  return objectGetOwnPropertyDescriptor(scope, property) !== undefined;
}

function isTrustedBrandProbe(
  value: unknown,
  expectedName?: string,
): value is Function {
  if (typeof value !== "function" || utilIsProxy(value)) {
    return false;
  }

  const source = reflectApply(functionToString, value, []);
  const name = nativeFunctionName(source);
  return (
    name !== undefined && (expectedName === undefined || name === expectedName)
  );
}

function nativeFunctionName(source: string): string | undefined {
  let index = 0;
  if (!hasLiteralAt(source, index, "function")) {
    return undefined;
  }
  index += "function".length;
  if (reflectApply(stringCharCodeAt, source, [index]) !== 0x20) {
    return undefined;
  }
  index += 1;
  let prefix = "";
  if (hasLiteralAt(source, index, "get ")) {
    prefix = "get ";
    index += "get ".length;
  } else if (hasLiteralAt(source, index, "set ")) {
    prefix = "set ";
    index += "set ".length;
  }

  const nameStart = index;
  while (index < source.length) {
    const codeUnit = reflectApply(stringCharCodeAt, source, [index]);
    if (!isAsciiIdentifierPart(codeUnit)) {
      break;
    }
    index += 1;
  }

  if (index === nameStart) {
    return undefined;
  }
  const name = sliceAscii(source, nameStart, index);

  if (reflectApply(stringCharCodeAt, source, [index]) !== 0x28) {
    return undefined;
  }

  while (index < source.length) {
    const codeUnit = reflectApply(stringCharCodeAt, source, [index]);
    if (codeUnit === 0x29) {
      break;
    }
    index += 1;
  }

  return hasLiteralAt(source, index, ") { [native code] }")
    ? `${prefix}${name}`
    : undefined;
}

function rejectsPoisonedPrototypeReceiver(
  method: Function,
  args: readonly unknown[],
): boolean {
  const sentinel = createPoisonedBrandProbeSentinel();
  try {
    reflectApply(method, sentinel.value, args);
    return false;
  } catch {
    return !sentinel.wasTouched();
  }
}

function rejectsPoisonedStaticArgument(
  method: Function,
  receiver: Function,
  args: readonly unknown[],
): boolean {
  const sentinel = createPoisonedBrandProbeSentinel();
  try {
    reflectApply(method, receiver, prependArgument(sentinel.value, args));
    return false;
  } catch {
    return !sentinel.wasTouched();
  }
}

function createPoisonedBrandProbeSentinel(): {
  readonly value: object;
  readonly wasTouched: () => boolean;
} {
  let touched = false;
  const sentinel = {};
  const touch = () => {
    touched = true;
    return undefined;
  };
  reflectApply(objectDefineProperty, objectCtor, [
    sentinel,
    "length",
    { configurable: true, get: touch },
  ]);
  reflectApply(objectDefineProperty, objectCtor, [
    sentinel,
    "exec",
    {
      configurable: true,
      get() {
        touched = true;
        return () => null;
      },
    },
  ]);
  reflectApply(objectDefineProperty, objectCtor, [
    sentinel,
    "0",
    { configurable: true, get: touch },
  ]);
  reflectApply(objectDefineProperty, objectCtor, [
    sentinel,
    symbolIterator,
    { configurable: true, get: touch },
  ]);

  return {
    value: sentinel,
    wasTouched: () => touched,
  };
}

function matchesPlatformBrand(value: object): boolean {
  for (let index = 0; index < platformBrandChecks.length; index += 1) {
    const check = platformBrandChecks[index];
    if (check === undefined) {
      continue;
    }
    try {
      check(value);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

function isPlainArray(value: readonly unknown[]): boolean {
  const prototype = objectGetPrototypeOf(value);
  return prototype === arrayPrototype || isRealmArrayPrototype(prototype);
}

function isPlainRecord(value: unknown): value is PlainRecord {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const prototype = objectGetPrototypeOf(value);
  return (
    prototype === objectPrototype ||
    prototype === null ||
    isRealmObjectPrototype(prototype)
  );
}

function isRealmArrayPrototype(value: object | null): boolean {
  if (value === null || utilIsProxy(value) || !arrayIsArray(value)) {
    return false;
  }

  const objectPrototype = objectGetPrototypeOf(value);
  const constructorDescriptor = objectGetOwnPropertyDescriptor(
    value,
    "constructor",
  );
  return (
    isRealmObjectPrototype(objectPrototype) &&
    isNativeConstructorForPrototype(constructorDescriptor, "Array", value)
  );
}

function isRealmObjectPrototype(value: object | null): boolean {
  if (value === null || utilIsProxy(value)) {
    return false;
  }

  const prototype = objectGetPrototypeOf(value);
  const constructorDescriptor = objectGetOwnPropertyDescriptor(
    value,
    "constructor",
  );
  return (
    prototype === null &&
    isNativeConstructorForPrototype(constructorDescriptor, "Object", value)
  );
}

function isNativeConstructorForPrototype(
  descriptor: PropertyDescriptor | undefined,
  name: "Array" | "Object",
  prototype: object,
): boolean {
  if (descriptor === undefined || !objectHasOwn(descriptor, "value")) {
    return false;
  }

  const constructor = descriptor.value;
  if (typeof constructor !== "function" || utilIsProxy(constructor)) {
    return false;
  }

  if (
    reflectApply(functionToString, constructor, []) !==
    nativeConstructorSources[name]
  ) {
    return false;
  }

  const prototypeDescriptor = objectGetOwnPropertyDescriptor(
    constructor,
    "prototype",
  );
  return (
    prototypeDescriptor !== undefined &&
    objectHasOwn(prototypeDescriptor, "value") &&
    prototypeDescriptor.value === prototype
  );
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (!isCanonicalArrayIndexString(key)) {
    return false;
  }
  const index = numberCtor(key);
  return numberIsSafeInteger(index) && index >= 0 && index < length;
}

function validateWellFormedString(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = reflectApply(stringCharCodeAt, value, [index]);

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = reflectApply(stringCharCodeAt, value, [index + 1]);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        index += 1;
        continue;
      }
      throw nonHashable("Lone surrogate strings are not hashable.", value, path);
    }

    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw nonHashable("Lone surrogate strings are not hashable.", value, path);
    }
  }
}

function pathForKey(path: string, key: string): string {
  return isPathIdentifier(key)
    ? `${path}.${key}`
    : `${path}[${jsonStringify(key)}]`;
}

function isCanonicalArrayIndexString(value: string): boolean {
  if (value.length === 0) {
    return false;
  }

  const firstCodeUnit = reflectApply(stringCharCodeAt, value, [0]);
  if (firstCodeUnit === 0x30) {
    return value.length === 1;
  }
  if (firstCodeUnit < 0x31 || firstCodeUnit > 0x39) {
    return false;
  }

  for (let index = 1; index < value.length; index += 1) {
    const codeUnit = reflectApply(stringCharCodeAt, value, [index]);
    if (codeUnit < 0x30 || codeUnit > 0x39) {
      return false;
    }
  }
  return true;
}

function isPathIdentifier(value: string): boolean {
  if (value.length === 0) {
    return false;
  }

  const firstCodeUnit = reflectApply(stringCharCodeAt, value, [0]);
  if (!isAsciiIdentifierStart(firstCodeUnit)) {
    return false;
  }

  for (let index = 1; index < value.length; index += 1) {
    const codeUnit = reflectApply(stringCharCodeAt, value, [index]);
    if (!isAsciiIdentifierPart(codeUnit)) {
      return false;
    }
  }
  return true;
}

function isAsciiIdentifierStart(codeUnit: number): boolean {
  return (
    (codeUnit >= 0x41 && codeUnit <= 0x5a) ||
    (codeUnit >= 0x61 && codeUnit <= 0x7a) ||
    codeUnit === 0x24 ||
    codeUnit === 0x5f
  );
}

function isAsciiIdentifierPart(codeUnit: number): boolean {
  return isAsciiIdentifierStart(codeUnit) || (codeUnit >= 0x30 && codeUnit <= 0x39);
}

function hasLiteralAt(value: string, index: number, literal: string): boolean {
  if (index + literal.length > value.length) {
    return false;
  }

  for (let offset = 0; offset < literal.length; offset += 1) {
    if (
      reflectApply(stringCharCodeAt, value, [index + offset]) !==
      reflectApply(stringCharCodeAt, literal, [offset])
    ) {
      return false;
    }
  }
  return true;
}

function sliceAscii(value: string, start: number, end: number): string {
  let result = "";
  for (let index = start; index < end; index += 1) {
    result += reflectApply(stringFromCharCode, stringCtor, [
      reflectApply(stringCharCodeAt, value, [index]),
    ]);
  }
  return result;
}

function nonHashable(
  message: string,
  value: unknown,
  path: string,
): NonHashableValueError {
  return new NonHashableValueError(message, { value, path });
}
