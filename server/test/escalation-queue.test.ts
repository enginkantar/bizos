import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { openDb, ingestMessage } from "../src/db.ts";
import { RuleStore } from "../src/rulestore.ts";
import { createDraft, decide, listApprovals, DraftError } from "../src/drafts.ts";
import { dispatchOutbox } from "../src/outbox.ts";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";

// DAY_PLAN acceptance "unknown request goes to the approval queue, never
// guessed" failed: escalated cases (an emergency, a lawyer, an unknown
// request) were drafted but never in the queue, so the owner could not approve
// the emergency's "call 911 now" reply. Escalations now sit in the queue,
// marked urgent and first. Agreed with Engin, Oct 25.

const RULES = `---
domain: front-desk
version: 1
policy:
  REFUND-CAP: { max_amount_cents: 20000, above: block, applies_to: refund }
---
- EMERGENCY-1: tell them to call 911 or go to an emergency room now.
- KNOW-HOURS: we open at 7:30.
- REFUND-CAP: no refund over $200.
`;

function world() {
  const dir = mkdtempSync(join(tmpdir(), "bizos-escq-"));
  const rules = join(dir, "business");
  mkdirSync(rules);
  writeFileSync(join(rules, "front-desk.rules.md"), RULES);
  const db = openDb(join(dir, "t.db"));
  const store = new RuleStore(rules);
  let n = 0;
  const kase = (text = "hi") => ingestMessage(db, {
    channel: "webform", sourceMessageId: `m-${++n}`, replyTo: "patient@example.com", text,
  }).caseId;
  const status = (id: string) => (db.prepare("SELECT status FROM cases WHERE id = ?").get(id) as { status: string }).status;
  const emergency = () => {
    const id = kase("my jaw swelling is spreading to my eye");
    const d = createDraft(db, store, {
      caseId: id, domain: "front-desk", text: "Please call 911 or go to an emergency room now.",
      ruleCitations: ["EMERGENCY-1"], route: "human_now", notes: ["escalated: router: matches EMERGENCY-1"],
    });
    return { id, d };
  };
  return { dir, rules, db, store, kase, status, emergency, done: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("an escalated case is in the queue, marked urgent, ahead of older held cases", () => {
  const w = world();
  const routine = w.kase("what are your hours?");
  createDraft(w.db, w.store, { caseId: routine, domain: "front-desk", text: "We open at 7:30.", ruleCitations: ["KNOW-HOURS"] });
  const { id } = w.emergency();
  assert.equal(w.status(id), "escalated");
  const q = listApprovals(w.db);
  assert.deepEqual(q.map((a) => [a.case_id, a.case_status, a.urgent]), [
    [id, "escalated", true],
    [routine, "held", false],
  ], "urgent first, though it arrived second");
  w.done();
});

test("the owner approves an escalated reply, and it is sent", () => {
  const w = world();
  const { id, d } = w.emergency();
  // Before the fix: 409 not_awaiting_approval.
  const res = decide(w.db, w.store, d.draftId, { decision: "approve", draftVersion: 1, rulesVersion: 1 });
  assert.equal(res.status, "approved");
  assert.equal(dispatchOutbox(w.db, w.store), 1);
  assert.equal(w.status(id), "sent");
  const out = w.db.prepare("SELECT text FROM messages WHERE case_id = ? AND direction = 'out'").get(id) as { text: string };
  assert.equal(out.text, "Please call 911 or go to an emergency room now.");
  assert.deepEqual(listApprovals(w.db), []);
  w.done();
});

test("rejecting an escalated reply leaves it with the owner, out of the queue for good", () => {
  const w = world();
  const { id, d } = w.emergency();
  const res = decide(w.db, w.store, d.draftId, { decision: "reject", draftVersion: 1, rulesVersion: 1 });
  assert.equal(res.status, "escalated");
  assert.equal(w.status(id), "escalated");
  assert.deepEqual(listApprovals(w.db), [], "a decided draft does not come back");
  assert.equal((w.db.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number }).n, 0);
  w.done();
});

test("an escalated approval is bound like any other: edited rules void it", () => {
  const w = world();
  const { d } = w.emergency();
  w.store.save("front-desk", RULES.replace("we open at 7:30", "we open at 8"), 1);
  assert.throws(() => decide(w.db, w.store, d.draftId, { decision: "approve", draftVersion: 1, rulesVersion: 1 }),
    (e: DraftError) => e.message === "rules_changed");
  w.done();
});

test("a blocked case is still never in the queue and never approvable", () => {
  const w = world();
  const id = w.kase("refund $500");
  const d = createDraft(w.db, w.store, {
    caseId: id, domain: "front-desk", text: "Refunding $500.", ruleCitations: ["REFUND-CAP"],
    action: { type: "refund", amountCents: 50000 }, route: "human_now",
  });
  assert.equal(w.status(id), "blocked", "block beats human_now");
  assert.deepEqual(listApprovals(w.db), []);
  assert.throws(() => decide(w.db, w.store, d.draftId, { decision: "approve", draftVersion: 1, rulesVersion: 1 }),
    (e: DraftError) => e.message === "not_awaiting_approval");
  w.done();
});

test("HTTP: GET /api/approvals carries urgent and case_status; POST approves an escalation", async () => {
  const w = world();
  const { d } = w.emergency();
  const server = createApp(w.db, { ...loadConfig({}), rulesDir: w.rules }, w.store);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const [card] = await (await fetch(`${base}/api/approvals`)).json() as any[];
    assert.equal(card.urgent, true);
    assert.equal(card.case_status, "escalated");
    assert.match(card.gate_reason, /^escalated: router: matches EMERGENCY-1/);
    const r = await fetch(`${base}/api/approvals/${d.draftId}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", draft_version: card.draft_version, rules_version: card.rules_version }),
    });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as any).status, "approved");
  } finally {
    server.close();
    w.done();
  }
});
