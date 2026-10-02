import { describe, expect, test } from "vitest";
import {
  checkServiceStatus,
  createEscalation,
  evaluateRefundPolicy,
  lookupCustomer,
  lookupOrders,
  summarizeTicketHistory,
} from "./store";

describe("support data store", () => {
  test("looks up deterministic customer profiles by name or email", () => {
    expect(lookupCustomer({ query: "helio" })).toMatchObject({
      id: "cust_enterprise_helio",
      name: "HelioSoft Global",
      email: "procurement@heliosoft.example",
      tier: "enterprise",
      health: "at_risk",
      lifetimeValueUsd: 482000,
      products: ["workflow-enterprise", "priority-success"],
      openTicketIds: ["tic_helio_refund_1042", "tic_helio_billing_1038"],
      riskFlags: ["renewal_in_30_days", "executive_escalation"],
      preferredTone: "concise executive brief",
    });

    expect(lookupCustomer({ query: "jamie.chen@northstar.example" })?.id).toBe(
      "cust_fulfillment_northstar",
    );
  });

  test("does not match whitespace-only customer queries", () => {
    expect(lookupCustomer({ query: "   \t  " })).toBeUndefined();
  });

  test("returns recent orders newest first with money and state fields", () => {
    const orders = lookupOrders({ customerId: "cust_enterprise_helio" });

    expect(orders.map((order) => order.id)).toEqual(["ord_helio_2026_06", "ord_helio_2026_05"]);
    expect(orders[0]).toMatchObject({
      fulfillmentState: "delivered",
      paymentState: "paid",
      refundState: "requested",
      totalUsd: 18400,
    });
  });

  test("reports product incidents and customer impact with a stable next update time", () => {
    expect(checkServiceStatus({ customerId: "cust_engineering_atlas" })).toMatchObject({
      customerImpact: "Atlas Labs is affected by elevated API error rates on workflow-runtime.",
      nextUpdateAt: "2026-06-21T09:30:00.000Z",
      components: [
        { product: "workflow-runtime", status: "degraded" },
        { product: "dashboard", status: "operational" },
      ],
      activeIncidents: [
        {
          id: "inc_workflow_runtime_2026_06_21",
          severity: "high",
          status: "investigating",
        },
      ],
    });
  });

  test("reports general impact when a no-arg status check includes active incidents", () => {
    expect(checkServiceStatus({})).toMatchObject({
      customerImpact: "General impact: elevated API error rates for customers using workflow-runtime.",
      activeIncidents: [{ id: "inc_workflow_runtime_2026_06_21" }],
    });
  });

  test("summarizes ticket history chronologically with commitments and unresolved asks", () => {
    expect(summarizeTicketHistory({ customerId: "cust_fulfillment_northstar" })).toMatchObject({
      sentimentTrend: "negative after missed delivery estimate",
      priorPromises: ["Replace order if carrier scan did not update by June 20."],
      unresolvedAsks: ["Confirm shipment location.", "Offer make-good credit for launch delay."],
    });

    const timeline = summarizeTicketHistory({ customerId: "cust_fulfillment_northstar" }).timeline;
    expect(timeline.map((event) => event.at)).toEqual([
      "2026-06-18T15:10:00.000Z",
      "2026-06-19T11:00:00.000Z",
      "2026-06-20T16:45:00.000Z",
    ]);
  });

  test("evaluates refund policy with approval and citation details", () => {
    expect(
      evaluateRefundPolicy({
        customerId: "cust_enterprise_helio",
        orderId: "ord_helio_2026_06",
        requestedAmountUsd: 9200,
        reason: "Duplicate annual support charge",
      }),
    ).toMatchObject({
      eligibility: "eligible_with_approval",
      maximumRefundUsd: 9200,
      requiresApproval: true,
      policyCitations: ["ENT-BILL-4.2", "FIN-REF-9.1"],
      riskNotes: ["Enterprise renewal in 30 days.", "Prior executive escalation on duplicate billing."],
      recommendedResolution: "Offer a 50% refund now pending finance approval and keep success manager copied.",
    });
  });

  test("creates deterministic escalation ids and Discord-ready summaries", () => {
    expect(
      createEscalation({
        customerId: "cust_engineering_atlas",
        severity: "urgent",
        team: "engineering",
        summary: "API writes failing during launch window",
        evidence: ["Incident inc_workflow_runtime_2026_06_21", "Ticket tic_atlas_incident_2201"],
      }),
    ).toEqual({
      escalationId: "esc_cust_engineering_atlas_engineering_urgent_001",
      ownerTeam: "engineering",
      priority: "P0",
      sla: "15 minutes",
      discordSummary:
        "**URGENT engineering escalation** for Atlas Labs: API writes failing during launch window Evidence: Incident inc_workflow_runtime_2026_06_21; Ticket tic_atlas_incident_2201",
      nextSteps: [
        "Post escalation summary to #support-war-room.",
        "Assign engineering owner within 15 minutes.",
        "Send customer-facing update after owner acknowledgement.",
      ],
    });
  });
});
