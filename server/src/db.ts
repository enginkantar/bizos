import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

// One SQLite file is the whole system of record (design v1.2 §4). The
// guarantees the demo relies on live in the SCHEMA, not in application code,
// so a second code path that forgets to check cannot break them:
//
//   UNIQUE(channel, source_message_id)  a resent webhook makes no second case
//   UNIQUE(case_id, version) on drafts  "approve draft v3" means one thing
//   UNIQUE(draft_id, draft_version)     a double-clicked approval records once
//   UNIQUE(idempotency_key) on outbox   a retried send queues one job
//
// Money is integer cents everywhere. A float refund cap compares 199.99 and
// 200 the way floats do, and the gate is the one place that must not.

export const CASE_STATUSES = [
  "new", "routed", "drafted", "held", "approved",
  "sent", "blocked", "escalated", "quote_sent",
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const OUTBOX_STATES = [
  "pending", "processing", "sent", "failed", "delivery_unknown",
] as const;
export type OutboxState = (typeof OUTBOX_STATES)[number];

const inList = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(", ");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cases (
  id          TEXT PRIMARY KEY,
  channel     TEXT NOT NULL,
  -- The verified recipient, taken from the channel at ingress. Replies go here
  -- and nowhere else: never to an address the model wrote (design v1.2 §6).
  reply_to    TEXT NOT NULL,
  customer    TEXT,
  status      TEXT NOT NULL DEFAULT 'new' CHECK (status IN (${inList(CASE_STATUSES)})),
  domain      TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id                 TEXT PRIMARY KEY,
  case_id            TEXT NOT NULL REFERENCES cases(id),
  channel            TEXT NOT NULL,
  source_message_id  TEXT NOT NULL,
  direction          TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  content_type       TEXT NOT NULL DEFAULT 'text',
  text               TEXT NOT NULL,
  received_at        TEXT NOT NULL,
  UNIQUE (channel, source_message_id)
);

CREATE TABLE IF NOT EXISTS drafts (
  id              TEXT PRIMARY KEY,
  case_id         TEXT NOT NULL REFERENCES cases(id),
  version         INTEGER NOT NULL,
  text            TEXT NOT NULL,
  domain          TEXT NOT NULL,
  rules_version   INTEGER NOT NULL,
  rule_citations  TEXT NOT NULL DEFAULT '[]',
  amount_cents    INTEGER,
  action_type     TEXT,
  gate_verdict    TEXT CHECK (gate_verdict IN ('pass', 'review', 'block')),
  gate_policy_id  TEXT,
  gate_reason     TEXT,
  -- Every rules file the gate consulted, {"support":3,"company":1}. An approval
  -- is void if ANY of them changed, not just the domain's own file.
  rules_versions  TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  UNIQUE (case_id, version)
);

CREATE TABLE IF NOT EXISTS approvals (
  id             TEXT PRIMARY KEY,
  draft_id       TEXT NOT NULL REFERENCES drafts(id),
  draft_version  INTEGER NOT NULL,
  rules_version  INTEGER NOT NULL,
  recipient      TEXT NOT NULL,
  channel        TEXT NOT NULL,
  action_type    TEXT NOT NULL,
  decision       TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  decided_at     TEXT NOT NULL,
  UNIQUE (draft_id, draft_version)
);

CREATE TABLE IF NOT EXISTS outbox (
  id               TEXT PRIMARY KEY,
  case_id          TEXT NOT NULL REFERENCES cases(id),
  draft_id         TEXT NOT NULL REFERENCES drafts(id),
  idempotency_key  TEXT NOT NULL UNIQUE,
  channel          TEXT NOT NULL,
  recipient        TEXT NOT NULL,
  text             TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'pending' CHECK (state IN (${inList(OUTBOX_STATES)})),
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL,
  case_id  TEXT,
  event    TEXT NOT NULL,
  detail   TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS outbox_by_state ON outbox(state);
CREATE INDEX IF NOT EXISTS audit_by_case ON audit(case_id);
`;

export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // WAL: the UI polls every 2s while agents write; readers do not block the
  // writer. busy_timeout covers the moments they still collide.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// CREATE TABLE IF NOT EXISTS never changes a table that already exists, so a
// database made by an earlier build keeps its old columns, and the first insert
// naming a new one fails. Teammates have demo data in data/bizos.db; add what is
// missing instead of asking everyone to delete it.
const ADDED_COLUMNS: [table: string, column: string, definition: string][] = [
  ["drafts", "action_type", "TEXT"],
  ["drafts", "gate_reason", "TEXT"],
  ["drafts", "rules_versions", "TEXT NOT NULL DEFAULT '{}'"],
];

function migrate(db: DatabaseSync) {
  for (const [table, column, definition] of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

const now = () => new Date().toISOString();

export function audit(db: DatabaseSync, event: string, caseId: string | null, detail: object = {}) {
  db.prepare("INSERT INTO audit (at, case_id, event, detail) VALUES (?, ?, ?, ?)")
    .run(now(), caseId, event, JSON.stringify(detail));
}

export interface InboundMessage {
  channel: string;
  sourceMessageId: string;
  replyTo: string;
  customer?: string;
  text: string;
  receivedAt?: string;
}

// Returns the case the message belongs to. A message seen before returns its
// original case with duplicate: true and writes nothing. The UNIQUE constraint
// decides, not a lookup first: two copies of one webhook arriving together
// would both pass a "does it exist?" check.
export function ingestMessage(db: DatabaseSync, m: InboundMessage): { caseId: string; duplicate: boolean } {
  const t = now();
  db.exec("BEGIN IMMEDIATE");
  try {
    const caseId = randomUUID();
    db.prepare(`INSERT INTO cases (id, channel, reply_to, customer, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(caseId, m.channel, m.replyTo, m.customer ?? null, t, t);
    const ins = db.prepare(`INSERT INTO messages
        (id, case_id, channel, source_message_id, direction, text, received_at)
        VALUES (?, ?, ?, ?, 'in', ?, ?)
        ON CONFLICT (channel, source_message_id) DO NOTHING`)
      .run(randomUUID(), caseId, m.channel, m.sourceMessageId, m.text, m.receivedAt ?? t);

    if (ins.changes === 0) {
      db.exec("ROLLBACK");
      const row = db.prepare("SELECT case_id FROM messages WHERE channel = ? AND source_message_id = ?")
        .get(m.channel, m.sourceMessageId) as { case_id: string };
      return { caseId: row.case_id, duplicate: true };
    }
    audit(db, "received", caseId, { channel: m.channel, source_message_id: m.sourceMessageId });
    db.exec("COMMIT");
    return { caseId, duplicate: false };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
