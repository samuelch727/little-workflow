import { describe, expect, test } from "vitest";
import checkServiceStatus from "./check-service-status";
import createEscalation from "./create-escalation";
import evaluateRefundPolicy from "./evaluate-refund-policy";
import lookupCustomer from "./lookup-customer";
import lookupOrders from "./lookup-orders";
import summarizeTicketHistory from "./summarize-ticket-history";

async function executeTool<TInput, TOutput>(tool: unknown, input: TInput): Promise<TOutput> {
  const candidate = tool as {
    execute?: (input: TInput, options: { toolCallId: string }) => Promise<TOutput> | TOutput;
  };

  if (typeof candidate.execute !== "function") {
    throw new Error("Tool does not expose execute");
  }

  return candidate.execute(input, { toolCallId: "call_test" });
}

describe("support tools", () => {
  test("exports six strict executable AI SDK tools by filename", () => {
    const tools = [
      lookupCustomer,
      lookupOrders,
      checkServiceStatus,
      summarizeTicketHistory,
      evaluateRefundPolicy,
      createEscalation,
    ] as Array<{ description?: string; inputSchema?: unknown; outputSchema?: unknown; strict?: boolean; execute?: unknown }>;

    expect(tools).toHaveLength(6);
    for (const supportTool of tools) {
      expect(supportTool.description).toEqual(expect.any(String));
      expect(supportTool.inputSchema).toBeDefined();
      expect(supportTool.outputSchema).toBeDefined();
      expect(supportTool.strict).toBe(true);
      expect(supportTool.execute).toEqual(expect.any(Function));
    }
  });

  test("lookup-customer returns the required profile fields", async () => {
    await expect(executeTool(lookupCustomer, { query: "HelioSoft" })).resolves.toMatchObject({
      id: "cust_enterprise_helio",
      name: "HelioSoft Global",
      email: "procurement@heliosoft.example",
      tier: "enterprise",
      health: "at_risk",
      lifetimeValueUsd: 482000,
      products: expect.arrayContaining(["workflow-enterprise"]),
      openTicketIds: expect.arrayContaining(["tic_helio_refund_1042"]),
      riskFlags: expect.arrayContaining(["renewal_in_30_days"]),
      preferredTone: "concise executive brief",
    });
  });

  test("lookup-orders returns newest-first recent orders", async () => {
    const orders = await executeTool<{ customerId: string }, Array<{ id: string; totalUsd: number }>>(lookupOrders, {
      customerId: "cust_fulfillment_northstar",
    });

    expect(orders.map((order) => order.id)).toEqual(["ord_northstar_2026_06_2", "ord_northstar_2026_06_1"]);
    expect(orders[0]?.totalUsd).toBe(1299);
  });

  test("check-service-status supports product-only queries", async () => {
    await expect(executeTool(checkServiceStatus, { product: "workflow-runtime" })).resolves.toMatchObject({
      customerImpact: "General impact: elevated API error rates for customers using workflow-runtime.",
      activeIncidents: [{ id: "inc_workflow_runtime_2026_06_21" }],
    });
  });

  test("summarize-ticket-history can narrow to a single ticket", async () => {
    await expect(
      executeTool(summarizeTicketHistory, {
        customerId: "cust_enterprise_helio",
        ticketId: "tic_helio_refund_1042",
      }),
    ).resolves.toMatchObject({
      sentimentTrend: "improving after refund path explained",
      unresolvedAsks: ["Confirm exact refund amount and approval ETA."],
      timeline: [
        { ticketId: "tic_helio_refund_1042", actor: "customer" },
        { ticketId: "tic_helio_refund_1042", actor: "support" },
      ],
    });
  });

  test("evaluate-refund-policy caps refunds and recommends a resolution", async () => {
    await expect(
      executeTool(evaluateRefundPolicy, {
        customerId: "cust_fulfillment_northstar",
        orderId: "ord_northstar_2026_06_2",
        requestedAmountUsd: 1500,
        reason: "Shipment missed promised event date",
      }),
    ).resolves.toMatchObject({
      eligibility: "eligible",
      maximumRefundUsd: 1299,
      requiresApproval: false,
      policyCitations: ["FULFILL-DEL-2.3", "CS-CREDIT-1.4"],
      recommendedResolution: "Refund the delayed order up to $1,299 and offer expedited replacement shipping.",
    });
  });

  test("create-escalation returns owner, SLA, Discord summary, and next steps", async () => {
    await expect(
      executeTool(createEscalation, {
        customerId: "cust_enterprise_helio",
        severity: "high",
        team: "billing",
        summary: "Duplicate invoice may affect renewal",
        evidence: ["Order ord_helio_2026_06", "Ticket tic_helio_billing_1038"],
      }),
    ).resolves.toMatchObject({
      escalationId: "esc_cust_enterprise_helio_billing_high_001",
      ownerTeam: "billing",
      priority: "P1",
      sla: "1 hour",
      discordSummary:
        "**HIGH billing escalation** for HelioSoft Global: Duplicate invoice may affect renewal Evidence: Order ord_helio_2026_06; Ticket tic_helio_billing_1038",
    });
  });
});
