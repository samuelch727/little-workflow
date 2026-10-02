// Northwind Helpdesk — the CUSTOMER-facing surface of the kb-chatbot demo.
//
// One small HTTP server: serves the chat page and bridges it onto the same
// chat-sdk connector the Slack path uses (simulateInbound + reaction events),
// so everything a customer does here — chat, file upload, 👍/👎 — flows through
// the real harness, the real littleDB reporter, and the real outcome sink.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = dirname(fileURLToPath(import.meta.url));
const demoRoot = join(here, "..");
process.chdir(demoRoot); // little-harness's module loader roots jiti at cwd

const { createTestChat, createTestThread, createTestMessage } = await import("little-harness/connectors");

// The shipped test double lacks onReaction (LIT-47 #3); same subclass the driver uses.
const Base = createTestChat();
const reactionHandlers = [];
class ReactionAwareChat extends Base {
  onReaction(handler) { reactionHandlers.push(handler); }
}

const jiti = createJiti(join(demoRoot, "_customer_root_.js"), { interopDefault: false });
const mod = await jiti.import(join(demoRoot, "agents", "librarian", "load.ts"));
const connector = await mod.loadLibrarianConnector({ createChat: ReactionAwareChat });

const threads = new Map(); // threadId -> { thread, seq }
function threadFor(id) {
  if (!threads.has(id)) {
    threads.set(id, { thread: createTestThread({ id, adapterName: "slack", isDM: true }), seq: 0 });
  }
  return threads.get(id);
}

const PAGE = readFileSync(join(here, "index.html"));
const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve(b ? JSON.parse(b) : {}));
});

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(PAGE);
    }
    if (req.method === "POST" && req.url === "/api/chat") {
      const { threadId, text, attachment } = await readBody(req);
      const t = threadFor(threadId);
      t.seq += 1;
      const attachments = attachment
        ? [{ type: "file", name: attachment.name, mimeType: attachment.mimeType || "text/markdown",
             data: Uint8Array.from(atob(attachment.dataBase64), (c) => c.charCodeAt(0)) }]
        : undefined;
      const before = t.thread.posts.length;
      await connector.simulateInbound({
        thread: t.thread,
        message: createTestMessage({
          id: `web-${threadId}-${t.seq}`, threadId, text,
          ...(attachments ? { attachments } : {}),
        }),
      });
      const reply = t.thread.posts.slice(before).join("\n\n") || "(no reply)";
      const messageId = `sent_${threadId}_${t.seq}`;
      return json(res, 200, { reply, messageId });
    }
    if (req.method === "POST" && req.url === "/api/react") {
      const { threadId, messageId, emoji, added } = await readBody(req);
      for (const h of reactionHandlers) {
        await h({
          added: added !== false, emoji, rawEmoji: emoji, messageId, threadId,
          user: { userId: "web-customer", isMe: false, isBot: false },
          message: { id: messageId, author: { userId: "librarian-bot", isMe: true } },
        });
      }
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: String(e?.message ?? e) });
  }
});

const PORT = Number(process.env.PORT || 3100);
server.listen(PORT, () => console.log(`Northwind Helpdesk on http://localhost:${PORT}  littleDB: ${process.env.LITTLEDB_URL ? "wired" : "off"}`));
