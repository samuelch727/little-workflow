import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ConciergeShowcase } from "./concierge-showcase";

describe("ConciergeShowcase", () => {
  test("renders both connector panels and their tool badges", () => {
    const html = renderToStaticMarkup(<ConciergeShowcase />);
    expect(html).toContain("Web (json-render)");
    expect(html).toContain("Slack");
    expect(html).toContain("render-dashboard");
    expect(html).toContain("post-to-channel");
    expect(html).toContain("reply-in-thread");
    // Slack-only tools must not appear under the web panel's badge list and vice-versa
    // is covered by the connector isolation tests; here we just assert both panels mount.
    expect(html).toContain("# releases");
  });
});
