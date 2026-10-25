import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { openDb, ingestMessage } from "../src/db.ts";
import { RuleStore } from "../src/rulestore.ts";
import { createDraft, decide, listApprovals } from "../src/drafts.ts";
import { dispatchOutbox } from "../src/outbox.ts";
import { parseRulesFile } from "../src/rules.ts";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";

// Regression suite for decision 2 (Engin, Oct 25): a citation counts only if
// the rule ID is defined exactly once in the rules in force, and no reply is
// sent without the owner's approval. Before this, a draft citing "the" passed
// the citation check and an auto_reply went straight to the customer.

const COMPANY = `---
domain: company
version: 2
policy:
  WRITE-OFF-CAP: { max_amount_cents: 50000, above: block, applies_to: write_off }
---
## HARD RULES
- WRITE-OFF-CAP: no write-off above $500.
- [PRIVACY-1] never discuss a patient's records in chat.
- All of this applies everywhere, especially PRIVACY-1.
## KNOWLEDGE
- KNOW-HOURS: Monday to Friday, 8 to 5.
`;

const SUPPORT = `---
domain: support
version: 3
policy:
  REFUND-CAP:      { max_amount_cents: 20000, above: block, applies_to: refund }
  REFUND-APPROVAL: { over_cents: 12000, action: draft_for_approval, applies_to: refund }
---
## HARD RULES
- REFUND-CAP: never refund more than $200.
- REFUND-APPROVAL: refunds over $120 wait for the owner.
## SOFT RULES
- [S-1] be kind.
- See MENTION-1 in the handbook for the rest.
- DUP-1: the first definition.
- DUP-1: the second definition.
- KNOW-HOURS: a second definition of a company rule.
`;

function world() {
  const dir = mkdtempSync(join(tmpdir(), "bizos-cite-"));
  const rules = join(dir, "business");
  mkdirSync(rules);
  writeFileSync(join(rules, "company.rules.md"), COMPANY);
  writeFileSync(join(rules, "support.rules.md"), SUPPORT);
  const db = openDb(join(dir, "t.db"));
  const store = new RuleStore(rules);
  let n = 0;
  const kase = () => ingestMessage(db, {
    channel: "webform", sourceMessageId: `m-${++n}`, replyTo: "patient@example.com", text: "hello",
  }).caseId;
  return { rules, db, store, kase, done: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const count = (db: DatabaseSync, sql: string) => (db.prepare(sql).get() as { n: number }).n;
const nothingSent = (db: DatabaseSync) => {
  assert.equal(dispatchOutbox(db, new RuleStore("no-such-dir")), 0);
  assert.equal(count(db, "SELECT COUNT(*) n FROM outbox"), 0, "nothing queued");
  assert.equal(count(db, "SELECT COUNT(*) n FROM messages WHERE direction = 'out'"), 0, "nothing sent");
};

test("only the ID that starts a rule line is a definition, in either spelling", () => {
  const f = parseRulesFile(SUPPORT, "support");
  assert.deepEqual(f.ruleIds, ["REFUND-CAP", "REFUND-APPROVAL", "S-1", "DUP-1", "DUP-1", "KNOW-HOURS"]);
  assert.deepEqual(parseRulesFile(COMPANY, "company").ruleIds, ["WRITE-OFF-CAP", "PRIVACY-1", "KNOW-HOURS"],
    "PRIVACY-1 mentioned inside a sentence is not a second definition");
});

test('citing "the" - or any word that merely appears in the file - holds the reply, even on auto_reply', () => {
  const w = world();
  for (const word of ["the", "HARD", "RULES", "support", "version", "policy", "refund", "MENTION-1", "refund-cap"]) {
    const r = createDraft(w.db, w.store, {
      caseId: w.kase(), domain: "support", text: "We open at 8.", ruleCitations: [word], route: "auto_reply",
    });
    assert.equal(r.status, "held", word);
    assert.equal(r.verdict, "review", word);
    assert.match(r.reasons.join(), new RegExp(`cites rules not in the active version: ${word}`), word);
  }
  nothingSent(w.db);
  w.done();
});

test("an unknown ID, or no citation at all, holds the reply", () => {
  const w = world();
  const fake = createDraft(w.db, w.store, { caseId: w.kase(), domain: "support", text: "Hi!", ruleCitations: ["S-99"], route: "auto_reply" });
  assert.equal(fake.status, "held");
  const none = createDraft(w.db, w.store, { caseId: w.kase(), domain: "support", text: "Hi!", ruleCitations: [], route: "auto_reply" });
  assert.equal(none.status, "held");
  assert.match(none.reasons.join(), /cites no rule/);
  nothingSent(w.db);
  w.done();
});

test("an ID defined twice - in one file, or in a department and company - is not a valid citation", () => {
  const w = world();
  const twice = createDraft(w.db, w.store, { caseId: w.kase(), domain: "support", text: "Hi!", ruleCitations: ["DUP-1"], route: "auto_reply" });
  assert.equal(twice.status, "held");
  assert.match(twice.reasons.join(), /cites rules defined more than once: DUP-1/);
  const across = createDraft(w.db, w.store, { caseId: w.kase(), domain: "support", text: "Hi!", ruleCitations: ["KNOW-HOURS"], route: "auto_reply" });
  assert.equal(across.status, "held");
  assert.match(across.reasons.join(), /defined more than once: KNOW-HOURS/);
  // In the company's own scope it is defined once, so it is a real rule there.
  const own = createDraft(w.db, w.store, { caseId: w.kase(), domain: "company", text: "Hi!", ruleCitations: ["KNOW-HOURS"] });
  assert.doesNotMatch(own.reasons.join(), /cites/);
  nothingSent(w.db);
  w.done();
});

test("real rule IDs are accepted: a policy key with its prose mirror, a bracketed prose ID, a company rule", () => {
  const w = world();
  const r = createDraft(w.db, w.store, {
    caseId: w.kase(), domain: "support", text: "I can refund $150.",
    ruleCitations: ["REFUND-APPROVAL", "S-1", "PRIVACY-1", "WRITE-OFF-CAP"], action: { type: "refund", amountCents: 15000 },
  });
  assert.doesNotMatch(r.reasons.join(), /cites/, "no citation problem");
  assert.equal(r.policyId, "REFUND-APPROVAL", "held by the gate, not by the citation check");
  w.done();
});

test("a valid citation and a gate pass never send on their own: auto_reply waits for the owner", () => {
  const w = world();
  const id = w.kase();
  const r = createDraft(w.db, w.store, { caseId: id, domain: "support", text: "We open at 8.", ruleCitations: ["S-1"], route: "auto_reply" });
  assert.equal(r.verdict, "pass");
  assert.equal(r.status, "held");
  assert.equal(r.outboxId, null);
  assert.match(r.reasons.join(), /auto-send is off/);
  nothingSent(w.db);

  // The owner's approval is the only way out, and it sends exactly once.
  const q = listApprovals(w.db);
  assert.equal(q.length, 1);
  assert.equal(q[0].draft_id, r.draftId);
  assert.equal(decide(w.db, w.store, r.draftId, { decision: "approve", draftVersion: 1, rulesVersion: 3 }).status, "approved");
  assert.equal(dispatchOutbox(w.db, w.store), 1);
  assert.equal(count(w.db, "SELECT COUNT(*) n FROM messages WHERE direction = 'out'"), 1);
  w.done();
});

test("issue #7 reproductions never reach a customer: split refunds and a relabeled type wait for the owner", () => {
  // Both bypasses in #7 needed auto_reply. With auto-send off they end held,
  // not sent; the gate-side fixes are separate.
  const w = world();
  for (let i = 0; i < 4; i++) {
    const split = createDraft(w.db, w.store, {
      caseId: w.kase(), domain: "support", text: "Refunding $119.", ruleCitations: ["REFUND-APPROVAL"],
      action: { type: "refund", amountCents: 11900 }, route: "auto_reply",
    });
    assert.equal(split.status, "held", `split refund ${i + 1}`);
  }
  const relabel = createDraft(w.db, w.store, {
    caseId: w.kase(), domain: "support", text: "Here is $500 in store credit.", ruleCitations: ["REFUND-CAP"],
    action: { type: "store_credit", amountCents: 50000 }, route: "auto_reply",
  });
  assert.equal(relabel.status, "held");
  assert.equal(listApprovals(w.db).length, 5, "all five wait for the owner");
  nothingSent(w.db);
  w.done();
});

test("a held draft for a department with no rules file of its own can still be approved", () => {
  // The gate holds it ("a person decides"); the stored rules versions must
  // match what decide() compares, or the owner could never approve it.
  const w = world();
  const r = createDraft(w.db, w.store, {
    caseId: w.kase(), domain: "sales", text: "A $30 courtesy discount.", ruleCitations: ["PRIVACY-1"],
    action: { type: "discount", amountCents: 3000 },
  });
  assert.equal(r.status, "held");
  const res = decide(w.db, w.store, r.draftId, { decision: "approve", draftVersion: 1, rulesVersion: 0 });
  assert.equal(res.status, "approved");
  w.done();
});

test('HTTP: a draft citing "the" with route auto_reply is held, queued for the owner, and never sent', async () => {
  const w = world();
  const server = createApp(w.db, { ...loadConfig({}), rulesDir: w.rules }, w.store);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const id = w.kase();
    const res = await fetch(`${base}/api/cases/${id}/drafts`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain: "support", text: "We open at 8.", rule_citations: ["the"], route: "auto_reply" }),
    });
    assert.equal(res.status, 201);
    const body = await res.json() as any;
    assert.equal(body.status, "held");
    assert.equal(body.outbox_id, null);
    const queue = await (await fetch(`${base}/api/approvals`)).json() as any[];
    assert.deepEqual(queue.map((q) => q.draft_id), [body.draft_id]);
    const kase = await (await fetch(`${base}/api/cases/${id}`)).json() as any;
    assert.equal(kase.status, "held");
    assert.equal(kase.messages.filter((m: any) => m.direction === "out").length, 0);
    assert.equal(kase.outbox.length, 0);
  } finally {
    server.close();
    w.done();
  }
});
