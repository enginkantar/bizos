import type { DatabaseSync } from "node:sqlite";
import { audit } from "../db.ts";
import { createDraft, type DraftResult, type Evidence } from "../drafts.ts";
import type { RuleStore } from "../rulestore.ts";
import type { RulesFile } from "../rules.ts";
import type { JsonModel } from "./llm.ts";
import * as P from "./prompts.ts";

// Inbound message -> router (Haiku) -> department drafter (Sonnet) -> createDraft.
// The models only PROPOSE: createDraft runs the citation and quote checks and
// the Policy Gate, and nothing is sent without the owner's approval. When a
// model can't place or answer a message, the case is escalated to a person
// with a holding reply, never guessed (design v1.2 §5.1, DAY_PLAN acceptance).

export interface AgentModels {
  json: JsonModel;
  routerModel: string;
  agentModel: string;
}

export type AgentOutcome =
  | { kind: "drafted"; department: string; draft: DraftResult }
  | { kind: "escalated"; reason: string; draft: DraftResult }
  | { kind: "skipped"; reason: string };

const SHARED = "company";

// The first line of a rules file's IDENTITY section: what the router is told
// each department does.
function identity(f: RulesFile): string {
  const m = /^##\s*IDENTITY\s*\n+([^\n]+)/m.exec(f.body);
  return m ? m[1].trim() : `the ${f.domain} department`;
}

// Action types the rules in force name (applies_to). The drafter is told to
// use these; any other type still fails closed at the gate.
function actionTypes(files: RulesFile[]): string[] {
  return [...new Set(files.flatMap((f) => f.thresholds.flatMap((t) => (t.appliesTo === "*" ? [] : t.appliesTo))))];
}

const isStr = (v: unknown): v is string => typeof v === "string";

// The model's JSON is untrusted until every field has the right shape.
function parseDraft(j: unknown): { reply: string; evidence: Evidence[]; missingInfo: string[]; action?: { type: string; amountCents: number }; route: "draft_for_approval" | "human_now" } | string {
  if (typeof j !== "object" || j === null) return "not an object";
  const o = j as Record<string, unknown>;
  if (!isStr(o.reply) || !o.reply.trim()) return "no reply";
  if (!Array.isArray(o.evidence) || !o.evidence.every((e) => e && isStr(e.rule_id) && e.rule_id.trim() && isStr(e.quote) && e.quote.trim())) return "bad evidence";
  if (!Array.isArray(o.missing_info) || !o.missing_info.every((m) => isStr(m) && m.trim())) return "bad missing_info";
  if (o.route !== "draft_for_approval" && o.route !== "human_now") return "bad route";
  let action: { type: string; amountCents: number } | undefined;
  if (o.action !== null && o.action !== undefined) {
    const a = o.action as Record<string, unknown>;
    if (!isStr(a.type) || !a.type.trim() || !Number.isSafeInteger(a.amount_cents)) return "bad action";
    action = { type: a.type, amountCents: a.amount_cents as number };
  }
  return {
    reply: o.reply,
    evidence: (o.evidence as { rule_id: string; quote: string }[]).map((e) => ({ ruleId: e.rule_id, quote: e.quote })),
    missingInfo: o.missing_info as string[],
    action,
    route: o.route,
  };
}

export async function runAgents(db: DatabaseSync, store: RuleStore, models: AgentModels, caseId: string): Promise<AgentOutcome> {
  const kase = db.prepare("SELECT id, status, customer FROM cases WHERE id = ?").get(caseId) as
    { id: string; status: string; customer: string | null } | undefined;
  if (!kase) return { kind: "skipped", reason: "case_not_found" };
  if (kase.status !== "new") return { kind: "skipped", reason: `case is ${kase.status}, not new` };
  const msg = db.prepare(`SELECT text FROM messages WHERE case_id = ? AND direction = 'in'
                          ORDER BY received_at DESC LIMIT 1`).get(caseId) as { text: string } | undefined;
  if (!msg) return { kind: "skipped", reason: "no inbound message" };

  const company = store.active(SHARED);
  const departments = store.list()
    .filter(({ domain, state }) => domain !== SHARED && state.active)
    .map(({ state }) => state.active!);
  const user = P.customerMessage(msg.text, kase.customer);

  const escalate = (reason: string, domain = SHARED): AgentOutcome => {
    audit(db, "agent_escalated", caseId, { reason });
    const draft = createDraft(db, store, {
      caseId, domain, text: P.HOLDING_REPLY, ruleCitations: [], route: "human_now", notes: [`escalated: ${reason}`],
    });
    return { kind: "escalated", reason, draft };
  };

  if (departments.length === 0) return escalate("no department rules are loaded");

  // 1. Route.
  const names = departments.map((d) => d.domain);
  const routed = await models.json({
    model: models.routerModel,
    system: P.routerSystem(company?.raw ?? "(none)", departments.map((d) => ({ name: d.domain, identity: identity(d) }))),
    user,
    schema: P.routerSchema(names),
    effort: P.ROUTER_EFFORT,
    maxTokens: P.ROUTER_MAX_TOKENS,
  });
  if (!routed.ok) return escalate(`router: ${routed.reason}`);
  const v = routed.json as Record<string, unknown>;
  const department = isStr(v?.department) && names.includes(v.department) ? v.department : null;
  const confidence = typeof v?.confidence === "number" ? v.confidence : 0;
  audit(db, "agent_routed", caseId, {
    model: routed.model, department: v?.department, confidence, urgency: v?.urgency, route: v?.route, reason: v?.reason,
  });
  if (!department) return escalate(`router: no department fits (${isStr(v?.reason) ? v.reason : "no reason"})`);
  if (confidence < P.ROUTER_MIN_CONFIDENCE) return escalate(`router: unsure (${confidence}) it is ${department}`, department);
  // 🔴 An escalation the router is sure about still gets a DRAFTED reply. The
  //    live run showed why: a spreading jaw swelling went to a person with
  //    the generic holding reply, while EMERGENCY-1 says to tell them to call
  //    911 now. The drafter follows the department's escalation rules; the
  //    case still goes to a person (human_now), whatever the drafter routes.
  const routerEscalation = v.route === "human_now"
    ? `router: ${isStr(v.reason) ? v.reason : "needs a person"}`
    : null;
  db.prepare("UPDATE cases SET status = 'routed', domain = ?, updated_at = ? WHERE id = ? AND status = 'new'")
    .run(department, new Date().toISOString(), caseId);

  // 2. Draft.
  const dept = departments.find((d) => d.domain === department)!;
  const drafted = await models.json({
    model: models.agentModel,
    system: P.drafterSystem(department, dept.raw, company?.raw ?? "(none)", actionTypes(company ? [dept, company] : [dept])),
    user,
    schema: P.DRAFT_SCHEMA,
    effort: P.DRAFTER_EFFORT,
    maxTokens: P.DRAFTER_MAX_TOKENS,
  });
  if (!drafted.ok) return escalate(`drafter: ${drafted.reason}`, department);
  const d = parseDraft(drafted.json);
  if (typeof d === "string") return escalate(`drafter: unusable answer (${d})`, department);

  // 3. The model proposes; createDraft decides (citations, quotes, the gate).
  if (routerEscalation) audit(db, "agent_escalated", caseId, { reason: routerEscalation });
  const draft = createDraft(db, store, {
    caseId, domain: department, text: d.reply, ruleCitations: [], evidence: d.evidence,
    missingInfo: d.missingInfo, action: d.action,
    route: routerEscalation ? "human_now" : d.route,
    notes: routerEscalation ? [`escalated: ${routerEscalation}`] : undefined,
  });
  return routerEscalation
    ? { kind: "escalated", reason: routerEscalation, draft }
    : { kind: "drafted", department, draft };
}
