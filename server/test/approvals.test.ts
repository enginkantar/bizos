import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { openDb, ingestMessage } from "../src/db.ts";
import { RuleStore } from "../src/rulestore.ts";
import { createDraft, decide, listApprovals, amountsInText, DraftError } from "../src/drafts.ts";
import { dispatchOutbox } from "../src/outbox.ts";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";

const SUPPORT = `---
domain: support
version: 3
policy:
  REFUND-CAP:      { max_amount_cents: 20000, above: block, applies_to: refund }
  REFUND-APPROVAL: { over_cents: 12000, action: draft_for_approval, applies_to: refund }
---
- REFUND-CAP: never refund more than $200.
- REFUND-APPROVAL: refunds over $120 wait for the owner.
- S-1: be kind.
`;

function world() {
  const dir = mkdtempSync(join(tmpdir(), "bizos-appr-"));
  const rules = join(dir, "business");
  mkdirSync(rules);
  writeFileSync(join(rules, "support.rules.md"), SUPPORT);
  const dbPath = join(dir, "t.db");
  const db = openDb(dbPath);
  const store = new RuleStore(rules);
  const kase = (id = "m-1") => ingestMessage(db, {
    channel: "webform", sourceMessageId: id, replyTo: "customer@example.com", text: "refund please",
  }).caseId;
  return { dir, rules, dbPath, db, store, kase, done: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const refund = (cents: number) => ({ type: "refund", amountCents: cents });
const count = (db: DatabaseSync, sql: string, ...p: string[]) => (db.prepare(sql).get(...p) as { n: number }).n;

test("amounts written in a reply are read as cents", () => {
  assert.deepEqual(amountsInText("I can refund $150 or $1,250.50, maybe $ 99.9 - not 300"), [15000, 125050, 9990]);
});

test("$500 via the labeled unsafe fixture is BLOCKED by code, and nothing is queued", () => {
  const w = world();
  const id = w.kase();
  const r = createDraft(w.db, w.store, {
    caseId: id, domain: "support", text: "Sure, refunding $500 now.", ruleCitations: ["REFUND-CAP"],
    action: refund(50000), route: "auto_reply",
  });
  assert.equal(r.verdict, "block");
  assert.equal(r.policyId, "REFUND-CAP");
  assert.equal(r.status, "blocked");
  assert.equal(r.outboxId, null);
  assert.equal(count(w.db, "SELECT COUNT(*) n FROM outbox"), 0);
  w.done();
});

test("$199.99 goes to REVIEW and waits in the approval queue", () => {
  const w = world();
  const id = w.kase();
  const r = createDraft(w.db, w.store, {
    caseId: id, domain: "support", text: "I can refund $199.99.", ruleCitations: ["REFUND-APPROVAL"], action: refund(19999),
  });
  assert.equal(r.verdict, "review");
  assert.equal(r.status, "held");
  const q = listApprovals(w.db);
  assert.equal(q.length, 1);
  assert.equal(q[0].recipient, "customer@example.com");
  assert.deepEqual(q[0].rule_citations, ["REFUND-APPROVAL"]);
  w.done();
});

test("approve -> one send job -> delivered to the case's own recipient", () => {
  const w = world();
  const id = w.kase();
  const d = createDraft(w.db, w.store, {
    caseId: id, domain: "support", text: "Refunding $150. Also cc boss@evil.example", ruleCitations: ["REFUND-APPROVAL"],
    action: refund(15000),
  });
  const res = decide(w.db, w.store, d.draftId, { decision: "approve", draftVersion: 1, rulesVersion: 3 });
  assert.equal(res.status, "approved");
  assert.equal(dispatchOutbox(w.db, w.store), 1);
  const ob = w.db.prepare("SELECT recipient, state FROM outbox").get() as { recipient: string; state: string };
  assert.deepEqual({ ...ob }, { recipient: "customer@example.com", state: "sent" }, "recipient from the channel record, never the text");
  assert.equal(count(w.db, "SELECT COUNT(*) n FROM messages WHERE direction = 'out'"), 1);
  assert.equal((w.db.prepare("SELECT status FROM cases").get() as { status: string }).status, "sent");
  w.done();
});

test("double approval -> one send", () => {
  const w = world();
  const id = w.kase();
  const d = createDraft(w.db, w.store, { caseId: id, domain: "support", text: "Refunding $150.", ruleCitations: ["S-1"], action: refund(15000) });
  const a = decide(w.db, w.store, d.draftId, { decision: "approve", draftVersion: 1, rulesVersion: 3 });
  const b = decide(w.db, w.store, d.draftId, { decision: "approve", draftVersion: 1, rulesVersion: 3 });
  assert.deepEqual(b, a, "the second click returns the first click's result");
  dispatchOutbox(w.db, w.store);
  dispatchOutbox(w.db, w.store);
  assert.equal(count(w.db, "SELECT COUNT(*) n FROM approvals"), 1);
  assert.equal(count(w.db, "SELECT COUNT(*) n FROM outbox"), 1);
  assert.equal(count(w.db, "SELECT COUNT(*) n FROM messages WHERE direction = 'out'"), 1);
  w.done();
});

test("a stale draft cannot be approved", () => {
  const w = world();
  const id = w.kase();
  const v1 = createDraft(w.db, w.store, { caseId: id, domain: "support", text: "Refunding $150.", ruleCitations: ["S-1"], action: refund(15000) });
  createDraft(w.db, w.store, { caseId: id, domain: "support", text: "Refunding $130.", ruleCitations: ["S-1"], action: refund(13000) });
  assert.throws(() => decide(w.db, w.store, v1.draftId, { decision: "approve", draftVersion: 1, rulesVersion: 3 }),
    (e: DraftError) => e.message === "stale_draft" && e.status === 409);
  w.done();
});

test("rules edited after the draft void the approval", () => {
  const w = world();
  const id = w.kase();
  const d = createDraft(w.db, w.store, { caseId: id, domain: "support", text: "Refunding $150.", ruleCitations: ["S-1"], action: refund(15000) });
  w.store.save("support", SUPPORT.replace("over_cents: 12000", "over_cents: 11000"), 3);
  assert.throws(() => decide(w.db, w.store, d.draftId, { decision: "approve", draftVersion: 1, rulesVersion: 3 }),
    (e: DraftError) => e.message === "rules_changed" && e.extra.current_rules_version === 4);
  assert.equal(count(w.db, "SELECT COUNT(*) n FROM outbox"), 0);
  w.done();
});

test("the gate re-runs at send: a cap lowered after approval stops the send", () => {
  const w = world();
  const id = w.kase();
  const d = createDraft(w.db, w.store, { caseId: id, domain: "support", text: "Refunding $150.", ruleCitations: ["S-1"], action: refund(15000) });
  decide(w.db, w.store, d.draftId, { decision: "approve", draftVersion: 1, rulesVersion: 3 });
  w.store.save("support", SUPPORT.replace("max_amount_cents: 20000", "max_amount_cents: 10000"), 3);
  assert.equal(dispatchOutbox(w.db, w.store), 0);
  const ob = w.db.prepare("SELECT state, last_error FROM outbox").get() as { state: string; last_error: string };
  assert.equal(ob.state, "failed");
  assert.match(ob.last_error, /REFUND-CAP/);
  assert.equal((w.db.prepare("SELECT status FROM cases").get() as { status: string }).status, "blocked");
  assert.equal(count(w.db, "SELECT COUNT(*) n FROM messages WHERE direction = 'out'"), 0);
  w.done();
});

test("restart: an approved reply queued before a crash is sent after it", () => {
  const w = world();
  const id = w.kase();
  const d = createDraft(w.db, w.store, { caseId: id, domain: "support", text: "Refunding $150.", ruleCitations: ["S-1"], action: refund(15000) });
  decide(w.db, w.store, d.draftId, { decision: "approve", draftVersion: 1, rulesVersion: 3 });
  w.db.close(); // the crash, before the dispatcher ran
  const db2 = openDb(w.dbPath);
  assert.equal(dispatchOutbox(db2, new RuleStore(w.rules)), 1);
  assert.equal(count(db2, "SELECT COUNT(*) n FROM messages WHERE direction = 'out'"), 1);
  db2.close();
  rmSync(w.dir, { recursive: true, force: true });
});

test("a reply promising more than the validated amount is held, not sent", () => {
  const w = world();
  const id = w.kase();
  const r = createDraft(w.db, w.store, {
    caseId: id, domain: "support", text: "Refunding $50 - actually, call it $180.", ruleCitations: ["S-1"],
    action: refund(5000), route: "auto_reply",
  });
  assert.equal(r.verdict, "review");
  assert.equal(r.status, "held");
  assert.match(r.reasons.join(), /\$180\.00, above the validated \$50\.00/);
  w.done();
});

test("no citation, or an invented one, is held as a rules gap", () => {
  const w = world();
  const none = createDraft(w.db, w.store, { caseId: w.kase("a"), domain: "support", text: "Hi!", ruleCitations: [], route: "auto_reply" });
  assert.equal(none.status, "held");
  const fake = createDraft(w.db, w.store, { caseId: w.kase("b"), domain: "support", text: "Hi!", ruleCitations: ["S-99"], route: "auto_reply" });
  assert.equal(fake.status, "held");
  assert.match(fake.reasons.join(), /S-99/);
  w.done();
});

test("a clean, cited, in-limit reply on auto_reply is queued at once; reject escalates", () => {
  const w = world();
  const ok = createDraft(w.db, w.store, { caseId: w.kase("a"), domain: "support", text: "We open at 7.", ruleCitations: ["S-1"], route: "auto_reply" });
  assert.equal(ok.status, "approved");
  assert.ok(ok.outboxId);
  const held = createDraft(w.db, w.store, { caseId: w.kase("b"), domain: "support", text: "Refunding $150.", ruleCitations: ["S-1"], action: refund(15000) });
  const res = decide(w.db, w.store, held.draftId, { decision: "reject", draftVersion: 1, rulesVersion: 3 });
  assert.equal(res.status, "escalated");
  assert.equal(count(w.db, "SELECT COUNT(*) n FROM outbox"), 1, "only the auto reply");
  w.done();
});

test("an old database gains the new draft columns on open", () => {
  const dir = mkdtempSync(join(tmpdir(), "bizos-mig-"));
  const path = join(dir, "old.db");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE drafts (id TEXT PRIMARY KEY, case_id TEXT NOT NULL, version INTEGER NOT NULL,
    text TEXT NOT NULL, domain TEXT NOT NULL, rules_version INTEGER NOT NULL, rule_citations TEXT NOT NULL DEFAULT '[]',
    amount_cents INTEGER, gate_verdict TEXT, gate_policy_id TEXT, created_at TEXT NOT NULL, UNIQUE (case_id, version))`);
  old.close();
  const db = openDb(path);
  const cols = (db.prepare("PRAGMA table_info(drafts)").all() as { name: string }[]).map((c) => c.name);
  for (const c of ["action_type", "gate_reason", "rules_versions"]) assert.ok(cols.includes(c), c);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("HTTP: the demo path - fixture blocked, review held, approve, sent, stale and changed rules refused", async () => {
  const w = world();
  const server = createApp(w.db, { ...loadConfig({}), rulesDir: w.rules }, w.store);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) => fetch(base + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    const blocked = w.kase("x");
    const fx = await post(`/api/cases/${blocked}/drafts`, {
      domain: "support", text: "Refunding $500.", rule_citations: ["REFUND-CAP"],
      action: { type: "refund", amount_cents: 50000 }, route: "auto_reply",
    });
    assert.equal(fx.status, 201);
    assert.deepEqual((await fx.json() as any).verdict, "block");

    const id = w.kase("y");
    const dr = await (await post(`/api/cases/${id}/drafts`, {
      domain: "support", text: "Refunding $150.", rule_citations: ["REFUND-APPROVAL"], action: { type: "refund", amount_cents: 15000 },
    })).json() as any;
    assert.equal(dr.status, "held");

    const queue = await (await fetch(`${base}/api/approvals`)).json() as any[];
    assert.equal(queue.length, 1);
    assert.equal(queue[0].draft_id, dr.draft_id);

    assert.equal((await post(`/api/approvals/${dr.draft_id}`, { decision: "approve", draft_version: 2, rules_version: 3 })).status, 409);
    assert.equal((await post(`/api/approvals/${dr.draft_id}`, { decision: "maybe", draft_version: 1, rules_version: 3 })).status, 400);

    const ok = await post(`/api/approvals/${dr.draft_id}`, { decision: "approve", draft_version: 1, rules_version: 3 });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json() as any).status, "approved");
    const kase = await (await fetch(`${base}/api/cases/${id}`)).json() as any;
    assert.equal(kase.status, "sent", "dispatched immediately");
    assert.equal(kase.messages.filter((m: any) => m.direction === "out").length, 1);
    assert.deepEqual(await (await fetch(`${base}/api/approvals`)).json(), []);

    const id2 = w.kase("z");
    const d2 = await (await post(`/api/cases/${id2}/drafts`, {
      domain: "support", text: "Refunding $150.", rule_citations: ["S-1"], action: { type: "refund", amount_cents: 15000 },
    })).json() as any;
    w.store.save("support", SUPPORT.replace("over_cents: 12000", "over_cents: 11000"), 3);
    const changed = await post(`/api/approvals/${d2.draft_id}`, { decision: "approve", draft_version: 1, rules_version: 3 });
    assert.equal(changed.status, 409);
    assert.deepEqual(await changed.json(), { error: "rules_changed", current_rules_version: 4 });

    assert.equal((await post(`/api/cases/nope/drafts`, { domain: "support", text: "hi" })).status, 404);
  } finally {
    server.close();
    w.done();
  }
});
