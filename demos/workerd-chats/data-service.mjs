// Loopback demo service. Run with Node >=22.13: node --experimental-strip-types data-service.mjs
import { DatabaseSync } from "node:sqlite";
import { remoteToolHandler } from "@little-stack/harness/remote-tools";
import { listenRemoteTools } from "@little-stack/harness/server";
import { ordersLookup } from "./src/remote-contracts.ts";

const token = process.env.DATA_API_TOKEN;
if (!token) throw new Error("Set DATA_API_TOKEN for the loopback data service.");
const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE demo_remote_orders (id TEXT PRIMARY KEY, owner TEXT NOT NULL, status TEXT NOT NULL, total INTEGER NOT NULL)");
const insert = db.prepare("INSERT INTO demo_remote_orders VALUES (?, ?, ?, ?)");
insert.run("order-1", "demo", "open", 4200);
insert.run("order-2", "demo", "open", 1900);
insert.run("order-3", "demo", "closed", 800);
insert.run("other-user-order", "other", "open", 9999);
const lookup = db.prepare("SELECT id, status, total FROM demo_remote_orders WHERE owner = ? AND status = ? ORDER BY id");
const service = await listenRemoteTools({
  port: Number(process.env.DATA_API_PORT || 8788),
  // A service credential proves only this demo principal. Real per-user proof belongs in
  // a dedicated header checked for issuer, audience and expiry, never in host context.
  authenticate: request => request.headers.get("authorization") === `Bearer ${token}` ? { id: "demo" } : undefined,
  tools: [remoteToolHandler(ordersLookup, ({ status }, { principal }) => ({ orders: lookup.all(principal.id, status) }))],
});
console.log(`Data service listening on ${service.url}`);
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, async () => { await service.close(); db.close(); });
