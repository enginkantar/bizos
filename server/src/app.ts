import { createServer, type Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { Router, HttpError, type Reply } from "./http.ts";
import { ingestMessage } from "./db.ts";
import type { Config } from "./config.ts";

// The routes frozen at 11:00 (DAY_PLAN.md). Inbox, cases and audit are real
// against SQLite; the rest answer 501 with the area that owns them, so the UI
// can be built against the final shapes while the pieces land.

const notYet = (route: string, owner: string): Reply =>
  ({ status: 501, body: { error: "not_implemented", route, owner } });

function str(v: unknown, field: string, required = true): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, `missing_${field}`);
    return undefined;
  }
  if (typeof v !== "string") throw new HttpError(400, `invalid_${field}`);
  return v;
}

// The channel-agnostic envelope (design v1.2 §4). `source_message_id` is the
// channel's own id for the message, the key the duplicate check uses; it falls
// back to `message_id` for senders that only provide one.
function parseInbound(body: unknown) {
  if (typeof body !== "object" || body === null) throw new HttpError(400, "expected_json_object");
  const b = body as Record<string, any>;
  const channel = str(b.source, "source")!;
  const sourceMessageId = str(b.source_message_id ?? b.message_id, "source_message_id")!;
  const replyTo = str(b.reply_to, "reply_to")!;
  const text = str(b.content?.text, "content.text")!;
  const customer = typeof b.customer?.name === "string" ? b.customer.name : undefined;
  const receivedAt = str(b.received_at, "received_at", false);
  return { channel, sourceMessageId, replyTo, text, customer, receivedAt };
}

export function createApp(db: DatabaseSync, config: Config): Server {
  const r = new Router();

  r.on("GET", "/api/health", () => ({
    status: 200,
    body: { ok: true, api_key_configured: Boolean(config.anthropicApiKey) },
  }));

  r.on("POST", "/api/inbox", (_req, _p, body) => {
    const { caseId, duplicate } = ingestMessage(db, parseInbound(body));
    return { status: duplicate ? 200 : 201, body: { case_id: caseId, duplicate } };
  });

  r.on("GET", "/api/cases", () => ({
    status: 200,
    body: db.prepare(`SELECT id, channel, customer, status, domain, created_at, updated_at
                      FROM cases ORDER BY created_at DESC LIMIT 200`).all(),
  }));

  r.on("GET", "/api/cases/:id", (_req, { id }) => {
    const c = db.prepare("SELECT * FROM cases WHERE id = ?").get(id);
    if (!c) throw new HttpError(404, "case_not_found");
    const q = (sql: string) => db.prepare(sql).all(id);
    return {
      status: 200,
      body: {
        ...c,
        messages: q("SELECT * FROM messages WHERE case_id = ? ORDER BY received_at"),
        drafts: q("SELECT * FROM drafts WHERE case_id = ? ORDER BY version"),
        outbox: q("SELECT id, draft_id, state, attempts, last_error, updated_at FROM outbox WHERE case_id = ?"),
      },
    };
  });

  r.on("GET", "/api/approvals", () => notYet("GET /api/approvals", "server (Petr)"));
  r.on("POST", "/api/approvals/:id", () => notYet("POST /api/approvals/:id", "server (Petr)"));
  r.on("GET", "/api/rules", () => notYet("GET /api/rules", "rules loader (Petr, format with Siddharth)"));
  r.on("GET", "/api/rules/:domain", () => notYet("GET /api/rules/:domain", "rules loader"));
  r.on("PUT", "/api/rules/:domain", () => notYet("PUT /api/rules/:domain", "rules loader"));

  r.on("GET", "/api/audit", () => ({
    status: 200,
    body: db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 100").all(),
  }));

  return createServer((req, res) => { void r.handle(req, res); });
}
