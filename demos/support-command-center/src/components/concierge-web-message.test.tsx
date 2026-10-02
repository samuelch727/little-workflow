import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import renderDashboard from "../../agents/concierge/connectors/web/tools/render-dashboard";
import type { ConciergeUIMessage } from "../../agents/concierge/ui/types";
import { WebMessage } from "./concierge-showcase";

/**
 * Closes the join the other tests don't: a real `render-dashboard` tool OUTPUT
 * part flowing through WebMessage → RenderDashboardToolPart → DashboardRenderer
 * and actually painting the dashboard. (The two ends are tested separately; this
 * exercises the middle that only runs in the browser otherwise.)
 */
async function renderDashboardMessage(input: {
  version?: string;
  sections?: ("health" | "metrics" | "incidents")[];
}): Promise<string> {
  const output = await renderDashboard.execute?.(input, {} as never);
  const message = {
    id: "assistant-1",
    role: "assistant",
    parts: [
      {
        type: "tool-render-dashboard",
        state: "output-available",
        toolCallId: "call-1",
        input,
        output,
      },
    ],
  } as unknown as ConciergeUIMessage;
  return renderToStaticMarkup(<WebMessage message={message} />);
}

describe("WebMessage renders a real render-dashboard tool part", () => {
  test("paints the full dashboard from the tool output", async () => {
    const html = await renderDashboardMessage({ version: "v4.2.0" });
    expect(html).toContain("Release v4.2.0");
    expect(html).toContain("canary · healthy"); // health badge
    expect(html).toContain("Error rate"); // metrics section
    expect(html).toContain("INC-198"); // incidents table
  });

  test("honors the model's section choice (generative)", async () => {
    const html = await renderDashboardMessage({ version: "v4.2.0", sections: ["metrics"] });
    expect(html).toContain("Error rate"); // metrics included
    expect(html).not.toContain("INC-198"); // incidents omitted by the section choice
  });
});
