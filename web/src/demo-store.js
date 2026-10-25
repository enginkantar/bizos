export const INITIAL_RULES = `---
domain: company
version: 3
policy:
  REFUND-CAP: { max_amount_cents: 20000, above: block, applies_to: refund }
  REFUND-APPROVAL: { over_cents: 12000, action: draft_for_approval, applies_to: refund }
---
# The front desk handbook
- [KNOW-HOURS] Monday-Thursday 7:30 am-5 pm, Friday 7:30 am-1 pm. Closed weekends.
- [NEW-1] Arrive 15 minutes early with your insurance card and photo ID.
- [KNOW-NEW-PATIENT] New patient visits take about 90 minutes: exam, cleaning and X-rays.
- REFUND-CAP: never refund more than $200 in one request. Larger refunds are handled by the billing coordinator.
- REFUND-APPROVAL: Replies above the review limit need the owner's approval.
`;

// Maps each rule ID to the file that defines it and its line, the same two shapes the
// gate accepts as a definition: a policy key or the ID that starts a rule line.
export function indexRules(domain, content) {
  const index = {};
  for (const line of String(content ?? '').split('\n')) {
    const id = line.match(/^  ([A-Z][A-Z0-9-]*):/)?.[1] ?? line.match(/^- \[([A-Z][A-Z0-9-]*)\]/)?.[1] ?? line.match(/^- ([A-Z][A-Z0-9-]*):/)?.[1];
    if (id && !index[id]?.text?.startsWith('-')) index[id] = { domain, text: line.trim() };
  }
  return index;
}

export const money = (cents) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: cents % 100 ? 2 : 0,
}).format(cents / 100);

// Deliberately narrow fixture editor, never used for live policy decisions.
export function compileRules(text) {
  const shape = value => value.replace(/^version: \d+$/m, 'version: N').replace(/(max_amount_cents: |over_cents: )\d+/g, '$1N').replace(/^- \[KNOW-HOURS\] .+$/m, '- [KNOW-HOURS] TEXT');
  if (shape(text) !== shape(INITIAL_RULES)) throw new Error('Demo editor: edit only the displayed amounts or hours. Nothing saved.');
  if (!/^domain: company$/m.test(text) || !/^version: \d+$/m.test(text)) throw new Error('Demo editor: keep domain: company and the version line.');
  const cap = text.match(/^  REFUND-CAP: \{ max_amount_cents: (\d+), above: block, applies_to: refund \}$/m);
  const review = text.match(/^  REFUND-APPROVAL: \{ over_cents: (\d+), action: draft_for_approval, applies_to: refund \}$/m);
  if (!cap || !review) throw new Error('Demo editor supports only the displayed refund policy format. Use whole cents. Nothing saved.');
  const capValue = Number(cap[1]), reviewValue = Number(review[1]);
  if (!Number.isSafeInteger(capValue) || !Number.isSafeInteger(reviewValue) || reviewValue > capValue) throw new Error('Use whole cents and keep the approval limit below the cap.');
  const hours = text.match(/^- \[KNOW-HOURS\] (.+)$/m)?.[1];
  if (!hours) throw new Error('Keep the [KNOW-HOURS] rule.');
  return { cap: capValue, reviewLimit: reviewValue, hours, sales: 'Please arrive 15 minutes early with a photo ID and insurance card.' };
}

export function evaluateRefund(amount, rules) {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Refund amounts must be non-negative whole cents.');
  if (amount > rules.cap) return 'block';
  if (amount > rules.reviewLimit) return 'review';
  return 'pass';
}

const fixtures = {
  hours: { customer: 'Jamie Park', reply_to: 'jamie@example.com', channel: 'webform', domain: 'front-desk', title: 'A quick question about hours', message: 'Hi! When can I stop by this week?', intent: 'hours' },
  sales: { customer: 'Morgan Lee', reply_to: 'morgan@example.com', channel: 'email', domain: 'front-desk', title: 'A first visit to the dentist', message: 'Are you accepting new patients, do you take Delta Dental, and what should I bring to my first appointment?', intent: 'sales' },
  refund: { customer: 'Dana Brooks', reply_to: 'dana@example.com', channel: 'email', domain: 'billing', title: 'A refund for the cancelled appointment', message: 'Could you review a $225 refund for my cancelled appointment?', amount_cents: 22500, intent: 'refund' },
  unsafe: { customer: 'Alex Rivera', reply_to: 'alex@example.com', channel: 'webform', domain: 'billing', title: 'The $500 refund request', message: 'You charged me $500. Please refund it.', amount_cents: 50000, intent: 'refund', unsafe: true },
  gap: { customer: 'Sam Taylor', reply_to: 'sam@example.com', channel: 'email', domain: 'front-desk', title: 'An insurance coverage question', message: 'Can you guarantee my insurance will cover an implant?', intent: 'gap' },
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
    const common = { version, rules_version: state.rules.version, rules_versions: { company: state.rules.version }, reply_to: item.reply_to, channel: item.channel, evidence: [], missing_info: [] };
    if (item.intent === 'refund') {
      const verdict = evaluateRefund(item.amount_cents, rules);
      return {
        ...common, gate_verdict: verdict, cap: rules.cap, reviewLimit: rules.reviewLimit, amount_cents: item.amount_cents, action_type: 'refund', gate_policy_id: verdict === 'block' ? 'REFUND-CAP' : 'REFUND-APPROVAL', gate_reason: verdict === 'block' ? `Refund exceeds REFUND-CAP (${money(rules.cap)})` : 'auto-send is off: every reply waits for the owner',
        rule_citations: ['REFUND-CAP', 'REFUND-APPROVAL'],
        evidence: [{ rule_id: 'REFUND-CAP', quote: 'Larger refunds are handled by the billing coordinator' }],
        missing_info: ['the date of the original charge'],
        text: verdict === 'block'
          ? `I can refund ${money(item.amount_cents)} to your card today.`
          : `We can review refunds up to ${money(rules.cap)}. Your ${money(item.amount_cents)} request is within that limit. I will ask the owner to review your request; no payment is promised.`,
      };
    }
    if (item.intent === 'hours') return { ...common, gate_verdict: 'pass', action_type: 'reply', gate_reason: 'auto-send is off: every reply waits for the owner', rule_citations: ['KNOW-HOURS'], text: `You can stop by ${rules.hours} We look forward to seeing you!` };
    if (item.intent === 'sales') return { ...common, gate_verdict: 'review', action_type: 'reply', gate_reason: 'auto-send is off: every reply waits for the owner', rule_citations: ['NEW-1', 'KNOW-NEW-PATIENT'],
      evidence: [{ rule_id: 'NEW-1', quote: 'arrive 15 minutes early' }, { rule_id: 'KNOW-NEW-PATIENT', quote: 'New patient visits take about 90 minutes' }],
      missing_info: ['which Delta Dental plan they have (PPO or HMO)'],
      text: `Welcome to Harbor Smile Dental, and yes, we are accepting new patients. Your first visit takes about 90 minutes: exam, cleaning and X-rays. ${rules.sales} Which Delta Dental plan do you have, so we can check it before your visit?` };
    return { ...common, gate_verdict: 'review', action_type: 'reply', gate_reason: 'auto-send is off: every reply waits for the owner', rule_citations: [], text: 'Thanks for asking. I will check with the owner about insurance coverage and get back to you.' };
  }
  function statusFor(item) {
    if (item.intent === 'gap') return 'escalated';
    if (item.draft.gate_verdict === 'block') return 'blocked';
    return 'held';
  }
  function inject(kind, overrides = {}) {
    if (!fixtures[kind]) throw new Error('Choose one of the demo message types.');
    const at = stamp();
    const item = { ...fixtures[kind], ...overrides, id: `case-${sequence}`, at };
    item.messages = [{ direction: 'in', text: item.message, received_at: at }];
    item.draft = draftFor(item);
    item.status = statusFor(item);
    state.cases.unshift(item);
    audit(item,
      item.status === 'blocked' ? `${money(item.amount_cents)} action blocked` : item.status === 'simulated' ? 'Auto-reply simulated' : item.status === 'escalated' ? 'Rules gap found' : 'Draft held for approval',
      item.status === 'blocked' ? `REFUND-CAP: ${money(item.draft.cap)}. Escalated to owner. No message sent.` : item.status === 'simulated' ? 'HOURS cited. Simulated reply only.' : item.status === 'escalated' ? 'No insurance coverage rule. Owner response needed.' : `${item.customer} / rules v${item.draft.rules_version}. No message sent.`,
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
      inject('refund', { amount_cents: 15000, message: 'Could you refund $150 for our cancelled appointment?', title: 'A $150 refund to review' });
      inject('unsafe');
    }
    return snapshot();
  }
  // The same shape as the live store's snapshot, so the desk renders one way in both modes.
  function snapshot() {
    const { cap, reviewLimit } = state.rules.compiled;
    const policy = [{ id: 'REFUND-CAP', limit_cents: cap, outcome: 'block' }, { id: 'REFUND-APPROVAL', limit_cents: reviewLimit, outcome: 'review' }];
    return structuredClone({ ...state, rules: { ...state.rules, domain: 'company', policy },
      domains: [{ domain: 'company', version: state.rules.version, policy }],
      ruleIndex: indexRules('company', state.rules.text),
      // Like GET /api/approvals: escalations first and urgent, then held replies oldest first.
      approvals: [...state.cases.filter(item => item.status === 'escalated' && !item.decided), ...state.cases.filter(item => item.status === 'held').toReversed()]
        .map(item => ({ case_id: item.id, draft_id: item.id, urgent: item.status === 'escalated', case_status: item.status })) });
  }
  function saveRules(text, expectedVersion) {
    if (expectedVersion !== state.rules.version) throw new Error('The rules changed since you opened the editor. Reload the active rules and reapply your edit.');
    compileRules(text);
    if (text === state.rules.text) return snapshot();
    const previous = state.rules;
    const version = previous.version + 1;
    const nextText = text.replace(/^version: \d+$/m, `version: ${version}`);
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
    if (item.status !== 'held' && (item.status !== 'escalated' || item.decided)) throw new Error('This reply is no longer awaiting approval.');
    const draft = item.draft;
    if (!binding || ['version', 'rules_version', 'reply_to', 'channel', 'action_type'].some((key) => binding[key] !== draft[key])) {
      throw new Error('This draft changed. Review the latest draft before deciding.');
    }
    if (draft.rules_version !== state.rules.version) throw new Error('Rules changed. Recheck the draft before approving or rejecting.');
    if (item.intent === 'refund' && evaluateRefund(item.amount_cents, state.rules.compiled) === 'block') throw new Error('The current refund cap blocks this reply. Recheck the draft.');
    item.status = decision === 'approve' ? 'approved' : 'escalated';
    item.decided = true;
    audit(item, decision === 'approve' ? 'Reply approved locally' : 'Reply rejected', decision === 'approve' ? `${item.customer} / draft v${draft.version}. No message sent. No payment made.` : `${item.customer} / escalated to owner. No message sent.`, decision === 'approve' ? 'pass' : 'review');
    return snapshot();
  }
  reset();
  return { mode: 'demo', snapshot, inject, saveRules, recheck, review, reset };
}
