import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { openDb, ingestMessage } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";

// Every database here is a throwaway file, never data/bizos.db: tests must not
// read or write the demo's records.
function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "bizos-test-"));
  const db = openDb(join(dir, "test.db"));
  return { db, done: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const msg = (id: string) => ({
  channel: "webform", sourceMessageId: id, replyTo: "dana@example.com", text: "Do you cater?",
});

test("the database runs in WAL mode", () => {
  const { db, done } = tempDb();
  const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
  assert.equal(row.journal_mode, "wal");
  done();
});

test("a resent message makes no second case", () => {
  const { db, done } = tempDb();
  const first = ingestMessage(db, msg("m-1"));
  const again = ingestMessage(db, msg("m-1"));
  assert.equal(first.duplicate, false);
  assert.equal(again.duplicate, true);
  assert.equal(again.caseId, first.caseId);
  const n = db.prepare("SELECT COUNT(*) AS n FROM cases").get() as { n: number };
  assert.equal(n.n, 1, "the rolled-back case must not linger");
  done();
});

test("the same id on a different channel is a different message", () => {
  const { db, done } = tempDb();
  const a = ingestMessage(db, msg("m-1"));
  const b = ingestMessage(db, { ...msg("m-1"), channel: "email" });
  assert.notEqual(a.caseId, b.caseId);
  done();
});

test("the schema refuses a second approval of one draft version and a second send job", () => {
  const { db, done } = tempDb();
  const { caseId } = ingestMessage(db, msg("m-1"));
  const t = new Date().toISOString();
  db.prepare(`INSERT INTO drafts (id, case_id, version, text, domain, rules_version, created_at)
              VALUES ('d1', ?, 1, 'hi', 'sales', 3, ?)`).run(caseId, t);
  const approve = () => db.prepare(`INSERT INTO approvals
      (id, draft_id, draft_version, rules_version, recipient, channel, action_type, decision, decided_at)
      VALUES (?, 'd1', 1, 3, 'dana@example.com', 'webform', 'reply', 'approved', ?)`).run(crypto.randomUUID(), t);
  approve();
  assert.throws(approve, /UNIQUE/);
  const enqueue = () => db.prepare(`INSERT INTO outbox
      (id, case_id, draft_id, idempotency_key, channel, recipient, text, created_at, updated_at)
      VALUES (?, ?, 'd1', 'case:d1:v1', 'webform', 'dana@example.com', 'hi', ?, ?)`).run(crypto.randomUUID(), caseId, t, t);
  enqueue();
  assert.throws(enqueue, /UNIQUE/);
  done();
});

test("the HTTP API: inbox dedupes, cases and audit read back, approvals stub says 501", async () => {
  const { db, done } = tempDb();
  const server = createApp(db, loadConfig({}));
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: unknown) => fetch(`${base}/api/inbox`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    const envelope = {
      message_id: "wf-42", source: "webform", reply_to: "dana@example.com",
      customer: { name: "Dana" }, content: { type: "text", text: "Can I get a refund?" },
    };
    const r1 = await post(envelope);
    assert.equal(r1.status, 201);
    const { case_id } = await r1.json() as { case_id: string };
    const r2 = await post(envelope);
    assert.equal(r2.status, 200);
    assert.deepEqual(await r2.json(), { case_id, duplicate: true });

    assert.equal((await post({ source: "webform" })).status, 400);

    const cases = await (await fetch(`${base}/api/cases`)).json() as unknown[];
    assert.equal(cases.length, 1);
    const one = await (await fetch(`${base}/api/cases/${case_id}`)).json() as { reply_to: string; messages: unknown[] };
    assert.equal(one.reply_to, "dana@example.com");
    assert.equal(one.messages.length, 1);
    assert.equal((await fetch(`${base}/api/cases/nope`)).status, 404);

    const auditRows = await (await fetch(`${base}/api/audit`)).json() as { event: string }[];
    assert.deepEqual(auditRows.map((a) => a.event), ["received"]);

    assert.equal((await fetch(`${base}/api/approvals`)).status, 501);
    assert.equal((await fetch(`${base}/api/rules/sales`, { method: "PUT" })).status, 400, "a save with no content");
    assert.equal((await fetch(`${base}/api/inbox`)).status, 405);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  } finally {
    server.close();
    done();
  }
});
