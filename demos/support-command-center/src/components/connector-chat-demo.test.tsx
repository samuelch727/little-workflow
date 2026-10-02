import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ConnectorChatDemo } from "./connector-chat-demo";

describe("ConnectorChatDemo", () => {
  test("renders plain web and Discord chat composers", () => {
    const html = renderToStaticMarkup(<ConnectorChatDemo />);

    expect(html).toContain("Web Chat");
    expect(html).toContain("Discord Chat");
    expect(html).toContain("Web message");
    expect(html).toContain("Discord message");
    expect(html).toContain("Send web message");
    expect(html).toContain("Send Discord message");
    expect(html).toContain("What tools are available to you in the web connector?");
    expect(html).toContain("What tools are available to you in the Discord connector?");
    expect(html).not.toContain("Customer signals");
    expect(html).not.toContain("Connector surfaces");
  });
});
