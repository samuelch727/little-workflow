export type CustomerTier = "startup" | "growth" | "enterprise";
export type CustomerHealth = "healthy" | "watch" | "at_risk";
export type FulfillmentState = "processing" | "shipped" | "delayed" | "delivered";
export type PaymentState = "authorized" | "paid" | "failed" | "disputed";
export type RefundState = "none" | "requested" | "approved" | "issued" | "denied";
export type ComponentStatus = "operational" | "degraded" | "major_outage";
export type IncidentSeverity = "low" | "medium" | "high" | "urgent";
export type EscalationTeam = "billing" | "fulfillment" | "engineering" | "success";
export type RefundEligibility = "ineligible" | "eligible" | "eligible_with_approval";

export interface CustomerProfile {
  id: string;
  name: string;
  email: string;
  tier: CustomerTier;
  health: CustomerHealth;
  lifetimeValueUsd: number;
  products: string[];
  openTicketIds: string[];
  riskFlags: string[];
  preferredTone: string;
}

export interface Order {
  id: string;
  customerId: string;
  placedAt: string;
  fulfillmentState: FulfillmentState;
  paymentState: PaymentState;
  refundState: RefundState;
  subtotalUsd: number;
  taxUsd: number;
  shippingUsd: number;
  totalUsd: number;
}

export interface ServiceComponent {
  product: string;
  status: ComponentStatus;
  detail: string;
}

export interface Incident {
  id: string;
  product: string;
  severity: IncidentSeverity;
  status: "investigating" | "identified" | "monitoring";
  summary: string;
  startedAt: string;
}

export interface ServiceStatusResult {
  components: ServiceComponent[];
  activeIncidents: Incident[];
  customerImpact: string;
  nextUpdateAt: string;
}

export interface TicketEvent {
  ticketId: string;
  at: string;
  actor: "customer" | "support" | "system";
  summary: string;
}

export interface TicketHistorySummary {
  timeline: TicketEvent[];
  sentimentTrend: string;
  priorPromises: string[];
  unresolvedAsks: string[];
}

export interface RefundPolicyEvaluation {
  eligibility: RefundEligibility;
  maximumRefundUsd: number;
  requiresApproval: boolean;
  policyCitations: string[];
  riskNotes: string[];
  recommendedResolution: string;
}

export interface EscalationInput {
  customerId: string;
  severity: IncidentSeverity;
  team: EscalationTeam;
  summary: string;
  evidence: string[];
}

export interface EscalationResult {
  escalationId: string;
  ownerTeam: EscalationTeam;
  priority: "P0" | "P1" | "P2" | "P3";
  sla: string;
  discordSummary: string;
  nextSteps: string[];
}

const CUSTOMERS: CustomerProfile[] = [
  {
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
  },
  {
    id: "cust_fulfillment_northstar",
    name: "Northstar Launch Co.",
    email: "jamie.chen@northstar.example",
    tier: "growth",
    health: "watch",
    lifetimeValueUsd: 38400,
    products: ["launch-kit", "expedited-fulfillment"],
    openTicketIds: ["tic_northstar_delay_1187"],
    riskFlags: ["launch_date_missed"],
    preferredTone: "empathetic and specific",
  },
  {
    id: "cust_engineering_atlas",
    name: "Atlas Labs",
    email: "ops@atlaslabs.example",
    tier: "enterprise",
    health: "at_risk",
    lifetimeValueUsd: 216000,
    products: ["workflow-runtime", "dashboard"],
    openTicketIds: ["tic_atlas_incident_2201"],
    riskFlags: ["active_service_incident", "launch_window"],
    preferredTone: "technical incident brief",
  },
];

const ORDERS: Order[] = [
  {
    id: "ord_helio_2026_06",
    customerId: "cust_enterprise_helio",
    placedAt: "2026-06-15T12:00:00.000Z",
    fulfillmentState: "delivered",
    paymentState: "paid",
    refundState: "requested",
    subtotalUsd: 18000,
    taxUsd: 400,
    shippingUsd: 0,
    totalUsd: 18400,
  },
  {
    id: "ord_helio_2026_05",
    customerId: "cust_enterprise_helio",
    placedAt: "2026-05-15T12:00:00.000Z",
    fulfillmentState: "delivered",
    paymentState: "paid",
    refundState: "none",
    subtotalUsd: 18000,
    taxUsd: 400,
    shippingUsd: 0,
    totalUsd: 18400,
  },
  {
    id: "ord_northstar_2026_06_2",
    customerId: "cust_fulfillment_northstar",
    placedAt: "2026-06-18T09:30:00.000Z",
    fulfillmentState: "delayed",
    paymentState: "paid",
    refundState: "none",
    subtotalUsd: 1199,
    taxUsd: 100,
    shippingUsd: 0,
    totalUsd: 1299,
  },
  {
    id: "ord_northstar_2026_06_1",
    customerId: "cust_fulfillment_northstar",
    placedAt: "2026-06-04T09:30:00.000Z",
    fulfillmentState: "delivered",
    paymentState: "paid",
    refundState: "none",
    subtotalUsd: 849,
    taxUsd: 70,
    shippingUsd: 25,
    totalUsd: 944,
  },
  {
    id: "ord_atlas_2026_06",
    customerId: "cust_engineering_atlas",
    placedAt: "2026-06-10T14:00:00.000Z",
    fulfillmentState: "delivered",
    paymentState: "paid",
    refundState: "none",
    subtotalUsd: 12500,
    taxUsd: 0,
    shippingUsd: 0,
    totalUsd: 12500,
  },
];

const COMPONENTS: ServiceComponent[] = [
  {
    product: "workflow-runtime",
    status: "degraded",
    detail: "Elevated write latency and intermittent 5xx responses in us-east.",
  },
  {
    product: "dashboard",
    status: "operational",
    detail: "No current dashboard degradation.",
  },
  {
    product: "launch-kit",
    status: "operational",
    detail: "Launch kit order management is healthy.",
  },
  {
    product: "workflow-enterprise",
    status: "operational",
    detail: "Enterprise workflow control plane is healthy.",
  },
];

const INCIDENTS: Incident[] = [
  {
    id: "inc_workflow_runtime_2026_06_21",
    product: "workflow-runtime",
    severity: "high",
    status: "investigating",
    summary: "Elevated API error rates for workflow-runtime writes.",
    startedAt: "2026-06-21T08:05:00.000Z",
  },
];

const TICKET_EVENTS: TicketEvent[] = [
  {
    ticketId: "tic_helio_refund_1042",
    at: "2026-06-16T10:20:00.000Z",
    actor: "customer",
    summary: "Procurement reported a duplicate annual support charge.",
  },
  {
    ticketId: "tic_helio_refund_1042",
    at: "2026-06-16T13:40:00.000Z",
    actor: "support",
    summary: "Support explained finance approval path for a partial refund.",
  },
  {
    ticketId: "tic_helio_billing_1038",
    at: "2026-06-12T09:00:00.000Z",
    actor: "support",
    summary: "Success manager promised invoice audit before renewal call.",
  },
  {
    ticketId: "tic_northstar_delay_1187",
    at: "2026-06-18T15:10:00.000Z",
    actor: "customer",
    summary: "Customer warned launch materials had not arrived for event setup.",
  },
  {
    ticketId: "tic_northstar_delay_1187",
    at: "2026-06-19T11:00:00.000Z",
    actor: "support",
    summary: "Support promised replacement order if the carrier scan did not update by June 20.",
  },
  {
    ticketId: "tic_northstar_delay_1187",
    at: "2026-06-20T16:45:00.000Z",
    actor: "customer",
    summary: "Customer asked for shipment location and make-good credit after the estimate passed.",
  },
  {
    ticketId: "tic_atlas_incident_2201",
    at: "2026-06-21T08:22:00.000Z",
    actor: "customer",
    summary: "Atlas Labs reported API writes failing during launch window.",
  },
  {
    ticketId: "tic_atlas_incident_2201",
    at: "2026-06-21T08:36:00.000Z",
    actor: "support",
    summary: "Support linked the report to the active workflow-runtime incident.",
  },
];

const HISTORY_SUMMARIES: Record<string, Omit<TicketHistorySummary, "timeline">> = {
  cust_enterprise_helio: {
    sentimentTrend: "improving after refund path explained",
    priorPromises: ["Audit duplicate invoice before renewal call."],
    unresolvedAsks: ["Confirm exact refund amount and approval ETA."],
  },
  cust_fulfillment_northstar: {
    sentimentTrend: "negative after missed delivery estimate",
    priorPromises: ["Replace order if carrier scan did not update by June 20."],
    unresolvedAsks: ["Confirm shipment location.", "Offer make-good credit for launch delay."],
  },
  cust_engineering_atlas: {
    sentimentTrend: "urgent due to active incident",
    priorPromises: ["Attach engineering owner to incident thread."],
    unresolvedAsks: ["Confirm mitigation ETA.", "Provide post-incident report."],
  },
};

export function lookupCustomer({ query }: { query: string }): CustomerProfile | undefined {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return undefined;
  return CUSTOMERS.find((customer) =>
    [customer.id, customer.name, customer.email, ...customer.openTicketIds].some((value) =>
      value.toLowerCase().includes(normalized),
    ),
  );
}

export function getCustomer(customerId: string): CustomerProfile | undefined {
  return CUSTOMERS.find((customer) => customer.id === customerId);
}

export function lookupOrders({ customerId }: { customerId: string }): Order[] {
  return ORDERS.filter((order) => order.customerId === customerId).sort((left, right) =>
    right.placedAt.localeCompare(left.placedAt),
  );
}

export function checkServiceStatus({
  customerId,
  product,
}: {
  customerId?: string;
  product?: string;
}): ServiceStatusResult {
  const customer = customerId === undefined ? undefined : getCustomer(customerId);
  const products = product === undefined ? customer?.products : [product];
  const components = products === undefined
    ? COMPONENTS
    : COMPONENTS.filter((component) => products.includes(component.product));
  const activeIncidents = INCIDENTS.filter((incident) =>
    components.some((component) => component.product === incident.product),
  );

  return {
    components,
    activeIncidents,
    customerImpact: customerImpactFor(customer, product, activeIncidents),
    nextUpdateAt: "2026-06-21T09:30:00.000Z",
  };
}

export function summarizeTicketHistory({
  customerId,
  ticketId,
}: {
  customerId: string;
  ticketId?: string;
}): TicketHistorySummary {
  const customer = getCustomer(customerId);
  const ticketIds = ticketId === undefined ? customer?.openTicketIds ?? [] : [ticketId];
  const timeline = TICKET_EVENTS.filter((event) => ticketIds.includes(event.ticketId)).sort((left, right) =>
    left.at.localeCompare(right.at),
  );
  const summary = HISTORY_SUMMARIES[customerId] ?? {
    sentimentTrend: "unknown",
    priorPromises: [],
    unresolvedAsks: [],
  };

  return { timeline, ...summary };
}

export function evaluateRefundPolicy({
  customerId,
  orderId,
  requestedAmountUsd,
}: {
  customerId: string;
  orderId: string;
  requestedAmountUsd?: number;
  reason: string;
}): RefundPolicyEvaluation {
  const customer = getCustomer(customerId);
  const order = ORDERS.find((candidate) => candidate.customerId === customerId && candidate.id === orderId);
  const requestedAmount = requestedAmountUsd ?? order?.totalUsd ?? 0;

  if (customerId === "cust_enterprise_helio" && order?.id === "ord_helio_2026_06") {
    return {
      eligibility: "eligible_with_approval",
      maximumRefundUsd: Math.min(requestedAmount, 9200),
      requiresApproval: true,
      policyCitations: ["ENT-BILL-4.2", "FIN-REF-9.1"],
      riskNotes: ["Enterprise renewal in 30 days.", "Prior executive escalation on duplicate billing."],
      recommendedResolution: "Offer a 50% refund now pending finance approval and keep success manager copied.",
    };
  }

  if (customerId === "cust_fulfillment_northstar" && order?.id === "ord_northstar_2026_06_2") {
    return {
      eligibility: "eligible",
      maximumRefundUsd: Math.min(requestedAmount, order.totalUsd),
      requiresApproval: false,
      policyCitations: ["FULFILL-DEL-2.3", "CS-CREDIT-1.4"],
      riskNotes: ["Delivery missed the promised event date."],
      recommendedResolution: "Refund the delayed order up to $1,299 and offer expedited replacement shipping.",
    };
  }

  return {
    eligibility: "ineligible",
    maximumRefundUsd: 0,
    requiresApproval: false,
    policyCitations: ["STD-REF-1.1"],
    riskNotes: customer === undefined ? ["Unknown customer id."] : [],
    recommendedResolution: "Explain that the order is outside the deterministic demo refund policy.",
  };
}

export function createEscalation(input: EscalationInput): EscalationResult {
  const customer = getCustomer(input.customerId);
  const priority = priorityFor(input.severity);
  const sla = slaFor(input.severity);
  const customerName = customer?.name ?? input.customerId;

  return {
    escalationId: `esc_${input.customerId}_${input.team}_${input.severity}_001`,
    ownerTeam: input.team,
    priority,
    sla,
    discordSummary: `**${input.severity.toUpperCase()} ${input.team} escalation** for ${customerName}: ${
      input.summary
    } Evidence: ${input.evidence.join("; ")}`,
    nextSteps: [
      "Post escalation summary to #support-war-room.",
      `Assign ${input.team} owner within ${sla}.`,
      "Send customer-facing update after owner acknowledgement.",
    ],
  };
}

function customerImpactFor(
  customer: CustomerProfile | undefined,
  product: string | undefined,
  activeIncidents: Incident[],
): string {
  if (customer?.id === "cust_engineering_atlas" && activeIncidents.length > 0) {
    return "Atlas Labs is affected by elevated API error rates on workflow-runtime.";
  }

  if (
    activeIncidents.some((incident) =>
      product === undefined || incident.product === product,
    )
  ) {
    return "General impact: elevated API error rates for customers using workflow-runtime.";
  }

  if (customer !== undefined) {
    return `${customer.name} has no active service incident impact in this demo dataset.`;
  }

  return "No active customer impact identified in this demo dataset.";
}

function priorityFor(severity: IncidentSeverity): EscalationResult["priority"] {
  const priorities: Record<IncidentSeverity, EscalationResult["priority"]> = {
    urgent: "P0",
    high: "P1",
    medium: "P2",
    low: "P3",
  };

  return priorities[severity];
}

function slaFor(severity: IncidentSeverity): string {
  return {
    urgent: "15 minutes",
    high: "1 hour",
    medium: "4 hours",
    low: "1 business day",
  }[severity];
}
