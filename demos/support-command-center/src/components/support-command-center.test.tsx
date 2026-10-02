import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { SupportCommandCenter } from "./support-command-center";

const sendMessage = vi.fn();
const stop = vi.fn();

vi.mock("@ai-sdk/react", () => ({
  useChat: () => ({
    messages: [],
    sendMessage,
    stop,
    status: "ready",
    error: undefined,
  }),
}));

describe("SupportCommandCenter", () => {
  beforeEach(() => {
    sendMessage.mockReset();
    stop.mockReset();
  });

  test("renders the working support console as the first screen", () => {
    const html = renderToStaticMarkup(<SupportCommandCenter />);

    expect(html).toContain("Support Command Center");
    expect(html).toContain("HelioSoft Global");
    expect(html).toContain("Refund policy check");
    expect(html).toContain("Ask the support agent");
    expect(html).toContain("Connector tool demo");
    expect(html).toContain("Run Discord tool");
    expect(html).toContain("send-channel-update");
    expect(html).toContain("Portable session demo");
    expect(html).toContain("Run web turn");
    expect(html).toContain("Run Discord turn");
    expect(html).toContain("Portable transcript");
    expect(html).toContain("Web operator");
    expect(html).toContain("Discord teammate");
  });
});
