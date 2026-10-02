import type { UIMessage } from "ai";
import type { ToolOutputPart, ToolUI } from "little-harness/connectors";

/**
 * The render-dashboard tool's typed shape for the browser. We reference the
 * inline `renderDashboardBase` tool (which carries the output schema) rather than
 * the `extendTool` default export, so `ToolOutputPart` can infer the output type.
 */
export type RenderDashboardTool = typeof import("../connectors/web/tools/render-dashboard").renderDashboardBase;

export type ConciergeUITools = {
  "render-dashboard": ToolUI<RenderDashboardTool>;
};

export type ConciergeUIMessage = UIMessage<unknown, never, ConciergeUITools>;
export type RenderDashboardOutputPart = ToolOutputPart<"render-dashboard", RenderDashboardTool>;
