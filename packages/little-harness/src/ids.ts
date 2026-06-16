import { createHash, randomBytes } from "node:crypto";

const SAFE_KEY = /^[a-zA-Z0-9._:-]{1,96}$/;

function randomSuffix(): string {
  return randomBytes(6).toString("hex");
}

export function createGeneratedSessionId(): string {
  return `session_${Date.now().toString(36)}_${randomSuffix()}`;
}

export function createTurnId(): string {
  return `turn_${Date.now().toString(36)}_${randomSuffix()}`;
}

export function createEventId(): string {
  return `evt_${Date.now().toString(36)}_${randomSuffix()}`;
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function sessionKeyToPathKey(sessionKey: string): string {
  if (SAFE_KEY.test(sessionKey) && !sessionKey.includes("..")) {
    return sessionKey;
  }

  return `s_${sha256Hex(sessionKey).slice(0, 16)}`;
}
