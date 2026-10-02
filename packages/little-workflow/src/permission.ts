/**
 * Runtime tool-call permissions — a rule-based allow/deny/ask gate, modelled on
 * opencode's permission system. LWIR permissions are a *compile-time* contract
 * (which tools a workflow may bind); this is the *runtime* layer: a workflow run
 * (or its parent) can additionally gate, or require approval for, specific tool
 * calls. Default (no rules) is allow, so it is opt-in and never surprises.
 */

export type PermissionAction = "allow" | "deny" | "ask";

export type PermissionRule = {
  /** Glob over the tool name, e.g. "*", "candidate_review", "bash*". */
  readonly tool: string;
  readonly action: PermissionAction;
};

export type PermissionRuleset = readonly PermissionRule[];

export type ToolPermissions = {
  readonly ruleset: PermissionRuleset;
  /**
   * Resolve an "ask" decision. Returns true to allow, false to deny. In a
   * headless run with no approver, an "ask" denies (fail closed).
   */
  readonly onAsk?: (request: { readonly tool: string; readonly args: unknown }) => Promise<boolean>;
};

/** Match a tool name against a glob where `*` stands for any run of characters. */
export function matchToolGlob(pattern: string, toolName: string): boolean {
  if (pattern === "*") return true;
  const regex = pattern
    .replace(/[.+?^${}()|[\]\\]/gu, "\\$&")
    .replace(/\*/gu, ".*");
  return new RegExp(`^${regex}$`, "u").test(toolName);
}

/**
 * Resolve a tool call against a ruleset. A matching `deny` short-circuits (most
 * restrictive wins); else a matching `ask` requires approval; else allow. No
 * matching rule is allow — the policy only constrains what it names.
 */
export function evaluateToolPermission(ruleset: PermissionRuleset, toolName: string): PermissionAction {
  let sawAsk = false;
  for (const rule of ruleset) {
    if (!matchToolGlob(rule.tool, toolName)) continue;
    if (rule.action === "deny") return "deny";
    if (rule.action === "ask") sawAsk = true;
  }
  return sawAsk ? "ask" : "allow";
}

/**
 * Constrain a child (sub-run) ruleset by its parent's: every parent `deny`
 * applies to the child too, so a sub-run can never re-enable something its
 * parent forbade. Parent denies are prepended (and deny short-circuits), so they
 * dominate regardless of child rules.
 */
export function inheritPermissions(parent: PermissionRuleset, child: PermissionRuleset): PermissionRuleset {
  const parentDenies = parent.filter((rule) => rule.action === "deny");
  return [...parentDenies, ...child];
}
