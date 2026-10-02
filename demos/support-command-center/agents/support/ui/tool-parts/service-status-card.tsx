import type { CheckServiceStatusOutputPart } from "../types";

export function ServiceStatusCard({ part }: { part: CheckServiceStatusOutputPart }) {
  const incidentCount = part.output.activeIncidents.length;
  const incidentLabel = incidentCount === 1 ? "incident" : "incidents";

  return (
    <article className="tool-card">
      <header>
        <span>Service Status</span>
        <strong>{incidentCount} active {incidentLabel}</strong>
      </header>
      <p>{part.output.customerImpact}</p>
      <div className="status-list">
        {part.output.components.map((component) => (
          <div key={component.product}>
            <strong>{component.product}</strong>
            <span data-status={component.status}>{component.status.replace("_", " ")}</span>
            <p>{component.detail}</p>
          </div>
        ))}
      </div>
    </article>
  );
}
