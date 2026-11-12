// Imported by workerd and the Node data service. No driver, execute code or credentials here.
import { jsonSchema } from "ai";
import { remoteTool } from "@little-stack/harness/remote-tools";

export const ordersLookup = remoteTool({
  name: "orders_lookup",
  description: "List your orders with the given status.",
  inputSchema: jsonSchema<{ status: "open" | "closed" }>({
    type: "object", properties: { status: { type: "string", enum: ["open", "closed"] } },
    required: ["status"], additionalProperties: false,
  }, {
    validate: value => {
      if (typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 1 &&
        "status" in value && (value.status === "open" || value.status === "closed")) {
        return { success: true, value: { status: value.status } };
      }
      return { success: false, error: new Error("Expected an order status.") };
    },
  }),
});
