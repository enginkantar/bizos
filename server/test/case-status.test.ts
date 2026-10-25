import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { openDb, ingestMessage } from "../src/db.ts";
import { RuleStore } from "../src/rulestore.ts";
import { createDraft, decide, DraftError } from "../src/drafts.ts";
import { dispatchOutbox } from "../src/outbox.ts";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";

// Issue #27 (high): the newest draft's outcome becomes the case status, and any
// case used to accept a new draft - so an agent's next draft could turn an
// escalated case back into "held", or a case whose reply was queued to send.

const RULES = "---\ndomain: support\nversion: 1\npolicy:\n  REFUND-CAP: { max_amount_cents: 20000, above: block }\n---\n- REFUND-CAP: max $200.\n- S-1: be kind.\n";

function world() {
  const dir = mkdtempSync(join(tmpdir(), "bizos-27-"));
  mkdirSync(join(dir, "business"));
  writeFileSync(join(dir, "business", "support.rules.md"), RULES);
  const db = openDb(join(dir, "t.db"));
  const store = new RuleStore(join(dir, "business"));
  let n = 0;
  const kase = () => ingestMessage(db, {
    channel: "webform", sourceMessageId: `m-${++n}`, replyTo: "patient@example.com", text: "hi",
  }).caseId;
  const draft = (caseId: string, extra: object = {}) =>
    createDraft(db, store, { caseId, domain: "support", text: "We open at 7:30.", ruleCitations: ["S-1"], ...extra });
  const status = (id: string) => (db.prepare("SELECT status FROM cases WHERE id = ?").get(id) as { status: string }).status;
  const drafts = (id: string) => (db.prepare("SELECT COUNT(*) AS n FROM drafts WHERE case_id = ?").get(id) as { n: number }).n;
  return { dir, db, store, kase, draft, status, drafts, done: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const refused = (status: string) => (e: unknown) =>
  e instanceof DraftError && e.status === 409 && e.message === "case_not_draftable" && e.extra.case_status === status;

test("an escalated case refuses a new draft and stays escalated", () => {
  const w = world();
  const id = w.kase();
  const d = w.draft(id);
  decide(w.db, w.store, d.draftId, { decision: "reject", draftVersion: 1, rulesVersion: 1 });
  assert.equal(w.status(id), "escalated");
  // Before the fix this draft was stored and the case went back to "held".
  assert.throws(() => w.draft(id), refused("escalated"));
  assert.equal(w.status(id), "escalated");
  assert.equal(w.drafts(id), 1, "nothing written");
  w.done();
});

test("a human_now escalation also refuses an agent's next draft", () => {
  const w = world();
  const id = w.kase();
  w.draft(id, { route: "human_now" });
  assert.throws(() => w.draft(id), refused("escalated"));
  w.done();
});

test("a case with an approved reply still queued refuses a new draft", () => {
  const w = world();
  const id = w.kase();
  const d = w.draft(id);
  decide(w.db, w.store, d.draftId, { decision: "approve", draftVersion: 1, rulesVersion: 1 });
  assert.equal(w.status(id), "approved", "approved, not yet dispatched");
  assert.throws(() => w.draft(id), refused("approved"));
  assert.equal(w.status(id), "approved");
  w.done();
});

test("a sent case takes a follow-up draft, held for approval", () => {
  const w = world();
  const id = w.kase();
  const d = w.draft(id);
  decide(w.db, w.store, d.draftId, { decision: "approve", draftVersion: 1, rulesVersion: 1 });
  dispatchOutbox(w.db, w.store);
  assert.equal(w.status(id), "sent");
  const follow = w.draft(id, { text: "Just checking you got our hours." });
  assert.equal(follow.version, 2);
  assert.equal(w.status(id), "held");
  w.done();
});

test("held and blocked cases take a new draft (the UI's Recheck)", () => {
  const w = world();
  const held = w.kase();
  w.draft(held);
  assert.equal(w.draft(held).version, 2);
  const blocked = w.kase();
  w.draft(blocked, { action: { type: "refund", amountCents: 50000 } });
  assert.equal(w.status(blocked), "blocked");
  const again = w.draft(blocked, { text: "We can refund $150.", action: { type: "refund", amountCents: 15000 } });
  assert.equal(again.version, 2);
  assert.equal(w.status(blocked), "held");
  w.done();
});

test("HTTP: 409 case_not_draftable names the case status", async () => {
  const w = world();
  const server = createApp(w.db, { ...loadConfig({}), rulesDir: join(w.dir, "business") }, w.store);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const id = w.kase();
    w.draft(id, { route: "human_now" });
    const r = await fetch(`${base}/api/cases/${id}/drafts`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain: "support", text: "Hello again", rule_citations: ["S-1"] }),
    });
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { error: "case_not_draftable", case_status: "escalated" });
  } finally {
    server.close();
    w.done();
  }
});
