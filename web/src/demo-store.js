import { parseDocument } from 'yaml';

export const INITIAL_RULES = `---
domain: company
version: 3
policy:
  REFUND-CAP: { max_amount_cents: 20000, above: block, applies_to: refund }
  REFUND-APPROVAL: { over_cents: 12000, action: draft_for_approval, applies_to: refund }
---
# The front desk handbook
- HOURS: Monday-Friday, 9am-5pm.
- SALES-FOLLOWUP: Ask for the event date, guest count, and a good time to talk.
- REFUND-CAP: Refund requests above the policy cap go to the owner. Never promise payment.
- REFUND-APPROVAL: Replies above the review limit need the owner's approval.
`;

export const money = (cents) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: cents % 100 ? 2 : 0,
}).format(cents / 100);

function rulesDocument(text) {
  if (text.length > 12000) throw new Error('Keep this demo rules file under 12,000 characters.');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error('Keep the YAML policy between the two --- lines.');
  const doc = parseDocument(match[1], { uniqueKeys: true });
  if (doc.errors.length) throw new Error(`Check the policy format: ${doc.errors[0].message.split('\n')[0]}`);
  return { doc, prose: match[2] };
}

export function compileRules(text) {
  const { doc, prose } = rulesDocument(text);
  const data = doc.toJS({ maxAliasCount: 0 });
  if (!data || data.domain !== 'company' || !Number.isSafeInteger(data.version)) {
    throw new Error('Use domain: company and a whole-number version. The demo manages version bumps.');
  }
  if (Object.keys(data).some((key) => !['domain', 'version', 'policy'].includes(key))) {
    throw new Error('This demo supports only domain, version, and policy in the YAML header.');
  }
  const policy = data.policy;
  if (!policy || Object.keys(policy).sort().join(',') !== 'REFUND-APPROVAL,REFUND-CAP') {
    throw new Error('Keep both REFUND-CAP and REFUND-APPROVAL in policy.');
  }
  for (const [id, rule] of Object.entries(policy)) {
    const cap = id === 'REFUND-CAP';
    const keys = cap ? ['max_amount_cents', 'above', 'applies_to'] : ['over_cents', 'action', 'applies_to'];
    if (!rule || Object.keys(rule).sort().join(',') !== keys.sort().join(',')) {
      throw new Error(`${id}: keep exactly ${keys.join(', ')}. Amounts are whole cents.`);
    }
    const amount = rule[cap ? 'max_amount_cents' : 'over_cents'];
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > 100000000) {
      throw new Error(`${id}: use whole cents from 0 to 100000000.`);
    }
    if (rule.applies_to !== 'refund' || rule[cap ? 'above' : 'action'] !== (cap ? 'block' : 'draft_for_approval')) {
      throw new Error(`${id}: keep its refund scope and ${cap ? 'block' : 'draft_for_approval'} action.`);
    }
  }
  const cap = policy['REFUND-CAP'].max_amount_cents;
  const reviewLimit = policy['REFUND-APPROVAL'].over_cents;
  if (reviewLimit > cap) throw new Error('The approval limit must be at or below the refund cap.');
  const proseRules = [...prose.matchAll(/^- ([A-Z][A-Z-]+): (.+)$/gm)];
  const citations = proseRules.map((match) => match[1]);
  if (new Set(citations).size !== citations.length) throw new Error('Each rule ID must appear only once in the handbook.');
  for (const id of ['HOURS', 'SALES-FOLLOWUP', 'REFUND-CAP', 'REFUND-APPROVAL']) {
    if (!citations.includes(id)) throw new Error(`Keep a handbook line starting with - ${id}: followed by its guidance.`);
  }
  return {
    cap, reviewLimit, citations,
    hours: proseRules.find((match) => match[1] === 'HOURS')[2],
    sales: proseRules.find((match) => match[1] === 'SALES-FOLLOWUP')[2],
  };
}

export function evaluateRefund(amount, rules) {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Refund amounts must be non-negative whole cents.');
  if (amount > rules.cap) return 'block';
  if (amount > rules.reviewLimit) return 'review';
  return 'pass';
}

const fixtures = {
  hours: { customer: 'Jamie Park', reply_to: 'jamie@example.com', channel: 'webform', domain: 'support', title: 'A quick question about hours', message: 'Hi! When can I stop by this week?', intent: 'hours' },
  sales: { customer: 'Morgan Lee', reply_to: 'morgan@example.com', channel: 'email', domain: 'sales', title: 'Coffee for the whole team', message: 'We are planning a team breakfast for 40 people. Can you help with coffee and pastries?', intent: 'sales' },
  refund: { customer: 'Dana Brooks', reply_to: 'dana@example.com', channel: 'email', domain: 'support', title: 'A refund for the cancelled order', message: 'Our event was cancelled. Could you refund $225 for the order?', amount_cents: 22500, intent: 'refund' },
  unsafe: { customer: 'Alex Rivera', reply_to: 'alex@example.com', channel: 'webform', domain: 'support', title: 'The $500 refund request', message: 'The order arrived too late for our event. Please refund the full $500.', amount_cents: 50000, intent: 'refund', unsafe: true },
  gap: { customer: 'Sam Taylor', reply_to: 'sam@example.com', channel: 'email', domain: 'support', title: 'An international delivery question', message: 'Can you ship a coffee subscription to Canada?', intent: 'gap' },
};

// This is the replaceable data boundary. It never calls an API, sends a message,
// moves money, or persists data. Each browser session starts from the same fixtures.
export function createDemoStore() {
  let state;
  let sequence;
  function stamp() {
    sequence += 1;
    return new Date(Date.UTC(2026, 9, 25, 9, 41, 0) + sequence * 17000).toISOString();
  }
  function audit(item, title, detail, tone = 'neutral') {
    const at = stamp();
    state.audit.unshift({ id: `event-${sequence}`, case_id: item?.id, at, title, detail, tone });
  }
  function draftFor(item, version = 1) {
    const rules = state.rules.compiled;
    const common = { version, rules_version: state.rules.version, reply_to: item.reply_to, channel: item.channel };
    if (item.intent === 'refund') {
      const verdict = evaluateRefund(item.amount_cents, rules);
      return {
        ...common, gate_verdict: verdict, cap: rules.cap, reviewLimit: rules.reviewLimit, amount_cents: item.amount_cents, action_type: 'refund',
        rule_citations: ['REFUND-CAP', 'REFUND-APPROVAL'],
        text: verdict === 'block'
          ? `I can refund ${money(item.amount_cents)} for your cancelled order.`
          : `We can review refunds up to ${money(rules.cap)}. Your ${money(item.amount_cents)} request is within that limit. I will ask the owner to review your request; no payment is promised.`,
      };
    }
    if (item.intent === 'hours') return { ...common, gate_verdict: 'pass', action_type: 'reply', rule_citations: ['HOURS'], text: `You can stop by ${rules.hours} We look forward to seeing you!` };
    if (item.intent === 'sales') return { ...common, gate_verdict: 'review', action_type: 'reply', rule_citations: ['SALES-FOLLOWUP'], text: `We would love to help with your team breakfast. ${rules.sales}` };
    return { ...common, gate_verdict: 'review', action_type: 'reply', rule_citations: [], text: 'Thanks for asking. I will check with the owner about international shipping and get back to you.' };
  }
  function statusFor(item) {
    if (item.intent === 'gap') return 'gap';
    if (item.draft.gate_verdict === 'block') return 'blocked';
    return item.intent === 'hours' ? 'simulated' : 'held';
  }
  function inject(kind, overrides = {}) {
    if (!fixtures[kind]) throw new Error('Choose one of the demo message types.');
    const at = stamp();
    const item = { ...fixtures[kind], ...overrides, id: `case-${sequence}`, at };
    item.draft = draftFor(item);
    item.status = statusFor(item);
    state.cases.unshift(item);
    audit(item,
      item.status === 'blocked' ? `${money(item.amount_cents)} action blocked` : item.status === 'simulated' ? 'Auto-reply simulated' : item.status === 'gap' ? 'Rules gap found' : 'Draft held for approval',
      item.status === 'blocked' ? `REFUND-CAP: ${money(item.draft.cap)}. Escalated to owner. No message sent.` : item.status === 'simulated' ? 'HOURS cited. Simulated reply only.' : item.status === 'gap' ? 'No international shipping rule. Owner response needed.' : `${item.customer} / rules v${item.draft.rules_version}. No message sent.`,
      item.status === 'blocked' ? 'block' : item.status === 'simulated' ? 'pass' : 'review');
    return structuredClone(item);
  }
  function find(id) {
    const item = state.cases.find((entry) => entry.id === id);
    if (!item) throw new Error('This case is no longer in the inbox. Choose another case.');
    return item;
  }
  function reset(empty = false) {
    sequence = 0;
    state = { cases: [], audit: [], rules: { version: 3, text: INITIAL_RULES, compiled: compileRules(INITIAL_RULES), diff: [] } };
    if (!empty) {
      inject('hours');
      inject('sales');
      inject('gap');
      inject('refund', { amount_cents: 15000, message: 'Could you refund $150 for our cancelled order?', title: 'A $150 refund to review' });
      inject('unsafe');
    }
    return snapshot();
  }
  function snapshot() { return structuredClone(state); }
  function saveRules(text, expectedVersion) {
    if (expectedVersion !== state.rules.version) throw new Error('The rules changed since you opened the editor. Reload the active rules and reapply your edit.');
    compileRules(text);
    if (text === state.rules.text) return snapshot();
    const previous = state.rules;
    const version = previous.version + 1;
    const { doc, prose } = rulesDocument(text);
    doc.set('version', version);
    const nextText = `---\n${doc.toString()}---\n${prose}`;
    const compiled = compileRules(nextText);
    const before = previous.text.trimEnd().split('\n');
    const after = nextText.trimEnd().split('\n');
    state.rules = { version, text: nextText, compiled, diff: [
      ...before.filter((line) => !after.includes(line)).map((line) => ({ op: 'del', text: line })),
      ...after.filter((line) => !before.includes(line)).map((line) => ({ op: 'add', text: line })),
    ] };
    audit(null, `Rules v${previous.version} → v${version}`, `REFUND-CAP ${money(previous.compiled.cap)} → ${money(compiled.cap)}. Existing drafts need a fresh check.`, 'rules');
    return snapshot();
  }
  function recheck(id) {
    const item = find(id);
    if (['approved', 'rejected', 'simulated'].includes(item.status)) throw new Error('This case is complete. Inject a new message to try the current rules.');
    item.draft = draftFor(item, item.draft.version + 1);
    item.status = statusFor(item);
    audit(item, 'Draft checked against current rules', `${item.draft.gate_verdict.toUpperCase()} / draft v${item.draft.version} / rules v${state.rules.version}. No message sent.`, item.draft.gate_verdict);
    return snapshot();
  }
  function review(id, decision, binding) {
    const item = find(id);
    if (!['approve', 'reject'].includes(decision)) throw new Error('Choose approve or reject.');
    if (item.status !== 'held') throw new Error('This reply is no longer awaiting approval.');
    const draft = item.draft;
    if (!binding || ['version', 'rules_version', 'reply_to', 'channel', 'action_type'].some((key) => binding[key] !== draft[key])) {
      throw new Error('This draft changed. Review the latest draft before deciding.');
    }
    if (draft.rules_version !== state.rules.version) throw new Error('Rules changed. Recheck the draft before approving or rejecting.');
    if (item.intent === 'refund' && evaluateRefund(item.amount_cents, state.rules.compiled) === 'block') throw new Error('The current refund cap blocks this reply. Recheck the draft.');
    item.status = decision === 'approve' ? 'approved' : 'rejected';
    audit(item, decision === 'approve' ? 'Reply approved locally' : 'Reply rejected', decision === 'approve' ? `${item.customer} / draft v${draft.version}. No message sent. No payment made.` : `${item.customer} / escalated to owner. No message sent.`, decision === 'approve' ? 'pass' : 'review');
    return snapshot();
  }
  reset();
  return { snapshot, inject, saveRules, recheck, review, reset };
}
