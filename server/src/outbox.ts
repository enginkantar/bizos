import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { audit } from "./db.ts";
import { evaluate } from "./gate.ts";
import type { RuleStore } from "./rulestore.ts";

// Sends what the outbox holds. Pending work lives in SQLite, so a restart
// picks up exactly where it stopped (DAY_PLAN acceptance: "restart -> nothing
// lost").
//
// 🔴 THE HONEST PROMISE IS AT-LEAST-ONCE (design v1.2 §4). A crash between
//    "delivered" and "marked sent" re-delivers on restart. Each channel adapter
//    must make a repeat harmless; the web channel does, by keying the outbound
//    message on the job's idempotency key, so a repeat finds the first copy.

const MAX_ATTEMPTS = 3;
// A job left in `processing` this long was interrupted mid-send.
const STUCK_MS = 30_000;

interface Job {
  id: string; case_id: string; draft_id: string; idempotency_key: string;
  channel: string; recipient: string; text: string; attempts: number;
}

type Deliver = (db: DatabaseSync, job: Job) => void;

// Channels with an adapter. The web chat widget reads its replies from the
// case, so "delivering" is writing the outbound message there.
const ADAPTERS: Record<string, Deliver> = {
  webform(db, job) {
    db.prepare(`INSERT INTO messages (id, case_id, channel, source_message_id, direction, text, received_at)
                VALUES (?, ?, ?, ?, 'out', ?, ?) ON CONFLICT (channel, source_message_id) DO NOTHING`)
      .run(randomUUID(), job.case_id, job.channel, job.idempotency_key, job.text, new Date().toISOString());
  },
};

export function dispatchOutbox(db: DatabaseSync, store: RuleStore): number {
  const t = () => new Date().toISOString();
  db.prepare(`UPDATE outbox SET state = 'pending', updated_at = ?
              WHERE state = 'processing' AND updated_at < ?`)
    .run(t(), new Date(Date.now() - STUCK_MS).toISOString());

  const jobs = db.prepare("SELECT * FROM outbox WHERE state = 'pending' ORDER BY created_at LIMIT 20").all() as unknown as Job[];
  let sent = 0;
  for (const job of jobs) {
    db.prepare("UPDATE outbox SET state = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(t(), job.id);

    // The gate re-runs at send time (v1.2 §6): rules edited after approval
    // still bind. Same check as at draft time, against the live rules.
    const draft = db.prepare("SELECT domain, amount_cents, action_type FROM drafts WHERE id = ?").get(job.draft_id) as
      { domain: string; amount_cents: number | null; action_type: string | null };
    if (draft.amount_cents !== null) {
      const g = evaluate(store, { domain: draft.domain, type: draft.action_type ?? "*", amountCents: draft.amount_cents });
      if (g.verdict === "block") {
        db.prepare("UPDATE outbox SET state = 'failed', last_error = ?, updated_at = ? WHERE id = ?")
          .run(`blocked at send: ${g.reason}`, t(), job.id);
        db.prepare("UPDATE cases SET status = 'blocked', updated_at = ? WHERE id = ?").run(t(), job.case_id);
        audit(db, "blocked_at_send", job.case_id, { outbox_id: job.id, policy_id: g.policyId, reason: g.reason });
        continue;
      }
    }

    const deliver = ADAPTERS[job.channel];
    try {
      if (!deliver) throw new Error(`no adapter for channel "${job.channel}" yet`);
      deliver(db, job);
      db.prepare("UPDATE outbox SET state = 'sent', last_error = NULL, updated_at = ? WHERE id = ?").run(t(), job.id);
      db.prepare("UPDATE cases SET status = 'sent', updated_at = ? WHERE id = ?").run(t(), job.case_id);
      audit(db, "sent", job.case_id, { outbox_id: job.id, channel: job.channel });
      sent++;
    } catch (e) {
      const final = job.attempts + 1 >= MAX_ATTEMPTS || !deliver;
      db.prepare("UPDATE outbox SET state = ?, last_error = ?, updated_at = ? WHERE id = ?")
        .run(final ? "failed" : "pending", (e as Error).message, t(), job.id);
      if (final) audit(db, "send_failed", job.case_id, { outbox_id: job.id, error: (e as Error).message });
    }
  }
  return sent;
}
