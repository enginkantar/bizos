import { createDemoStore, indexRules } from './demo-store.js';

export async function request(path, body, method = 'POST') {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const data = await response.json();
  if (!response.ok) {
    const messages = {
      invalid_rules: `Rules were not saved. The previous version is still enforced. ${(data.errors ?? []).join('. ')}`,
      version_conflict: 'Someone saved newer rules. Reload active rules and reapply your edit.',
      rules_changed: 'Rules changed. Recheck the draft before approving.',
      stale_draft: 'A newer draft exists. Reload and review it before approving.',
      blocked: `The Policy Gate blocked this reply: ${data.policy_id ?? ''}`,
    };
    const error = new Error(messages[data.error] ?? `The server refused this request: ${data.error ?? response.status}`);
    error.code = data.error;
    throw error;
  }
  return data;
}
const parsed = (value, fallback) => typeof value === 'string' ? JSON.parse(value) : value ?? fallback;
export function normalizeCase(item) {
  const draft = item.drafts?.at(-1);
  const checkedCap = draft?.gate_reason?.match(/\(\$([\d,]+(?:\.\d{2})?)\)/)?.[1];
  return { ...item, title: item.messages?.find(m => m.direction === 'in')?.text ?? 'New message',
    message: item.messages?.find(m => m.direction === 'in')?.text ?? '', at: item.created_at,
    draft: draft ? { ...draft, rule_citations: parsed(draft.rule_citations, []), evidence: parsed(draft.evidence, []), missing_info: parsed(draft.missing_info, []),
      cap: checkedCap ? Math.round(Number(checkedCap.replaceAll(',', '')) * 100) : null, rules_versions: parsed(draft.rules_versions, {}), reply_to: item.reply_to, channel: item.channel } : null,
    amount_cents: draft?.amount_cents,
  };
}
// One feed line per audit event: what the gate or the owner decided, in the desk's words.
function auditEntry(entry) {
  const detail = parsed(entry.detail, {});
  const tone = { block: 'block', review: 'hold', pass: 'ok' }[detail.verdict] ?? ({ approved: 'ok', sent: 'ok', rules_updated: 'rules', escalated: 'block' })[entry.event] ?? 'neutral';
  const title = entry.event === 'drafted' && detail.verdict ? `Draft v${detail.version ?? 1} · ${detail.verdict.toUpperCase()}`
    : entry.event === 'rules_updated' ? `Rules ${detail.domain} v${detail.from_version} → v${detail.to_version}`
    : entry.event[0].toUpperCase() + entry.event.slice(1).replaceAll('_', ' ');
  return { ...entry, title, tone, detail: auditText(entry, detail) };
}
function auditText(entry, detail) {
  if (detail.reasons?.length) return detail.reasons.join(' · ');
  if (entry.event === 'drafted') return detail.route === 'human_now' ? 'Escalated to the owner' : 'Waiting for the owner';
  if (entry.event === 'sent') return `Reply sent via ${detail.channel ?? 'the customer channel'}`;
  if (entry.event === 'rules_updated') {
    const lines = (detail.changes ?? []).filter(c => c.op === 'add' && !c.text.startsWith('version:')).length;
    return `${detail.domain}.rules.md: ${lines} line${lines === 1 ? '' : 's'} changed`;
  }
  if (entry.event === 'received') return `Message received via ${detail.channel ?? 'customer channel'}`;
  if (detail.rules_version) return `Draft v${detail.version ?? detail.draft_version ?? 1} / rules v${detail.rules_version}`;
  return entry.event.replaceAll('_', ' ');
}
export async function connectStore() {
  // Only the initial connection can select fixtures. Later failures preserve live data.
  let rules;
  try { rules = await request('rules'); }
  catch { return createDemoStore(); }
  if (!Array.isArray(rules)) return createDemoStore();
  let domain = rules.find(r => r.domain === 'company')?.domain ?? rules[0]?.domain;
  let state = { cases: [], audit: [], approvals: [], ruleIndex: {}, domains: rules, rules: { version: null, text: '', compiled: {}, policy: [], diff: [] } };
  let savedDiff = [];
  // Rule text per file, refetched only when a file's version moves, so citations can name
  // their file and show the rule's own words without three extra requests every poll.
  const contents = {};
  async function indexAll(domains) {
    await Promise.all(domains.filter(d => contents[d.domain]?.version !== d.version).map(async d => {
      const rule = await request(`rules/${encodeURIComponent(d.domain)}`);
      contents[d.domain] = { version: d.version, content: rule.content ?? '' };
    }));
    // A department's own definition wins over company.rules.md, as in the rules in force.
    const order = [...domains.filter(d => d.domain === 'company'), ...domains.filter(d => d.domain !== 'company')];
    return Object.assign({}, ...order.map(d => indexRules(d.domain, contents[d.domain]?.content)));
  }
  async function loadRules() {
    if (!domain) return;
    const rule = await request(`rules/${encodeURIComponent(domain)}`);
    state.rules = { ...rule, text: rule.content ?? '', compiled: {}, diff: savedDiff };
  }
  async function refresh() {
    const [cases, approvals, audit, domains] = await Promise.all(['cases', 'approvals', 'audit', 'rules'].map(p => request(p)));
    const details = await Promise.all(cases.map(c => request(`cases/${encodeURIComponent(c.id)}`)));
    const ruleIndex = await indexAll(domains);
    state = { ...state, cases: details.map(normalizeCase), approvals, domains, ruleIndex,
      audit: audit.map(auditEntry) };
    await loadRules();
    return snapshot();
  }
  const snapshot = () => structuredClone(state);
  const find = id => state.cases.find(c => c.id === id);
  async function recheck(id) {
    const d = find(id)?.draft;
    if (!d) throw new Error('No draft exists to recheck.');
    await request(`cases/${encodeURIComponent(id)}/drafts`, { domain: d.domain, text: d.text,
      rule_citations: d.rule_citations, evidence: d.evidence, missing_info: d.missing_info, ...(d.amount_cents == null ? {} : { action: { type: d.action_type, amount_cents: d.amount_cents } }), route: 'draft_for_approval' });
    await refresh();
  }
  return {
    mode: 'live', snapshot, refresh,
    async selectCitation(id) {
      for (const entry of state.domains) {
        const rule = await request(`rules/${encodeURIComponent(entry.domain)}`);
        if ((rule.content ?? '').split('\n').some(line => line.startsWith(`- [${id}]`) || line.startsWith(`- ${id}:`) || line.startsWith(`  ${id}:`))) {
          domain = entry.domain; savedDiff = []; await loadRules(); return;
        }
      }
      throw new Error('This citation is absent from the current rules. The draft retains its original version.');
    },
    async selectDomain(next) { domain = next; savedDiff = []; await loadRules(); },
    async saveRules(content, expected_version) {
      const result = await request(`rules/${encodeURIComponent(domain)}`, { content, expected_version }, 'PUT');
      savedDiff = result.diff.filter(line => line.op !== 'same');
      await refresh();
    },
    async review(id, decision, binding) {
      await request(`approvals/${encodeURIComponent(binding.id)}`, { decision, draft_version: binding.version, rules_version: binding.rules_version });
      await refresh();
    },
    recheck,
    async inject(kind) {
      const demo = createDemoStore();
      const sample = demo.inject(kind);
      const inbound = await request('inbox', { source: 'webform', message_id: crypto.randomUUID(), reply_to: sample.reply_to,
        customer: { name: sample.customer }, content: { type: 'text', text: sample.message } });
      const d = sample.draft;
      await request(`cases/${encodeURIComponent(inbound.case_id)}/drafts`, { domain: sample.domain, text: d.text, rule_citations: d.rule_citations, evidence: d.evidence, missing_info: d.missing_info,
        ...(d.amount_cents == null ? {} : { action: { type: d.action_type, amount_cents: d.amount_cents } }), route: kind === 'gap' ? 'human_now' : 'auto_reply' });
      await refresh();
      return find(inbound.case_id);
    },
  };
}
