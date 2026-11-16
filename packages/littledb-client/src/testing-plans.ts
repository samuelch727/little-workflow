// Shared plan routes for the testing helper and the package's fake API. Not used by live clients.
import { WorkflowPlanUploadSchema, type StoredWorkflowPlan } from "./contract.js";
import { isRecord, sha256Hex } from "./util.js";

export function planStoreKey(workflow: string, hash: string): string { return JSON.stringify([workflow, hash]); }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
function shape(values: unknown[]): unknown[] {
  return values.map((value) => {
    const step = value as Record<string, unknown>;
    const w = isRecord(step.with) ? step.with : {};
    return {
      id: step.id, uses: step.uses,
      needs: Array.isArray(step.needs) ? [...step.needs].sort() : [],
      ...(typeof step.maxVisits === "number" && step.maxVisits > 1 ? { maxVisits: step.maxVisits } : {}),
      ...(step.uses === "decision" ? { targets: [...(Array.isArray(w.cases) ? w.cases.filter(isRecord).map((c) => c.to) : []), ...(typeof w.default === "string" ? [w.default] : [])] } : {}),
      ...(typeof w.tool === "string" ? { tool: w.tool } : {}),
      ...(Array.isArray(step.steps) ? { steps: shape(step.steps) } : {}),
    };
  });
}

export function createTestPlanStore() {
  const plans = new Map<string, StoredWorkflowPlan>();
  const error = (status: number, code: string) => ({ status, body: { error: { code, message: code } } });
  return {
    plans,
    route(method: string, path: string, body: unknown): { status: number; body: unknown } | undefined {
      const url = new URL(path, "http://littledb.test");
      if (!url.pathname.startsWith("/v1/workflow-plans")) return undefined;
      const hash = decodeURIComponent(url.pathname.slice("/v1/workflow-plans/".length));
      if (method === "PUT") {
        if (!/^sha256:[a-f0-9]{64}$/u.test(hash)) return error(400, "invalid");
        if (new TextEncoder().encode(JSON.stringify(body)).length > 256 * 1024) return error(413, "too_large");
        const parsed = WorkflowPlanUploadSchema.safeParse(body);
        if (!parsed.success) return error(400, "invalid");
        let count = 0;
        function valid(values: unknown, depth: number): boolean {
          return Array.isArray(values) && depth <= 4 && values.every((step) => {
            if (!isRecord(step) || typeof step.id !== "string" || typeof step.uses !== "string" || ++count > 500) return false;
            if (step.needs !== undefined && (!Array.isArray(step.needs) || !step.needs.every((v) => typeof v === "string"))) return false;
            if (step.maxVisits !== undefined && (typeof step.maxVisits !== "number" || !Number.isSafeInteger(step.maxVisits) || step.maxVisits < 1)) return false;
            if (step.with !== undefined) {
              if (!isRecord(step.with)) return false;
              const w = step.with;
              if (w.tool !== undefined && typeof w.tool !== "string") return false;
              if (step.uses === "decision") {
                if (w.cases !== undefined && (!Array.isArray(w.cases) || !w.cases.every((c) => isRecord(c) && typeof c.to === "string"))) return false;
                if (w.default !== undefined && typeof w.default !== "string") return false;
              }
            }
            return step.steps === undefined || valid(step.steps, depth + 1);
          });
        }
        if (!valid(parsed.data.plan.steps, 1)) return error(400, "invalid");
        const input = parsed.data;
        const key = planStoreKey(input.workflow, hash);
        const old = plans.get(key);
        const now = new Date().toISOString();
        if (!old || (!old.complete && input.complete)) {
          plans.set(key, { ...input, hash, shapeHash: `sha256:${sha256Hex(canonical({ steps: shape(input.plan.steps) }))}`, firstSeenAt: old?.firstSeenAt ?? now, lastSeenAt: now });
        } else if (Date.now() - Date.parse(old.lastSeenAt) >= 3_600_000) {
          plans.set(key, { ...old, lastSeenAt: now });
        }
        const stored = plans.get(key)!;
        return { status: old ? 200 : 201, body: { hash, shapeHash: stored.shapeHash, complete: stored.complete } };
      }
      if (method === "GET" && url.pathname === "/v1/workflow-plans") {
        const workflow = url.searchParams.get("workflow");
        const limit = Number(url.searchParams.get("limit") ?? 50);
        if (!workflow || !Number.isInteger(limit) || limit < 1 || limit > 50) return error(400, "invalid");
        return { status: 200, body: { plans: [...plans.values()].filter((p) => p.workflow === workflow).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0, limit).map(({ plan: _plan, workflowVersionId: _id, ...row }) => row) } };
      }
      if (method === "GET") {
        const workflow = url.searchParams.get("workflow");
        const row = (workflow ? plans.get(planStoreKey(workflow, hash)) : undefined) ?? [...plans.values()].filter((p) => p.hash === hash).sort((a, b) => Number(b.complete) - Number(a.complete) || a.firstSeenAt.localeCompare(b.firstSeenAt))[0];
        if (!row) return error(404, "not_found");
        const { workflowVersionId: _id, ...result } = row;
        return { status: 200, body: result };
      }
      return undefined;
    },
  };
}
