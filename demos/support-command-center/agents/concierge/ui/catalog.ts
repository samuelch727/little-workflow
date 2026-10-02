import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";

/**
 * The json-render catalog for the concierge web connector. This is the guardrail:
 * the agent (or the deterministic builder) may only emit these components, with
 * exactly these props. The browser renderer in `registry.tsx` provides the React
 * implementation for each entry.
 */
export const catalog = defineCatalog(schema, {
  components: {
    Dashboard: {
      props: z.object({
        title: z.string(),
        subtitle: z.string().nullable(),
      }),
      description: "Top-level release dashboard container with a title and optional subtitle.",
    },
    Section: {
      props: z.object({ heading: z.string() }),
      description: "A labelled group of widgets inside the dashboard.",
    },
    Stat: {
      props: z.object({
        label: z.string(),
        value: z.string(),
        trend: z.enum(["up", "down", "flat"]).nullable(),
      }),
      description: "A single key metric with an optional trend direction.",
    },
    Badge: {
      props: z.object({
        label: z.string(),
        tone: z.enum(["neutral", "positive", "warning", "critical"]),
      }),
      description: "A small status pill, e.g. release stage and health.",
    },
    Table: {
      props: z.object({
        columns: z.array(z.string()),
        rows: z.array(z.array(z.string())),
      }),
      description: "A simple data table, e.g. open incidents.",
    },
    Text: {
      props: z.object({ value: z.string() }),
      description: "A line of body text.",
    },
  },
  actions: {},
});
