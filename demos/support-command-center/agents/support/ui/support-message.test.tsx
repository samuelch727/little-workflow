import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { SupportMessage } from "./support-message";
import type { SupportUIMessage } from "./types";

function renderMessage(message: SupportUIMessage) {
  return renderToStaticMarkup(<SupportMessage message={message} />);
}

describe("SupportMessage", () => {
  test("renders a typed customer profile tool output", () => {
    const html = renderMessage({
      id: "msg_customer",
      role: "assistant",
      parts: [
        {
          type: "tool-lookup-customer",
          state: "output-available",
          toolCallId: "call_customer",
          input: { query: "helio" },
          output: {
            id: "cust_enterprise_helio",
            name: "HelioSoft Global",
            email: "procurement@heliosoft.example",
            tier: "enterprise",
            health: "at_risk",
            lifetimeValueUsd: 482000,
            products: ["workflow-enterprise", "priority-success"],
            openTicketIds: ["tic_helio_refund_1042"],
            riskFlags: ["renewal_in_30_days"],
            preferredTone: "concise executive brief",
          },
        },
      ],
    });

    expect(html).toContain("HelioSoft Global");
    expect(html).toContain("enterprise");
    expect(html).toContain("$482,000");
  });

  test("renders refund eligibility and policy citations", () => {
    const html = renderMessage({
      id: "msg_refund",
      role: "assistant",
      parts: [
        {
          type: "tool-evaluate-refund-policy",
          state: "output-available",
          toolCallId: "call_refund",
          input: {
            customerId: "cust_enterprise_helio",
            orderId: "ord_helio_2026_06",
            requestedAmountUsd: 9200,
            reason: "Duplicate annual support charge",
          },
          output: {
            eligibility: "eligible_with_approval",
            maximumRefundUsd: 9200,
            requiresApproval: true,
            policyCitations: ["ENT-BILL-4.2", "FIN-REF-9.1"],
            riskNotes: ["Enterprise renewal in 30 days."],
            recommendedResolution: "Offer a 50% refund now pending finance approval.",
          },
        },
      ],
    });

    expect(html).toContain("eligible with approval");
    expect(html).toContain("ENT-BILL-4.2");
    expect(html).toContain("Finance approval required");
  });

  test("renders unknown tool outputs through a JSON fallback", () => {
    const html = renderMessage({
      id: "msg_unknown",
      role: "assistant",
      parts: [
        {
          type: "tool-synthetic-debug",
          state: "output-available",
          toolCallId: "call_unknown",
          input: { id: "debug" },
          output: { status: "ok", count: 2 },
        } as never,
      ],
    });

    expect(html).toContain("synthetic-debug");
    expect(html).toContain("&quot;status&quot;: &quot;ok&quot;");
  });

  test("pluralizes the active incident label", () => {
    const html = renderMessage({
      id: "msg_status",
      role: "assistant",
      parts: [
        {
          type: "tool-check-service-status",
          state: "output-available",
          toolCallId: "call_status",
          input: {},
          output: {
            components: [],
            activeIncidents: [
              {
                id: "inc_1",
                product: "workflow-runtime",
                severity: "high",
                status: "investigating",
                summary: "Elevated API error rates.",
                startedAt: "2026-06-21T08:05:00.000Z",
              },
              {
                id: "inc_2",
                product: "dashboard",
                severity: "medium",
                status: "identified",
                summary: "Dashboard queue delay.",
                startedAt: "2026-06-21T08:15:00.000Z",
              },
            ],
            customerImpact: "General impact detected.",
            nextUpdateAt: "2026-06-21T09:30:00.000Z",
          },
        },
      ],
    });

    expect(html).toContain("2 active incidents");
  });
});
