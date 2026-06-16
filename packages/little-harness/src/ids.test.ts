import { describe, expect, it } from "vitest";
import { createGeneratedSessionId, createTurnId, sessionKeyToPathKey } from "./ids.js";

describe("ids", () => {
  it("keeps readable safe session keys readable", () => {
    expect(sessionKeyToPathKey("chat_123")).toBe("chat_123");
  });

  it("hashes unsafe session keys without leaking path separators", () => {
    const key = sessionKeyToPathKey("../team/acme chat");
    expect(key).toMatch(/^s_[a-f0-9]{16}$/);
    expect(key).not.toContain("/");
  });

  it("creates generated session and turn identifiers with stable prefixes", () => {
    expect(createGeneratedSessionId()).toMatch(/^session_[a-z0-9]+_[a-z0-9]+$/);
    expect(createTurnId()).toMatch(/^turn_[a-z0-9]+_[a-z0-9]+$/);
  });
});
