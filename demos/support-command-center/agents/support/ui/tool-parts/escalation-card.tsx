import type { CreateEscalationOutputPart } from "../types";

export function EscalationCard({ part }: { part: CreateEscalationOutputPart }) {
  return (
    <article className="tool-card">
      <header>
        <span>Escalation</span>
        <strong>{part.output.escalationId}</strong>
      </header>
      <div className="tool-grid">
        <div>
          <span>Team</span>
          <strong>{part.output.ownerTeam}</strong>
        </div>
        <div>
          <span>Priority</span>
          <strong>{part.output.priority}</strong>
        </div>
        <div>
          <span>SLA</span>
          <strong>{part.output.sla}</strong>
        </div>
      </div>
      <p>{part.output.discordSummary}</p>
      <ul className="compact-list">
        {part.output.nextSteps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ul>
    </article>
  );
}
