import { describe, expect, it } from "vitest";
import {
  evaluateToolPermission,
  inheritPermissions,
  matchToolGlob,
  type PermissionRuleset,
} from "./permission.js";

describe("evaluateToolPermission", () => {
  it("allows by default when nothing matches (opt-in policy)", () => {
    expect(evaluateToolPermission([], "bash")).toBe("allow");
    const onlyRunWorkflow: PermissionRuleset = [{ tool: "run_workflow", action: "deny" }];
    expect(evaluateToolPermission(onlyRunWorkflow, "bash")).toBe("allow");
  });

  it("deny short-circuits — most restrictive wins over a broad allow", () => {
    const rules: PermissionRuleset = [
      { tool: "*", action: "allow" },
      { tool: "bash", action: "deny" },
    ];
    expect(evaluateToolPermission(rules, "bash")).toBe("deny");
    expect(evaluateToolPermission(rules, "lookup")).toBe("allow");
  });

  it("asks when an ask matches and no deny does", () => {
    const rules: PermissionRuleset = [{ tool: "run_*", action: "ask" }];
    expect(evaluateToolPermission(rules, "run_workflow")).toBe("ask");
    expect(evaluateToolPermission(rules, "plan_workflow")).toBe("allow");
  });
});

describe("matchToolGlob", () => {
  it("matches wildcards and exact names, with regex chars escaped", () => {
    expect(matchToolGlob("*", "anything")).toBe(true);
    expect(matchToolGlob("bash*", "bash.run")).toBe(true);
    expect(matchToolGlob("run_workflow", "run_workflow")).toBe(true);
    expect(matchToolGlob("run_workflow", "plan_workflow")).toBe(false);
    expect(matchToolGlob("a.b", "axb")).toBe(false); // '.' is literal, not a wildcard
  });
});

describe("inheritPermissions", () => {
  it("a sub-run cannot re-enable a tool its parent denied", () => {
    const parent: PermissionRuleset = [{ tool: "bash", action: "deny" }];
    const child: PermissionRuleset = [{ tool: "*", action: "allow" }];
    const merged = inheritPermissions(parent, child);
    expect(evaluateToolPermission(merged, "bash")).toBe("deny");
    expect(evaluateToolPermission(merged, "lookup")).toBe("allow");
  });
});
