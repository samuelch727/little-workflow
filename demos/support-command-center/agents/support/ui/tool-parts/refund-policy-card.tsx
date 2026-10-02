import type { EvaluateRefundPolicyOutputPart } from "../types";

function money(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

export function RefundPolicyCard({ part }: { part: EvaluateRefundPolicyOutputPart }) {
  return (
    <article className="tool-card">
      <header>
        <span>Refund Policy</span>
        <strong>{part.output.eligibility.replaceAll("_", " ")}</strong>
      </header>
      <div className="tool-grid">
        <div>
          <span>Maximum</span>
          <strong>{money(part.output.maximumRefundUsd)}</strong>
        </div>
        <div>
          <span>Approval</span>
          <strong>{part.output.requiresApproval ? "Finance approval required" : "No extra approval"}</strong>
        </div>
      </div>
      <p>{part.output.recommendedResolution}</p>
      <div className="tag-row">
        {part.output.policyCitations.map((citation) => (
          <span key={citation}>{citation}</span>
        ))}
      </div>
      {part.output.riskNotes.length > 0 ? (
        <ul className="compact-list">
          {part.output.riskNotes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}
