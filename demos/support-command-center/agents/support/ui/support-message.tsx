import type { UIMessagePart } from "ai";
import { MessageResponse } from "../../../src/components/ai-elements/message";
import { CustomerProfileCard } from "./tool-parts/customer-profile-card";
import { EscalationCard } from "./tool-parts/escalation-card";
import { OrderTimelineCard } from "./tool-parts/order-timeline-card";
import { RefundPolicyCard } from "./tool-parts/refund-policy-card";
import { ServiceStatusCard } from "./tool-parts/service-status-card";
import { TicketHistoryCard } from "./tool-parts/ticket-history-card";
import type {
  CheckServiceStatusOutputPart,
  CreateEscalationOutputPart,
  EvaluateRefundPolicyOutputPart,
  LookupCustomerOutputPart,
  LookupOrdersOutputPart,
  SummarizeTicketHistoryOutputPart,
  SupportUIMessage,
  SupportUITools,
} from "./types";

type SupportPart = UIMessagePart<never, SupportUITools>;

function isToolPart(part: SupportPart) {
  return part.type.startsWith("tool-");
}

function toolName(part: SupportPart) {
  return part.type.replace(/^tool-/u, "");
}

function JsonFallback({ part }: { part: SupportPart }) {
  const name = toolName(part);
  const output = "output" in part ? part.output : undefined;
  return (
    <details className="tool-card tool-card-fallback" open>
      <summary>{name}</summary>
      <pre>{JSON.stringify(output ?? part, null, 2)}</pre>
    </details>
  );
}

function ToolState({ part }: { part: SupportPart }) {
  const name = toolName(part);
  if ("state" in part && part.state === "output-error") {
    const errorText = "errorText" in part && typeof part.errorText === "string" ? part.errorText : "Tool failed";
    return (
      <div className="tool-state tool-state-error">
        <strong>{name}</strong>
        <span>{errorText}</span>
      </div>
    );
  }
  return (
    <div className="tool-state">
      <strong>{name}</strong>
      <span>Running support lookup...</span>
    </div>
  );
}

function ToolOutput({ part }: { part: SupportPart }) {
  if (!("state" in part) || part.state !== "output-available") {
    return <ToolState part={part} />;
  }

  switch (part.type) {
    case "tool-lookup-customer":
      return <CustomerProfileCard part={part as LookupCustomerOutputPart} />;
    case "tool-lookup-orders":
      return <OrderTimelineCard part={part as LookupOrdersOutputPart} />;
    case "tool-check-service-status":
      return <ServiceStatusCard part={part as CheckServiceStatusOutputPart} />;
    case "tool-summarize-ticket-history":
      return <TicketHistoryCard part={part as SummarizeTicketHistoryOutputPart} />;
    case "tool-evaluate-refund-policy":
      return <RefundPolicyCard part={part as EvaluateRefundPolicyOutputPart} />;
    case "tool-create-escalation":
      return <EscalationCard part={part as CreateEscalationOutputPart} />;
    default:
      return <JsonFallback part={part} />;
  }
}

export function SupportMessage({ message }: { message: SupportUIMessage }) {
  return (
    <article className={`message message-${message.role}`}>
      {message.parts.map((part, index) => {
        if (part.type === "text" && part.text.trim().length > 0) {
          return <MessageResponse key={`${message.id}:text:${index}`}>{part.text}</MessageResponse>;
        }
        if (part.type === "reasoning") {
          return (
            <details className="reasoning" key={`${message.id}:reasoning:${index}`}>
              <summary>Reasoning</summary>
              <p>{part.text}</p>
            </details>
          );
        }
        if (isToolPart(part)) {
          const key = "toolCallId" in part ? part.toolCallId : `${message.id}:tool:${index}`;
          return <ToolOutput key={key} part={part} />;
        }
        return null;
      })}
    </article>
  );
}
