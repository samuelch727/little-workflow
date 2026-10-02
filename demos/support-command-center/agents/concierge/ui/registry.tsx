import { JSONUIProvider, Renderer } from "@json-render/react";
import { defineRegistry } from "@json-render/react";
import { catalog } from "./catalog";
import type { DashboardSpec } from "./spec";

const trendGlyph: Record<"up" | "down" | "flat", string> = {
  up: "▲",
  down: "▼",
  flat: "→",
};

const toneClass: Record<"neutral" | "positive" | "warning" | "critical", string> = {
  neutral: "bg-neutral-100 text-neutral-700",
  positive: "bg-emerald-100 text-emerald-700",
  warning: "bg-amber-100 text-amber-800",
  critical: "bg-rose-100 text-rose-700",
};

/**
 * React implementations for every component in the concierge catalog. The agent's
 * dashboard spec is rendered with `<Renderer spec={spec} registry={registry} />`.
 */
export const { registry } = defineRegistry(catalog, {
  components: {
    Dashboard: ({ props, children }) => (
      <section className="space-y-4 rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
        <header>
          <h3 className="text-base font-semibold text-neutral-900">{props.title}</h3>
          {props.subtitle ? <p className="text-sm text-neutral-500">{props.subtitle}</p> : null}
        </header>
        <div className="space-y-4">{children}</div>
      </section>
    ),
    Section: ({ props, children }) => (
      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
          {props.heading}
        </h4>
        <div className="grid gap-2 sm:grid-cols-3">{children}</div>
      </div>
    ),
    Stat: ({ props }) => (
      <div className="rounded-lg bg-neutral-50 p-3">
        <div className="text-xs text-neutral-500">{props.label}</div>
        <div className="text-lg font-semibold text-neutral-900">
          {props.value}
          {props.trend ? (
            <span className="ml-1 text-xs text-neutral-500">{trendGlyph[props.trend]}</span>
          ) : null}
        </div>
      </div>
    ),
    Badge: ({ props }) => (
      <span
        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${toneClass[props.tone]}`}
      >
        {props.label}
      </span>
    ),
    Table: ({ props }) => (
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr>
            {props.columns.map((column) => (
              <th key={column} className="border-b border-neutral-200 py-1 pr-3 font-medium text-neutral-600">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="border-b border-neutral-100 py-1 pr-3 text-neutral-700">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    ),
    Text: ({ props }) => <p className="text-sm text-neutral-700">{props.value}</p>,
  },
});

/**
 * Renders a dashboard spec. `<Renderer>` reads visibility/state/action contexts,
 * so it must be wrapped in `JSONUIProvider` even for a display-only dashboard —
 * rendering `<Renderer>` bare throws "useVisibility must be used within a
 * VisibilityProvider". This component encapsulates that wrapper.
 */
export function DashboardRenderer({ spec }: { spec: DashboardSpec | null }) {
  return (
    <JSONUIProvider registry={registry}>
      <Renderer spec={spec} registry={registry} />
    </JSONUIProvider>
  );
}
