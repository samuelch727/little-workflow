import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tool } from "ai";
import { z } from "zod";
import { logToolCall } from "../tool-context";

const policyFile = resolve(dirname(fileURLToPath(import.meta.url)), "..", "policy.md");

/**
 * The truthful policy, verbatim.
 *
 * This is the demo's version of the kb-chatbot trap's shape: the honest source is right
 * there, one call away, and the deliberately-flawed v1 prompt tells the agent its own
 * summary "covers everything you need". Nothing is hidden and nothing is unwinnable — a run
 * that reads this document has every fact it needs to be fully compliant, which is what
 * makes a v1 failure a *strategy* failure rather than an impossible task.
 *
 * The call is logged (when an episode is bound) because "did it read the policy?" is the
 * diagnostic that separates following the wrong summary from never looking.
 */
export default tool({
  description:
    "Return the store's support policy in full, verbatim. It is the authority: where anything else you were told disagrees with it, this document wins.",
  inputSchema: z.object({}),
  execute: (_input, options) => {
    const text = readFileSync(policyFile, "utf8");
    logToolCall("read_policy", {}, options, { characters: text.length });
    return { policy: text };
  },
});
