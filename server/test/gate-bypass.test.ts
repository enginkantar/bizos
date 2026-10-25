import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, ingestMessage } from "../src/db.ts";
import { RuleStore } from "../src/rulestore.ts";
import { evaluate } from "../src/gate.ts";
import { createDraft } from "../src/drafts.ts";

// Issue #7, against the shipped dental pack: the two ways a model could walk
// money past the Policy Gate. The action type is model output, so the gate must
// not let the label decide which limits apply.

const store = new RuleStore(join("templates", "dental-office"));
const gate = (type: string, cents: number) => evaluate(store, { domain: "billing", type, amountCents: cents });

function world() {
  const dir = mkdtempSync(join(tmpdir(), "bizos-bypass-"));
  const db = openDb(join(dir, "t.db"));
  let n = 0;
  const kase = () => ingestMessage(db, {
    channel: "webform", sourceMessageId: `m-${++n}`, replyTo: "patient@example.com", text: "refund please",
  }).caseId;
  return { db, kase, done: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("relabel: a $500 refund proposed as store_credit no longer passes", () => {
  assert.equal(gate("refund", 50000).verdict, "block", "named, it is blocked by REFUND-CAP");
  const relabeled = gate("store_credit", 50000);
  assert.equal(relabeled.verdict, "review", "unnamed, it fails closed - before the fix this was pass");
  assert.match(relabeled.reason, /"store_credit" is not an action type any rule names/);
});

test("relabel: no label gets past the unscoped MONEY-CAP backstop", () => {
  // Unnamed labels and labels with no cap of their own hit the backstop...
  for (const type of ["store_credit", "goodwill", "payment_plan", "*"]) {
    const r = gate(type, 600000);
    assert.equal(r.verdict, "block", type);
    assert.equal(r.policyId, "MONEY-CAP", type);
  }
  // ...and a named type with a stricter cap is blocked by that one instead.
  assert.equal(gate("refund", 600000).policyId, "REFUND-CAP");
  // At the cap itself a named plan is only held, as PAYMENT-PLAN-APPROVAL says.
  assert.equal(gate("payment_plan", 500000).policyId, "PAYMENT-PLAN-APPROVAL");
});

test("relabel through the draft path: held at $500, blocked at $6,000, never sent", () => {
  const w = world();
  const small = createDraft(w.db, store, {
    caseId: w.kase(), domain: "billing", text: "I have added $500 store credit to your account.",
    ruleCitations: ["REFUND-CAP"], action: { type: "store_credit", amountCents: 50000 }, route: "auto_reply",
  });
  assert.equal(small.verdict, "review");
  assert.equal(small.status, "held");
  assert.match(small.reasons.join(), /store_credit/);
  const big = createDraft(w.db, store, {
    caseId: w.kase(), domain: "billing", text: "I have added $6,000 store credit to your account.",
    ruleCitations: ["MONEY-CAP"], action: { type: "store_credit", amountCents: 600000 }, route: "auto_reply",
  });
  assert.equal(big.verdict, "block");
  assert.equal(big.policyId, "MONEY-CAP");
  assert.equal(big.status, "blocked");
  const out = w.db.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number };
  assert.equal(out.n, 0, "nothing queued to send");
  w.done();
});

test("split: four $119 refunds ($476) are each held for the owner, and none is sent", () => {
  const w = world();
  for (let i = 0; i < 4; i++) {
    const r = createDraft(w.db, store, {
      caseId: w.kase(), domain: "billing", text: "I have refunded $119 to your card.",
      ruleCitations: ["REFUND-APPROVAL"], action: { type: "refund", amountCents: 11900 }, route: "auto_reply",
    });
    assert.equal(r.status, "held", `split refund ${i + 1}`);
    assert.equal(r.outboxId, null);
  }
  const sent = w.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE direction = 'out'").get() as { n: number };
  assert.equal(sent.n, 0);
  w.done();
});

// The gate still judges each $119 alone: under REFUND-APPROVAL's $120, each one
// passes the gate itself, and only the approval queue stands between a split and
// the customer. Fixing that means a per-customer running total in the policy:
// format - a contract change that needs Engin and Petr (issue #7, option 3).
test.todo("split: refunds to one customer accumulate against REFUND-APPROVAL and REFUND-CAP (#7 option 3)");
