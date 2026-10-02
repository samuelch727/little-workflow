import { cpSync, existsSync, mkdirSync } from "node:fs";
import { knowledgeDir, seedKnowledgeDir } from "./env";

/**
 * Copy the tracked seed into the live (gitignored) knowledge base the first time the demo
 * runs, so `little-harness test librarian` and the driver both start from the same three
 * documents. Idempotent: an existing knowledge dir is left exactly as the agent left it.
 *
 * Called from `agent.ts` at import time on purpose — the Persistent Dir is read at the
 * start of the FIRST turn, which is already too late for a lazy tool-time bootstrap.
 */
export function ensureKnowledgeBase(): void {
  if (existsSync(knowledgeDir)) return;
  mkdirSync(knowledgeDir, { recursive: true });
  cpSync(seedKnowledgeDir, knowledgeDir, { recursive: true });
}
