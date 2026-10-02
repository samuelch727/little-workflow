import type { LookupOrdersOutputPart } from "../types";

function money(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

export function OrderTimelineCard({ part }: { part: LookupOrdersOutputPart }) {
  return (
    <article className="tool-card">
      <header>
        <span>Orders</span>
        <strong>{part.output.length} recent</strong>
      </header>
      <ol className="timeline-list">
        {part.output.map((order) => (
          <li key={order.id}>
            <div>
              <strong>{order.id}</strong>
              <span>{new Date(order.placedAt).toLocaleDateString("en-US")}</span>
            </div>
            <p>
              {order.fulfillmentState} · {order.paymentState} · refund {order.refundState} ·{" "}
              {money(order.totalUsd)}
            </p>
          </li>
        ))}
      </ol>
    </article>
  );
}
