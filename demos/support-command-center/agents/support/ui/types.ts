import type { UIMessage } from "ai";
import type { ToolOutputPart, ToolUI } from "little-harness/connectors";

export type LookupCustomerTool = typeof import("../tools/lookup-customer").default;
export type LookupOrdersTool = typeof import("../tools/lookup-orders").default;
export type CheckServiceStatusTool = typeof import("../tools/check-service-status").default;
export type SummarizeTicketHistoryTool = typeof import("../tools/summarize-ticket-history").default;
export type EvaluateRefundPolicyTool = typeof import("../tools/evaluate-refund-policy").default;
export type CreateEscalationTool = typeof import("../tools/create-escalation").default;

export type SupportUITools = {
  "lookup-customer": ToolUI<LookupCustomerTool>;
  "lookup-orders": ToolUI<LookupOrdersTool>;
  "check-service-status": ToolUI<CheckServiceStatusTool>;
  "summarize-ticket-history": ToolUI<SummarizeTicketHistoryTool>;
  "evaluate-refund-policy": ToolUI<EvaluateRefundPolicyTool>;
  "create-escalation": ToolUI<CreateEscalationTool>;
};

export type SupportUIMessage = UIMessage<unknown, never, SupportUITools>;

export type LookupCustomerOutputPart = ToolOutputPart<"lookup-customer", LookupCustomerTool>;
export type LookupOrdersOutputPart = ToolOutputPart<"lookup-orders", LookupOrdersTool>;
export type CheckServiceStatusOutputPart = ToolOutputPart<"check-service-status", CheckServiceStatusTool>;
export type SummarizeTicketHistoryOutputPart = ToolOutputPart<
  "summarize-ticket-history",
  SummarizeTicketHistoryTool
>;
export type EvaluateRefundPolicyOutputPart = ToolOutputPart<
  "evaluate-refund-policy",
  EvaluateRefundPolicyTool
>;
export type CreateEscalationOutputPart = ToolOutputPart<"create-escalation", CreateEscalationTool>;
