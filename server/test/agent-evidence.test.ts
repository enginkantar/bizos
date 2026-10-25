import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { openDb, ingestMessage } from "../src/db.ts";
import { RuleStore } from "../src/rulestore.ts";
import { createDraft, type Evidence } from "../src/drafts.ts";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";

// Issue #29: agents return one reply plus evidence - the rule ID and the rule's
// own words. A real ID with invented content must not pass. Run against the
// shipped dental pack.

function world() {
  const dir = mkdtempSync(join(tmpdir(), "bizos-29-"));
  const rules = join(dir, "business");
  mkdirSync(rules);
  for (const f of readdirSync(join("templates", "dental-office"))) {
    copyFileSync(join("templates", "dental-office", f), join(rules, f));
  }
  const db = openDb(join(dir, "t.db"));
  const store = new RuleStore(rules);
  let n = 0;
  const kase = () => ingestMessage(db, {
    channel: "webform", sourceMessageId: `m-${++n}`, replyTo: "parent@example.com", text: "Do you see kids?",
  }).caseId;
  const draft = (evidence: Evidence[], extra: Partial<Parameters<typeof createDraft>[2]> = {}) => createDraft(db, store, {
    caseId: kase(), domain: "front-desk", text: "Yes, we see children from age 3. Which days suit you?",
    ruleCitations: [], evidence, ...extra,
  });
  return { dir, rules, db, store, draft, done: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const misquoteReason = (reasons: string[]) => reasons.find((r) => r.startsWith("quotes a rule that does not say this"));

test("an exact quote passes, and its rule ID becomes the citation", () => {
  const w = world();
  const r = w.draft([{ ruleId: "KNOW-CHILDREN", quote: "we see children from age 3" }]);
  assert.equal(r.verdict, "pass", r.reasons.join("; "));
  assert.equal(misquoteReason(r.reasons), undefined);
  const row = w.db.prepare("SELECT rule_citations, evidence FROM drafts").get() as { rule_citations: string; evidence: string };
  assert.deepEqual(JSON.parse(row.rule_citations), ["KNOW-CHILDREN"], "no rule_citations sent; evidence supplied them");
  assert.deepEqual(JSON.parse(row.evidence), [{ rule_id: "KNOW-CHILDREN", quote: "we see children from age 3" }]);
  w.done();
});

test("a company rule quoted from another department, across a line wrap, passes", () => {
  const w = world();
  // PRIVACY-1 lives in company.rules.md and wraps "Ask them to call\n  the office".
  const r = w.draft([{ ruleId: "PRIVACY-1", quote: "Ask them to call the office or use the patient portal" }]);
  assert.equal(misquoteReason(r.reasons), undefined, r.reasons.join("; "));
  w.done();
});

test("case and spacing do not matter; words do", () => {
  const w = world();
  assert.equal(misquoteReason(w.draft([{ ruleId: "KNOW-CHILDREN", quote: "We see  Children\nfrom age 3" }]).reasons), undefined);
  w.done();
});

test("an invented quote under a real rule ID is held", () => {
  const w = world();
  const r = w.draft([{ ruleId: "KNOW-CHILDREN", quote: "we see children from age 1" }]);
  assert.equal(r.verdict, "review");
  assert.equal(r.status, "held");
  assert.match(misquoteReason(r.reasons)!, /KNOW-CHILDREN \("we see children from age 1"\)/);
  w.done();
});

test("a true quote pinned to the wrong rule is held", () => {
  const w = world();
  const r = w.draft([
    { ruleId: "KNOW-CHILDREN", quote: "we see children from age 3" },
    { ruleId: "KNOW-PARKING", quote: "we see children from age 3" },
  ]);
  assert.equal(r.verdict, "review");
  assert.match(misquoteReason(r.reasons)!, /KNOW-PARKING/);
  assert.doesNotMatch(misquoteReason(r.reasons)!, /KNOW-CHILDREN/);
  w.done();
});

test("an unknown rule ID in evidence is reported once, as unknown", () => {
  const w = world();
  const r = w.draft([{ ruleId: "KNOW-PETS", quote: "we welcome service animals" }]);
  assert.equal(r.verdict, "review");
  assert.ok(r.reasons.some((x) => x === "cites rules not in the active version: KNOW-PETS"), r.reasons.join("; "));
  assert.equal(misquoteReason(r.reasons), undefined);
  w.done();
});

test("an old database gains the evidence columns on open", () => {
  const dir = mkdtempSync(join(tmpdir(), "bizos-29-mig-"));
  const path = join(dir, "old.db");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE drafts (id TEXT PRIMARY KEY, case_id TEXT NOT NULL, version INTEGER NOT NULL,
    text TEXT NOT NULL, domain TEXT NOT NULL, rules_version INTEGER NOT NULL, rule_citations TEXT NOT NULL DEFAULT '[]',
    amount_cents INTEGER, gate_verdict TEXT, gate_policy_id TEXT, created_at TEXT NOT NULL, UNIQUE (case_id, version))`);
  old.close();
  const db = openDb(path);
  const cols = (db.prepare("PRAGMA table_info(drafts)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes("evidence") && cols.includes("missing_info"), cols.join(","));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("HTTP: the agent's own JSON goes in, and the approval card gets evidence and missing info", async () => {
  const w = world();
  const server = createApp(w.db, { ...loadConfig({}), rulesDir: w.rules }, w.store);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) => fetch(base + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    const { case_id } = await (await post("/api/inbox", {
      message_id: "w-1", source: "webform", reply_to: "parent@example.com", content: { text: "Do you see kids?" },
    })).json() as { case_id: string };

    // Exactly the shape in #29: reply, evidence, missing_info, action, route.
    const agentOutput = {
      domain: "front-desk",
      reply: "Yes, we see children from age 3. Would you like us to book a first visit?",
      evidence: [{ rule_id: "KNOW-CHILDREN", quote: "we see children from age 3" }],
      missing_info: ["preferred days and times"],
      action: null,
      route: "draft_for_approval",
    };
    const res = await post(`/api/cases/${case_id}/drafts`, agentOutput);
    assert.equal(res.status, 201);
    const d = await res.json() as { verdict: string; status: string };
    assert.deepEqual([d.verdict, d.status], ["pass", "held"]);

    const [card] = await (await fetch(`${base}/api/approvals`)).json() as any[];
    assert.deepEqual(card.evidence, agentOutput.evidence);
    assert.deepEqual(card.missing_info, ["preferred days and times"]);
    assert.deepEqual(card.rule_citations, ["KNOW-CHILDREN"]);
    assert.equal(card.text, agentOutput.reply);

    const kase = await (await fetch(`${base}/api/cases/${case_id}`)).json() as any;
    assert.deepEqual(JSON.parse(kase.drafts[0].evidence), agentOutput.evidence);
    assert.deepEqual(JSON.parse(kase.drafts[0].missing_info), ["preferred days and times"]);

    const auditRows = await (await fetch(`${base}/api/audit`)).json() as any[];
    const drafted = JSON.parse(auditRows.find((a) => a.event === "drafted").detail);
    assert.deepEqual(drafted.evidence, agentOutput.evidence, "the evidence is in the audit trail");

    for (const bad of [
      { evidence: [{ rule_id: "KNOW-CHILDREN" }] },
      { evidence: [{ rule_id: "", quote: "x" }] },
      { evidence: "KNOW-CHILDREN" },
      { missing_info: [""] },
      { missing_info: "days" },
    ]) {
      const r = await post(`/api/cases/${case_id}/drafts`, { domain: "front-desk", reply: "Hi", ...bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
  } finally {
    server.close();
    w.done();
  }
});
