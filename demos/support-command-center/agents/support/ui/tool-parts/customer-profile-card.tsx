import type { LookupCustomerOutputPart } from "../types";

function money(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

export function CustomerProfileCard({ part }: { part: LookupCustomerOutputPart }) {
  const customer = part.output;
  if (customer === undefined) {
    return (
      <article className="tool-card">
        <header>
          <span>Customer</span>
          <strong>No match</strong>
        </header>
        <p>No customer matched this query.</p>
      </article>
    );
  }

  return (
    <article className="tool-card">
      <header>
        <span>Customer</span>
        <strong>{customer.name}</strong>
      </header>
      <div className="tool-grid">
        <div>
          <span>Tier</span>
          <strong>{customer.tier}</strong>
        </div>
        <div>
          <span>Health</span>
          <strong>{customer.health.replace("_", " ")}</strong>
        </div>
        <div>
          <span>LTV</span>
          <strong>{money(customer.lifetimeValueUsd)}</strong>
        </div>
      </div>
      <p>{customer.email}</p>
      <div className="tag-row">
        {customer.riskFlags.map((flag) => (
          <span key={flag}>{flag.replaceAll("_", " ")}</span>
        ))}
      </div>
    </article>
  );
}
