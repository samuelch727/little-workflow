import { DashboardRenderer } from "../registry";
import type { DashboardSpec } from "../spec";
import type { RenderDashboardOutputPart } from "../types";

/**
 * Renders the web-only `render-dashboard` tool output: the agent's json-render
 * dashboard spec, rendered live in the browser via the catalog registry.
 */
export function RenderDashboardToolPart({ part }: { part: RenderDashboardOutputPart }) {
  const spec = part.output.spec as DashboardSpec;
  return (
    <div className="space-y-2">
      <DashboardRenderer spec={spec} />
      {part.output.summary ? (
        <p className="text-xs text-neutral-500">{part.output.summary}</p>
      ) : null}
    </div>
  );
}
