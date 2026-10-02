import type { SummarizeTicketHistoryOutputPart } from "../types";

export function TicketHistoryCard({ part }: { part: SummarizeTicketHistoryOutputPart }) {
  return (
    <article className="tool-card">
      <header>
        <span>Ticket History</span>
        <strong>{part.output.sentimentTrend}</strong>
      </header>
      <ol className="timeline-list">
        {part.output.timeline.map((event) => (
          <li key={`${event.ticketId}:${event.at}`}>
            <div>
              <strong>{event.actor}</strong>
              <span>{new Date(event.at).toLocaleString("en-US")}</span>
            </div>
            <p>{event.summary}</p>
          </li>
        ))}
      </ol>
      <div className="tool-columns">
        <section>
          <h4>Prior promises</h4>
          {part.output.priorPromises.map((promise) => (
            <p key={promise}>{promise}</p>
          ))}
        </section>
        <section>
          <h4>Unresolved asks</h4>
          {part.output.unresolvedAsks.map((ask) => (
            <p key={ask}>{ask}</p>
          ))}
        </section>
      </div>
    </article>
  );
}
