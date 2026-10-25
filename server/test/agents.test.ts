import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, copyFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { openDb, ingestMessage } from "../src/db.ts";
import { RuleStore } from "../src/rulestore.ts";
import { createDraft } from "../src/drafts.ts";
import { runAgents, resumeAgents, type AgentModels } from "../src/agents/pipeline.ts";
import type { JsonRequest, JsonResult } from "../src/agents/llm.ts";
import { HOLDING_REPLY } from "../src/agents/prompts.ts";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";

// The agent pipeline with a scripted model: no network, no key. The real
// dental pack and the real createDraft decide what happens to each answer.

const ROUTER = "test-router", DRAFTER = "test-drafter";

function fakeModels(script: { router?: JsonResult | (() => Promise<JsonResult>); drafter?: JsonResult }) {
  const calls: JsonRequest[] = [];
  const models: AgentModels = {
    routerModel: ROUTER,
    agentModel: DRAFTER,
    json: async (req) => {
      calls.push(req);
      const r = req.model === ROUTER ? script.router : script.drafter;
      if (typeof r === "function") return r();
      if (!r) throw new Error(`no scripted answer for ${req.model}`);
      return r;
    },
  };
  return { models, calls };
}

const routeTo = (department: string, extra: object = {}): JsonResult =>
  ({ ok: true, model: ROUTER, json: { department, confidence: 0.95, urgency: "normal", route: "draft_for_approval", reason: "fits", ...extra } });
const draftAnswer = (extra: object = {}): JsonResult =>
  ({ ok: true, model: DRAFTER, json: { reply: "Yes, we see children from age 3. Which days suit you?", evidence: [{ rule_id: "KNOW-CHILDREN", quote: "we see children from age 3" }], missing_info: ["preferred days"], action: null, route: "draft_for_approval", ...extra } });

function world() {
  const dir = mkdtempSync(join(tmpdir(), "bizos-agents-"));
  const rules = join(dir, "business");
  mkdirSync(rules);
  for (const f of readdirSync(join("templates", "dental-office"))) copyFileSync(join("templates", "dental-office", f), join(rules, f));
  const db = openDb(join(dir, "t.db"));
  const store = new RuleStore(rules);
  let n = 0;
  const kase = (text = "Do you see kids?") => ingestMessage(db, {
    channel: "webform", sourceMessageId: `m-${++n}`, replyTo: "parent@example.com", text, customer: "Sam",
  }).caseId;
  const row = (id: string) => db.prepare("SELECT status, domain FROM cases WHERE id = ?").get(id) as { status: string; domain: string };
  const lastDraft = (id: string) => db.prepare("SELECT * FROM drafts WHERE case_id = ? ORDER BY version DESC LIMIT 1").get(id) as Record<string, any>;
  return { dir, rules, db, store, kase, row, lastDraft, done: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("a front-desk question: routed, drafted with evidence, held for the owner", async () => {
  const w = world();
  const { models, calls } = fakeModels({ router: routeTo("front-desk"), drafter: draftAnswer() });
  const id = w.kase();
  const out = await runAgents(w.db, w.store, models, id);
  assert.equal(out.kind, "drafted");
  assert.equal(w.row(id).status, "held");
  assert.equal(w.row(id).domain, "front-desk");
  const d = w.lastDraft(id);
  assert.equal(d.gate_verdict, "pass", d.gate_reason);
  assert.deepEqual(JSON.parse(d.evidence), [{ rule_id: "KNOW-CHILDREN", quote: "we see children from age 3" }]);
  assert.deepEqual(JSON.parse(d.rule_citations), ["KNOW-CHILDREN"]);
  assert.deepEqual(JSON.parse(d.missing_info), ["preferred days"]);

  // What the models were actually asked.
  const [router, drafter] = calls;
  assert.equal(router.model, ROUTER);
  assert.equal(router.effort, "low");
  assert.deepEqual((router.schema as any).properties.department.enum, ["billing", "front-desk", "unknown"], "company is not a department");
  assert.match(router.user, /<customer_message>\nDo you see kids\?\n<\/customer_message>/);
  assert.equal(drafter.model, DRAFTER);
  assert.match(drafter.system, /KNOW-CHILDREN: we see children from age 3/, "the department's rules");
  assert.match(drafter.system, /PRIVACY-1/, "the company's rules");
  assert.match(drafter.system, /refund|fee_waiver/, "the action types the rules name");
  w.done();
});

test("the $500 refund a model proposes is blocked by the gate, not the prompt", async () => {
  const w = world();
  const { models } = fakeModels({
    router: routeTo("billing"),
    drafter: draftAnswer({ reply: "Sure, refunding $500 now.", evidence: [{ rule_id: "REFUND-CAP", quote: "never refund more than $200" }], action: { type: "refund", amount_cents: 50000 } }),
  });
  const id = w.kase("Refund my $500 now");
  await runAgents(w.db, w.store, models, id);
  assert.equal(w.row(id).status, "blocked");
  assert.equal(w.lastDraft(id).gate_policy_id, "REFUND-CAP");
  w.done();
});

test("a model relabelling the refund as store credit is still held", async () => {
  const w = world();
  const { models } = fakeModels({
    router: routeTo("billing"),
    drafter: draftAnswer({ reply: "I added $500 store credit.", evidence: [{ rule_id: "REFUND-CAP", quote: "never refund more than $200" }], action: { type: "store_credit", amount_cents: 50000 } }),
  });
  const id = w.kase();
  await runAgents(w.db, w.store, models, id);
  assert.equal(w.row(id).status, "held");
  assert.match(w.lastDraft(id).gate_reason, /store_credit/);
  w.done();
});

test("an invented quote from the model is held with the reason", async () => {
  const w = world();
  const { models } = fakeModels({ router: routeTo("front-desk"), drafter: draftAnswer({ evidence: [{ rule_id: "KNOW-CHILDREN", quote: "we see children from age 1" }] }) });
  const id = w.kase();
  await runAgents(w.db, w.store, models, id);
  assert.equal(w.row(id).status, "held");
  assert.match(w.lastDraft(id).gate_reason, /quotes a rule that does not say this/);
  w.done();
});

for (const [name, router, expectDomain] of [
  ["no department fits", routeTo("unknown"), "company"],
  ["the router is unsure", routeTo("billing", { confidence: 0.4 }), "billing"],
  ["the router declines", { ok: false, reason: "the model declined (cyber)" } as JsonResult, "company"],
] as const) {
  test(`${name}: escalated with a holding reply, nothing drafted by a model`, async () => {
    const w = world();
    const { models, calls } = fakeModels({ router });
    const id = w.kase();
    const out = await runAgents(w.db, w.store, models, id);
    assert.equal(out.kind, "escalated");
    assert.equal(w.row(id).status, "escalated");
    assert.equal(w.lastDraft(id).text, HOLDING_REPLY);
    assert.equal(w.lastDraft(id).domain, expectDomain);
    assert.equal(calls.length, 1, "the drafter was never called");
    // The reason says why it went to a person - not "rules gap", which would
    // mislabel it on the owner's screen.
    assert.match(w.lastDraft(id).gate_reason, /^escalated: router: /);
    assert.doesNotMatch(w.lastDraft(id).gate_reason, /rules gap/);
    w.done();
  });
}

test("an escalation trigger the router is sure of still gets a drafted reply, and goes to a person", async () => {
  // Found live: an emergency got the generic holding reply instead of
  // EMERGENCY-1's "call 911 now", because escalation skipped the drafter.
  const w = world();
  const emergencyReply = "Please call 911 or go to an emergency room now. Then call us for a same-day emergency appointment.";
  const { models, calls } = fakeModels({
    router: routeTo("front-desk", { urgency: "critical", route: "human_now", reason: "matches EMERGENCY-1" }),
    // Even if the drafter says draft_for_approval, the router's escalation wins.
    drafter: draftAnswer({ reply: emergencyReply, evidence: [{ rule_id: "EMERGENCY-1", quote: "call 911 or go to an emergency room now" }], missing_info: [] }),
  });
  const id = w.kase("My jaw is swollen and it's spreading to my eye");
  const out = await runAgents(w.db, w.store, models, id);
  assert.equal(out.kind, "escalated");
  assert.equal(calls.length, 2, "the drafter ran");
  assert.equal(w.row(id).status, "escalated");
  const d = w.lastDraft(id);
  assert.equal(d.text, emergencyReply);
  assert.match(d.gate_reason, /^escalated: router: matches EMERGENCY-1/);
  assert.deepEqual(JSON.parse(d.rule_citations), ["EMERGENCY-1"]);
  w.done();
});

test("an unusable drafter answer escalates instead of drafting", async () => {
  const w = world();
  for (const drafter of [
    { ok: false, reason: "the model ran out of tokens" } as JsonResult,
    draftAnswer({ evidence: "KNOW-CHILDREN" }),
    draftAnswer({ action: { type: "refund", amount_cents: 12.5 } }),
    draftAnswer({ reply: "" }),
  ]) {
    const { models } = fakeModels({ router: routeTo("front-desk"), drafter });
    const id = w.kase();
    const out = await runAgents(w.db, w.store, models, id);
    assert.equal(out.kind, "escalated", JSON.stringify(drafter));
    assert.equal(w.row(id).status, "escalated");
  }
  w.done();
});

for (const when of ["router", "drafter"] as const) {
  test(`a draft posted while the ${when} is thinking wins; the agents step aside`, async () => {
    // Found in the acceptance run: the UI's $500 demo draft was blocked, then
    // the agents' own draft replaced it as v2 seconds later.
    const w = world();
    const id = w.kase("Refund my $500 now");
    const postFixture = () => createDraft(w.db, w.store, {
      caseId: id, domain: "billing", text: "Sure, refunding $500 now.", ruleCitations: ["REFUND-CAP"],
      action: { type: "refund", amountCents: 50000 }, route: "auto_reply",
    });
    const { models } = fakeModels({
      router: async () => { if (when === "router") postFixture(); return routeTo("billing"); },
      drafter: draftAnswer({ reply: "We can look into a refund.", evidence: [{ rule_id: "REFUND-CAP", quote: "never refund more than $200" }] }),
    });
    if (when === "drafter") {
      const json = models.json;
      models.json = async (req) => { if (req.model === DRAFTER) postFixture(); return json(req); };
    }
    const out = await runAgents(w.db, w.store, models, id);
    assert.deepEqual(out, { kind: "skipped", reason: "a draft was posted while the agents ran" });
    assert.equal(w.row(id).status, "blocked", "the $500 block stays on screen");
    assert.equal((w.db.prepare("SELECT COUNT(*) AS n FROM drafts WHERE case_id = ?").get(id) as { n: number }).n, 1);
    w.done();
  });
}

test("after a restart, cases left new by a cut-off agent run are drafted again", async () => {
  // Found in the acceptance run: the server killed mid-call left the case
  // `new` forever; only a manual POST /agent recovered it.
  const w = world();
  const cutOff = w.kase();
  const drafted = w.kase();
  createDraft(w.db, w.store, { caseId: drafted, domain: "front-desk", text: "We open at 7:30.", ruleCitations: ["KNOW-HOURS"] });
  const old = w.kase();
  w.db.prepare("UPDATE cases SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 48 * 3_600_000).toISOString(), old);
  const { models, calls } = fakeModels({ router: routeTo("front-desk"), drafter: draftAnswer() });
  const lines: string[] = [];
  const n = await resumeAgents(w.db, w.store, models, { log: { log: (m: string) => lines.push(m), error: (m: string) => lines.push(m) } });
  assert.equal(n, 1, "only the recent, undrafted, new case");
  assert.equal(w.row(cutOff).status, "held");
  assert.equal(w.row(old).status, "new", "a two-day-old case is left for the owner");
  assert.equal(calls.length, 2, "one router and one drafter call");
  assert.deepEqual(lines, ["agents: resuming 1 case(s) left new by a restart"]);
  w.done();
});

test("only a new case is drafted by the agents", async () => {
  const w = world();
  const { models, calls } = fakeModels({ router: routeTo("front-desk"), drafter: draftAnswer() });
  const id = w.kase();
  await runAgents(w.db, w.store, models, id);
  const again = await runAgents(w.db, w.store, models, id);
  assert.deepEqual(again, { kind: "skipped", reason: "case is held, not new" });
  assert.equal(calls.length, 2, "no second round of model calls");
  w.done();
});

test("HTTP: the inbox runs the agents after answering; a failed call keeps the case and can be re-run", async () => {
  const w = world();
  let fail = true;
  const { models } = fakeModels({
    router: async () => { if (fail) throw new Error("connection reset"); return routeTo("front-desk"); },
    drafter: draftAnswer(),
  });
  const server = createApp(w.db, { ...loadConfig({}), rulesDir: w.rules }, w.store, models);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body?: unknown) => fetch(base + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}),
  });
  const settle = () => new Promise((r) => setTimeout(r, 50));
  try {
    const envelope = { message_id: "w-1", source: "webform", reply_to: "parent@example.com", content: { text: "Do you see kids?" } };
    const r = await post("/api/inbox", envelope);
    assert.equal(r.status, 201, "the channel is answered before the models run");
    const { case_id } = await r.json() as { case_id: string };
    await settle();
    assert.equal(w.row(case_id).status, "new", "a failed model call loses nothing");
    const audit = await (await fetch(`${base}/api/audit`)).json() as { event: string; detail: string }[];
    assert.match(audit.find((a) => a.event === "agent_failed")!.detail, /connection reset/);

    fail = false;
    const rerun = await post(`/api/cases/${case_id}/agent`);
    assert.equal(rerun.status, 200);
    const body = await rerun.json() as any;
    assert.equal(body.outcome, "drafted");
    assert.equal(body.department, "front-desk");
    assert.equal(body.draft.status, "held");

    assert.equal((await post("/api/inbox", envelope)).status, 200, "a duplicate does not run the agents again");
  } finally {
    server.close();
    w.done();
  }
});

test("HTTP: without agents the server works as before and says agents are off", async () => {
  const w = world();
  const server = createApp(w.db, { ...loadConfig({}), rulesDir: w.rules }, w.store);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const id = w.kase();
    const r = await fetch(`${base}/api/cases/${id}/agent`, { method: "POST" });
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { error: "agents_off" });
    assert.equal(w.row(id).status, "new");
  } finally {
    server.close();
    w.done();
  }
});
