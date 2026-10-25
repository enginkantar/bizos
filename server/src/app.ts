import { createServer, type Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { Router, HttpError, type Reply } from "./http.ts";
import { ingestMessage, audit } from "./db.ts";
import type { Config } from "./config.ts";
import { RuleStore, ConflictError, type DomainState } from "./rulestore.ts";
import { RulesError, type RulesFile } from "./rules.ts";
import { lineDiff, changesOnly } from "./diff.ts";
import { createDraft, listApprovals, decide, DraftError, type Route } from "./drafts.ts";
import { dispatchOutbox } from "./outbox.ts";

// The routes frozen at 11:00 (DAY_PLAN.md), plus POST /api/cases/:id/drafts,
// the one door every proposed reply comes through. docs/API.md documents each.

function str(v: unknown, field: string, required = true): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, `missing_${field}`);
    return undefined;
  }
  if (typeof v !== "string") throw new HttpError(400, `invalid_${field}`);
  return v;
}

// The channel-agnostic envelope (design v1.2 §4). `source_message_id` is the
// channel's own id for the message, the key the duplicate check uses; it falls
// back to `message_id` for senders that only provide one.
function parseInbound(body: unknown) {
  if (typeof body !== "object" || body === null) throw new HttpError(400, "expected_json_object");
  const b = body as Record<string, any>;
  const channel = str(b.source, "source")!;
  const sourceMessageId = str(b.source_message_id ?? b.message_id, "source_message_id")!;
  const replyTo = str(b.reply_to, "reply_to")!;
  const text = str(b.content?.text, "content.text")!;
  const customer = typeof b.customer?.name === "string" ? b.customer.name : undefined;
  const receivedAt = str(b.received_at, "received_at", false);
  return { channel, sourceMessageId, replyTo, text, customer, receivedAt };
}

// What the UI and the agents see of one rules file. `policy` is the compiled
// view of the policy: block - the exact thresholds the gate enforces - so the
// screen shows what is enforced, not a re-reading of the YAML.
function describe(domain: string, s: DomainState) {
  const f: RulesFile | undefined = s.active;
  return {
    domain,
    version: f?.version ?? null,
    policy: f?.thresholds.map((t) => ({
      id: t.id, limit_cents: t.limitCents, outcome: t.outcome, applies_to: t.appliesTo,
    })) ?? [],
    warnings: f?.warnings ?? [],
    // Present while the file on disk is broken; `version` is then the last good one.
    error: s.error ?? null,
  };
}

export function createApp(db: DatabaseSync, config: Config, store = new RuleStore(config.rulesDir)): Server {
  const r = new Router();

  r.on("GET", "/api/health", () => ({
    status: 200,
    body: { ok: true, api_key_configured: Boolean(config.anthropicApiKey) },
  }));

  r.on("POST", "/api/inbox", (_req, _p, body) => {
    const { caseId, duplicate } = ingestMessage(db, parseInbound(body));
    return { status: duplicate ? 200 : 201, body: { case_id: caseId, duplicate } };
  });

  r.on("GET", "/api/cases", () => ({
    status: 200,
    body: db.prepare(`SELECT id, channel, customer, status, domain, created_at, updated_at
                      FROM cases ORDER BY created_at DESC LIMIT 200`).all(),
  }));

  r.on("GET", "/api/cases/:id", (_req, { id }) => {
    const c = db.prepare("SELECT * FROM cases WHERE id = ?").get(id);
    if (!c) throw new HttpError(404, "case_not_found");
    const q = (sql: string) => db.prepare(sql).all(id);
    return {
      status: 200,
      body: {
        ...c,
        messages: q("SELECT * FROM messages WHERE case_id = ? ORDER BY received_at"),
        drafts: q("SELECT * FROM drafts WHERE case_id = ? ORDER BY version"),
        outbox: q("SELECT id, draft_id, state, attempts, last_error, updated_at FROM outbox WHERE case_id = ?"),
      },
    };
  });

  // DraftError carries its own status and extra fields (current_rules_version,
  // policy_id) for the UI; anything else is a real 500.
  const guarded = (fn: () => Reply): Reply => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof DraftError) return { status: e.status, body: { error: e.message, ...e.extra } };
      throw e;
    }
  };

  // Where every proposed reply enters: department agents, and the demo's
  // labeled "unsafe suggestion" fixture. The model proposes; the gate decides.
  r.on("POST", "/api/cases/:id/drafts", (_req, { id }, body) => guarded(() => {
    const b = (body ?? {}) as Record<string, any>;
    const domain = str(b.domain, "domain")!;
    const text = str(b.text, "text")!;
    const citations = b.rule_citations ?? [];
    if (!Array.isArray(citations) || !citations.every((c) => typeof c === "string")) {
      throw new HttpError(400, "invalid_rule_citations");
    }
    let action: { type: string; amountCents: number } | undefined;
    if (b.action !== undefined && b.action !== null) {
      const type = str(b.action.type, "action.type")!;
      if (!Number.isSafeInteger(b.action.amount_cents)) throw new HttpError(400, "invalid_action.amount_cents");
      action = { type, amountCents: b.action.amount_cents };
    }
    const route = b.route as Route | undefined;
    if (route !== undefined && !["auto_reply", "draft_for_approval", "human_now"].includes(route)) {
      throw new HttpError(400, "invalid_route");
    }
    const res = createDraft(db, store, { caseId: id, domain, text, ruleCitations: citations, action, route });
    return {
      status: 201,
      body: {
        draft_id: res.draftId, version: res.version, verdict: res.verdict, policy_id: res.policyId,
        reasons: res.reasons, status: res.status, outbox_id: res.outboxId,
      },
    };
  }));

  r.on("GET", "/api/approvals", () => ({ status: 200, body: listApprovals(db) }));

  r.on("POST", "/api/approvals/:id", (_req, { id }, body) => guarded(() => {
    const b = (body ?? {}) as Record<string, unknown>;
    if (b.decision !== "approve" && b.decision !== "reject") throw new HttpError(400, "invalid_decision");
    if (!Number.isSafeInteger(b.draft_version)) throw new HttpError(400, "missing_draft_version");
    if (!Number.isSafeInteger(b.rules_version)) throw new HttpError(400, "missing_rules_version");
    const res = decide(db, store, id, {
      decision: b.decision, draftVersion: b.draft_version as number, rulesVersion: b.rules_version as number,
    });
    // Send now rather than on the next tick, so the reply lands in the widget
    // while the owner is still looking.
    if (res.status === "approved") dispatchOutbox(db, store);
    return { status: 200, body: res };
  }));
  r.on("GET", "/api/rules", () => ({
    status: 200,
    body: store.list().map(({ domain, state }) => describe(domain, state)),
  }));

  r.on("GET", "/api/rules/:domain", (_req, { domain }) => {
    const s = store.get(domain);
    if (!s) throw new HttpError(404, "rules_not_found");
    return { status: 200, body: { ...describe(domain, s), content: s.active?.raw ?? null } };
  });

  // Body: { content: "<the whole file>", expected_version: <version loaded> }.
  // 200 with the new version and the diff; 422 with every problem found (the
  // active rules are untouched); 409 if someone saved in between.
  r.on("PUT", "/api/rules/:domain", (_req, { domain }, body) => {
    const b = (body ?? {}) as Record<string, unknown>;
    if (typeof b.content !== "string") throw new HttpError(400, "missing_content");
    const expected = b.expected_version;
    if (expected !== undefined && !Number.isSafeInteger(expected)) throw new HttpError(400, "invalid_expected_version");
    try {
      const { file, previous } = store.save(domain, b.content, expected as number | undefined);
      const diff = lineDiff(previous?.raw ?? "", file.raw);
      audit(db, "rules_updated", null, {
        domain, from_version: previous?.version ?? null, to_version: file.version, changes: changesOnly(diff),
      });
      return {
        status: 200,
        body: { ...describe(domain, store.get(domain)!), previous_version: previous?.version ?? null, diff },
      };
    } catch (e) {
      if (e instanceof RulesError) return { status: 422, body: { error: "invalid_rules", errors: e.errors } };
      if (e instanceof ConflictError) {
        return { status: 409, body: { error: "version_conflict", current_version: e.currentVersion } };
      }
      throw e;
    }
  });

  r.on("GET", "/api/audit", () => ({
    status: 200,
    body: db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 100").all(),
  }));

  return createServer((req, res) => { void r.handle(req, res); });
}
