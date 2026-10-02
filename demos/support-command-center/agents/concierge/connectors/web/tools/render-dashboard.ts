import { tool } from "ai";
import { z } from "zod";
import { getReleaseStatus } from "../../../data/releases";
import {
  buildReleaseDashboardSpec,
  DASHBOARD_SECTIONS,
  type DashboardSection,
  type DashboardSpec,
} from "../../../ui/spec";

/**
 * Web-only connector tool. Builds a json-render dashboard spec for the browser to
 * render as a rich, interactive tool-output part.
 *
 * It's a plain `tool({ ..., execute })` placed in `connectors/web/tools/` — the
 * folder location alone makes it web-only (no `extendTool`, no shared base needed),
 * so it is never exposed to Slack or any other connector.
 *
 * `spec` is typed as the json-render `DashboardSpec` via `z.custom` — the AI SDK
 * has no first-class way to express a json-render flat spec as an output schema,
 * so we type it through (the browser renderer and `validateSpec` enforce its shape)
 * rather than re-validate the nested spec here.
 */
export const renderDashboardOutputSchema = z.object({
  spec: z.custom<DashboardSpec>(),
  summary: z.string(),
});

export type RenderDashboardOutput = {
  spec: DashboardSpec;
  summary: string;
};

export const renderDashboardBase = tool({
  description:
    "Render an interactive release dashboard for the web user. Web connector only. Choose which sections to include based on what the user asked for.",
  inputSchema: z.object({
    version: z.string().optional().describe("Release version to render, e.g. v4.2.0. Omit for the latest."),
    sections: z
      .array(z.enum(DASHBOARD_SECTIONS))
      .optional()
      .describe(
        "Which dashboard sections to show: 'health' (stage/health badge), 'metrics' (key metrics), 'incidents' (open incidents table). Omit to show all.",
      ),
  }),
  outputSchema: renderDashboardOutputSchema,
  execute: async (input: {
    version?: string;
    sections?: DashboardSection[];
  }): Promise<RenderDashboardOutput> => {
    const release = getReleaseStatus(input.version);
    const sections =
      input.sections !== undefined && input.sections.length > 0 ? input.sections : DASHBOARD_SECTIONS;
    return {
      spec: buildReleaseDashboardSpec(release, sections),
      summary: `Release ${release.version} is ${release.health} in the ${release.stage} stage (showing: ${sections.join(", ")}).`,
    };
  },
});

export default renderDashboardBase;
