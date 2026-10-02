import { expect, it } from "vitest";
import { canonicalJson as rootCanonicalJson, sha256Hex as rootSha256Hex } from "../index.js";
import {
  canonicalJson as durabilityCanonicalJson,
  sha256Hex as durabilitySha256Hex,
} from "../events/durability.js";
import { canonicalJson, stableHash } from "./canonical-hash.js";

it("hashes object keys independent of insertion order", () => {
  const first = stableHash({ beta: 2, alpha: { zed: true, one: 1 } });
  const second = stableHash({ alpha: { one: 1, zed: true }, beta: 2 });

  expect(second).toBe(first);
});

it("hashes arrays with order sensitivity", () => {
  const first = stableHash(["alpha", "beta"]);
  const second = stableHash(["beta", "alpha"]);

  expect(second).not.toBe(first);
});

it("serializes sparse arrays as canonical JSON null entries", () => {
  const sparse = [1, , 2] as unknown[];

  expect(canonicalJson(Array(1))).toBe("[null]");
  expect(canonicalJson(sparse)).toBe("[1,null,2]");
  expect(stableHash(Array(1))).not.toBe(stableHash([]));
});

it("keeps root canonicalJson and sha256Hex exports bound to durability helpers", () => {
  expect(rootCanonicalJson).toBe(durabilityCanonicalJson);
  expect(rootSha256Hex).toBe(durabilitySha256Hex);
});

it("returns a stable sha256-prefixed hash by default", () => {
  expect(stableHash({ alpha: 1, beta: ["two"] })).toBe(
    "sha256:dfadc201a85ed218d65345ec54f4d527c7c7fc31db141964d2f5e893ec0ed10f",
  );
});

it("returns unprefixed lowercase hex when requested", () => {
  expect(stableHash({ alpha: 1, beta: ["two"] }, { format: "hex" })).toBe(
    "dfadc201a85ed218d65345ec54f4d527c7c7fc31db141964d2f5e893ec0ed10f",
  );
});

it("returns unpadded base64url without unsafe or whitespace characters", () => {
  const hash = stableHash({ alpha: 1, beta: ["two"] }, { format: "base64url" });

  expect(hash).toMatch(/^[A-Za-z0-9_-]+$/u);
  expect(hash).not.toMatch(/[\/+=.\s]/u);
});

it("returns lowercase unpadded base32hex", () => {
  const hash = stableHash({ alpha: 1, beta: ["two"] }, { format: "base32hex" });

  expect(hash).toMatch(/^[0-9a-v]+$/u);
  expect(hash).not.toContain("=");
});
