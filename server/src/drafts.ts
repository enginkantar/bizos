import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { audit, type CaseStatus } from "./db.ts";
import { evaluate, formatCents, type Verdict } from "./gate.ts";
import type { RuleStore } from "./rulestore.ts";
import { ruleText, normText, type RulesFile } from "./rules.ts";

// Drafts and approvals: everything between "an agent wrote a reply" and "the
// reply is queued to send" (design v1.2 §3, §6). The order is fixed:
//
//   draft -> Policy Gate -> approval (when required) -> outbox -> send
//
// and nothing reaches a customer that skipped a step.

export type Route = "auto_reply" | "draft_for_approval" | "human_now";

export interface DraftInput {
  caseId: string;
  domain: string;
  text: string;
  ruleCitations: string[];
  // The money the reply commits to, if any: a refund, discount or quote. The
  // amount the gate validates is the only amount the reply may state.
  action?: { type: string; amountCents: number };
  // The orchestrator's routing verdict. Day 1 of the trust ladder is "every
  // answer waits for the owner", so that is the default - and auto_reply is
  // recorded but never sends while auto-send is off (see createDraft).
  route?: Route;
  // The agent's evidence (issue #29): which rule backs which claim, with the
  // rule's own words. Every rule_id also counts as a citation.
  evidence?: Evidence[];
  // What the agent still needs from the customer; the reply asks for it.
  missingInfo?: string[];
}

export interface Evidence {
  ruleId: string;
  quote: string;
}

export interface DraftResult {
  draftId: string;
  version: number;
  verdict: Verdict;
  policyId: string | null;
  reasons: string[];
  status: CaseStatus;
  // Always null: with auto-send off, only an owner's approval queues a send.
  outboxId: null;
}

export class DraftError extends Error {
  status: number;
  extra: Record<string, unknown>;
  constructor(status: number, code: string, extra: Record<string, unknown> = {}) {
    super(code);
    this.status = status;
    this.extra = extra;
  }
}

const rank: Record<Verdict, number> = { pass: 0, review: 1, block: 2 };
const worse = (a: Verdict, b: Verdict) => (rank[b] > rank[a] ? b : a);
const now = () => new Date().toISOString();

// Dollar amounts written in the reply, in cents: "$150", "$1,250.50", "$ 99.9".
// A model asked to refund $150 that writes "we'll send $500" has made a promise
// the gate never checked. Words ("five hundred dollars") are not caught.
export function amountsInText(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g)) {
    const dollars = Number(m[1].replaceAll(",", ""));
    const cents = m[2] ? Number(m[2].padEnd(2, "0")) : 0;
    out.push(dollars * 100 + cents);
  }
  return out;
}

// The rules files in force for a domain - its own and the company's - read
// ONCE, so the citation check and the versions stored on a draft describe the
// same files.
function inForce(store: RuleStore, domain: string): { files: RulesFile[]; versions: Record<string, number> } {
  const files: RulesFile[] = [];
  const versions: Record<string, number> = {};
  const own = store.active(domain);
  if (own) { files.push(own); versions[domain] = own.version; }
  const company = domain === "company" ? undefined : store.active("company");
  if (company) { files.push(company); versions.company = company.version; }
  return { files, versions };
}

// How many times the rules in force define an ID: as a policy: key, or as the
// ID that starts a rule line. A policy key and its prose mirror in the same
// file are one rule. A citation counts only when this is exactly 1 (decision
// 2, Oct 25): a word that merely appears in the file - "the", a heading, the
// domain name - is not a rule, and an ID defined twice is ambiguous.
function definitions(files: RulesFile[], id: string): number {
  return files.reduce((n, f) => {
    const prose = f.ruleIds.filter((r) => r === id).length;
    return n + (f.thresholds.some((t) => t.id === id) ? Math.max(1, prose) : prose);
  }, 0);
}

// The single entry point for a reply: agents call it, and so does the demo's
// labeled "unsafe suggestion" fixture. The model proposes; this decides.
export function createDraft(db: DatabaseSync, store: RuleStore, input: DraftInput): DraftResult {
  const kase = db.prepare("SELECT id, channel, reply_to FROM cases WHERE id = ?").get(input.caseId) as
    { id: string; channel: string; reply_to: string } | undefined;
  if (!kase) throw new DraftError(404, "case_not_found");
  if (!input.text.trim()) throw new DraftError(400, "empty_draft");

  const reasons: string[] = [];
  let verdict: Verdict = "pass";
  let policyId: string | null = null;
  const { files, versions } = inForce(store, input.domain);

  if (input.action) {
    const g = evaluate(store, { domain: input.domain, type: input.action.type, amountCents: input.action.amountCents });
    verdict = g.verdict;
    policyId = g.policyId;
    if (g.verdict !== "pass") reasons.push(g.reason);
    // The gate reads the rules itself. If a file changed in between, the
    // citations were checked against a version the gate did not use.
    if (Object.entries(g.rulesVersions).some(([d, v]) => versions[d] !== v)) {
      verdict = worse(verdict, "review");
      reasons.push("the rules changed while this draft was checked; a person decides");
    }
  } else if (versions[input.domain] === undefined) {
    verdict = "review";
    reasons.push(`no active rules for ${input.domain}; a person decides`);
  }

  // Anything these checks find is held for the owner, never blocked outright:
  // they catch a model's slip, and the owner can see and fix the wording.
  const allowed = input.action?.amountCents ?? -1;
  const over = amountsInText(input.text).filter((c) => c > allowed);
  if (over.length) {
    verdict = worse(verdict, "review");
    reasons.push(input.action
      ? `the reply mentions ${over.map(formatCents).join(", ")}, above the validated ${formatCents(allowed)}`
      : `the reply mentions ${over.map(formatCents).join(", ")} but no amount was validated`);
  }
  // Evidence rule IDs are citations too, so the "real rule, defined once"
  // checks below cover them without a second code path.
  const evidence = input.evidence ?? [];
  const cited = [...new Set([...input.ruleCitations, ...evidence.map((e) => e.ruleId)])];
  if (cited.length === 0) {
    verdict = worse(verdict, "review");
    reasons.push("cites no rule: a rules gap for the owner to fill");
  }
  const unknown = cited.filter((id) => definitions(files, id) === 0);
  if (unknown.length) {
    verdict = worse(verdict, "review");
    reasons.push(`cites rules not in the active version: ${unknown.join(", ")}`);
  }
  const duplicated = cited.filter((id) => definitions(files, id) > 1);
  if (duplicated.length) {
    verdict = worse(verdict, "review");
    reasons.push(`cites rules defined more than once: ${duplicated.join(", ")}`);
  }
  // 🔴 A REAL RULE ID WITH INVENTED CONTENT MUST NOT PASS (issue #29). The
  //    citation check proves the ID exists; this proves the rule says what the
  //    agent claims it says. The quote must appear, word for word (whitespace
  //    and case aside), in the rule the ID starts. IDs already reported as
  //    unknown are not reported twice.
  const misquoted = evidence.filter((e) =>
    definitions(files, e.ruleId) > 0 && !ruleText(files, e.ruleId).includes(normText(e.quote)));
  if (misquoted.length) {
    verdict = worse(verdict, "review");
    reasons.push(`quotes a rule that does not say this: ${misquoted.map((e) => `${e.ruleId} ("${e.quote}")`).join(", ")}`);
  }

  // 🔴 AUTO-SEND IS OFF (Engin, decision 2, Oct 25). Every reply waits for the
  //    owner, whatever the route: a valid citation and a gate pass make a reply
  //    ready to approve, never sent. Turning auto-send back on is a reviewed
  //    change here, not a setting.
  const route = input.route ?? "draft_for_approval";
  if (route === "auto_reply" && verdict === "pass") reasons.push("auto-send is off: every reply waits for the owner");
  const status: CaseStatus =
    verdict === "block" ? "blocked"
    : route === "human_now" ? "escalated"
    : "held";

  db.exec("BEGIN IMMEDIATE");
  try {
    const { v } = db.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS v FROM drafts WHERE case_id = ?")
      .get(kase.id) as { v: number };
    const draftId = randomUUID();
    const t = now();
    const storedEvidence = evidence.map((e) => ({ rule_id: e.ruleId, quote: e.quote }));
    const missingInfo = input.missingInfo ?? [];
    db.prepare(`INSERT INTO drafts (id, case_id, version, text, domain, rules_version, rules_versions,
        rule_citations, amount_cents, action_type, gate_verdict, gate_policy_id, gate_reason,
        evidence, missing_info, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(draftId, kase.id, v, input.text, input.domain, versions[input.domain] ?? 0, JSON.stringify(versions),
        JSON.stringify(cited), input.action?.amountCents ?? null, input.action?.type ?? null,
        verdict, policyId, reasons.join("; ") || null,
        JSON.stringify(storedEvidence), JSON.stringify(missingInfo), t);
    db.prepare("UPDATE cases SET status = ?, domain = ?, updated_at = ? WHERE id = ?").run(status, input.domain, t, kase.id);
    audit(db, "drafted", kase.id, {
      draft_id: draftId, version: v, verdict, policy_id: policyId, reasons, route,
      evidence: storedEvidence, missing_info: missingInfo,
    });
    db.exec("COMMIT");
    return { draftId, version: v, verdict, policyId, reasons, status, outboxId: null };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// One send job per draft version, whatever retries or double-clicks happen:
// the idempotency key is UNIQUE, so a second enqueue finds the first.
function enqueue(db: DatabaseSync, j: { caseId: string; draftId: string; version: number; channel: string; recipient: string; text: string }): string {
  const key = `reply:${j.draftId}:v${j.version}`;
  const t = now();
  db.prepare(`INSERT INTO outbox (id, case_id, draft_id, idempotency_key, channel, recipient, text, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (idempotency_key) DO NOTHING`)
    .run(randomUUID(), j.caseId, j.draftId, key, j.channel, j.recipient, j.text, t, t);
  return (db.prepare("SELECT id FROM outbox WHERE idempotency_key = ?").get(key) as { id: string }).id;
}

interface DraftRow {
  id: string; case_id: string; version: number; text: string; domain: string;
  rules_version: number; rules_versions: string; rule_citations: string;
  amount_cents: number | null; action_type: string | null;
  gate_verdict: Verdict; gate_policy_id: string | null; gate_reason: string | null; created_at: string;
  evidence: string; missing_info: string;
}

// The approval queue: the newest draft of every held case, oldest case first,
// so the owner works through it in the order customers wrote.
export function listApprovals(db: DatabaseSync) {
  const rows = db.prepare(`
    SELECT d.*, c.customer, c.reply_to AS recipient, c.channel
    FROM drafts d JOIN cases c ON c.id = d.case_id
    WHERE c.status = 'held'
      AND d.version = (SELECT MAX(version) FROM drafts WHERE case_id = d.case_id)
    ORDER BY c.created_at`).all() as unknown as (DraftRow & { customer: string | null; recipient: string; channel: string })[];
  return rows.map((r) => ({
    draft_id: r.id, case_id: r.case_id, draft_version: r.version, rules_version: r.rules_version,
    domain: r.domain, customer: r.customer, recipient: r.recipient, channel: r.channel, text: r.text,
    amount_cents: r.amount_cents, rule_citations: JSON.parse(r.rule_citations) as string[],
    gate_verdict: r.gate_verdict, gate_policy_id: r.gate_policy_id, gate_reason: r.gate_reason, created_at: r.created_at,
    // For the approval card: one chip per evidence item, and what the reply asks.
    evidence: JSON.parse(r.evidence) as { rule_id: string; quote: string }[],
    missing_info: JSON.parse(r.missing_info) as string[],
  }));
}

export interface Decision {
  decision: "approve" | "reject";
  draftVersion: number;
  rulesVersion: number;
}

// "Approve reply" - approves SENDING A MESSAGE, never a payment. The approval
// binds to what the owner saw: this draft version, the rules versions it was
// checked against, the case's recipient and channel. If any of those moved,
// it is void and the owner looks again.
export function decide(db: DatabaseSync, store: RuleStore, draftId: string, d: Decision) {
  const draft = db.prepare("SELECT * FROM drafts WHERE id = ?").get(draftId) as DraftRow | undefined;
  if (!draft) throw new DraftError(404, "draft_not_found");
  const kase = db.prepare("SELECT id, status, channel, reply_to FROM cases WHERE id = ?").get(draft.case_id) as
    { id: string; status: CaseStatus; channel: string; reply_to: string };

  // A repeated click returns the first click's result and changes nothing.
  const prior = db.prepare("SELECT decision FROM approvals WHERE draft_id = ? AND draft_version = ?")
    .get(draft.id, draft.version) as { decision: string } | undefined;
  if (prior) {
    const outbox = db.prepare("SELECT id FROM outbox WHERE draft_id = ?").get(draft.id) as { id: string } | undefined;
    return prior.decision === "approved"
      ? { case_id: kase.id, status: "approved" as const, outbox_id: outbox?.id ?? null }
      : { case_id: kase.id, status: "escalated" as const };
  }

  const latest = (db.prepare("SELECT MAX(version) AS v FROM drafts WHERE case_id = ?").get(kase.id) as { v: number }).v;
  if (d.draftVersion !== draft.version || latest !== draft.version) throw new DraftError(409, "stale_draft");
  if (kase.status !== "held") throw new DraftError(409, "not_awaiting_approval", { case_status: kase.status });

  if (d.decision === "approve") {
    // Rules edited since the draft was checked void the approval: the owner
    // approved a reply under rules that are no longer the rules.
    const current = inForce(store, draft.domain).versions;
    if (d.rulesVersion !== draft.rules_version || JSON.stringify(current) !== draft.rules_versions) {
      throw new DraftError(409, "rules_changed", { current_rules_version: current[draft.domain] ?? null });
    }
    if (draft.amount_cents !== null) {
      const g = evaluate(store, { domain: draft.domain, type: draft.action_type ?? "*", amountCents: draft.amount_cents });
      if (g.verdict === "block") throw new DraftError(422, "blocked", { policy_id: g.policyId, reason: g.reason });
    }
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const t = now();
    const decision = d.decision === "approve" ? "approved" : "rejected";
    db.prepare(`INSERT INTO approvals (id, draft_id, draft_version, rules_version, recipient, channel, action_type, decision, decided_at)
                VALUES (?, ?, ?, ?, ?, ?, 'reply', ?, ?)`)
      .run(randomUUID(), draft.id, draft.version, draft.rules_version, kase.reply_to, kase.channel, decision, t);
    const status: CaseStatus = decision === "approved" ? "approved" : "escalated";
    db.prepare("UPDATE cases SET status = ?, updated_at = ? WHERE id = ?").run(status, t, kase.id);
    const outboxId = decision === "approved"
      ? enqueue(db, { caseId: kase.id, draftId: draft.id, version: draft.version, channel: kase.channel, recipient: kase.reply_to, text: draft.text })
      : null;
    audit(db, decision, kase.id, { draft_id: draft.id, version: draft.version, rules_version: draft.rules_version });
    db.exec("COMMIT");
    return outboxId
      ? { case_id: kase.id, status: "approved" as const, outbox_id: outboxId }
      : { case_id: kase.id, status: "escalated" as const };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
