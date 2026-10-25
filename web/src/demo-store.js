// Trimmed copies of the dental pack in templates/dental-office, at the versions a fresh
// install seeds, so the offline desk shows the same files, IDs and limits as a live one.
export const FIXTURE_RULES = {
  company: `---
domain: company
version: 4
# Limits here bind EVERY department, alongside the department's own.
policy:
  MONEY-CAP:     { max_amount_cents: 500000, above: block }
  REFUND-CAP:    { max_amount_cents: 20000, above: block, applies_to: refund }
  WRITE-OFF-CAP: { max_amount_cents: 50000, above: block, applies_to: write_off }
---
## HARD RULES
- MONEY-CAP: no single refund, discount, credit, write-off or payment plan above $5,000 is ever agreed in chat or email.
- REFUND-CAP: never refund more than $200 in one request. Larger refunds are handled by the billing coordinator, by phone.
- WRITE-OFF-CAP: no single balance write-off above $500, ever.
- PRIVACY-1: never confirm, discuss or repeat anything about a patient's treatment, records, balance or appointments in chat or email.

## KNOWLEDGE
- KNOW-HOURS: Monday-Thursday 7:30 am-5 pm, Friday 7:30 am-1 pm. Closed weekends.
`,
  billing: `---
domain: billing
version: 3
policy:
  REFUND-APPROVAL:        { over_cents: 12000, action: draft_for_approval, applies_to: refund }
  DISCOUNT-CAP:           { max_amount_cents: 15000, above: block, applies_to: discount }
  DISCOUNT-APPROVAL:      { over_cents: 5000, action: draft_for_approval, applies_to: discount }
  PAYMENT-PLAN-APPROVAL:  { over_cents: 150000, action: draft_for_approval, applies_to: payment_plan }
---
## HARD RULES
- REFUND-APPROVAL: refunds over $120 wait for the billing coordinator.
- DISCOUNT-CAP: never offer a courtesy discount above $150.
- COVERAGE-1: never say what insurance will pay for a specific treatment.
`,
  'front-desk': `---
domain: front-desk
version: 2
policy:
  FEE-WAIVER-APPROVAL: { over_cents: 0, action: draft_for_approval, applies_to: fee_waiver }
  FEE-WAIVER-CAP:      { max_amount_cents: 7500, above: block, applies_to: fee_waiver }
---
## SOFT RULES
- NEW-1: tell new patients to arrive 15 minutes early and bring their insurance card and a photo ID.

## KNOWLEDGE
- KNOW-NEW-PATIENT: new patient visits take about 90 minutes: exam, cleaning and X-rays.
`,
};
export const INITIAL_RULES = FIXTURE_RULES.company;
const DOMAINS = Object.keys(FIXTURE_RULES);

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

// Deliberately narrow fixture editor, never used for live policy decisions: only the
// amounts, and company's opening hours, may change.
const shape = (value) => value.replace(/^version: \d+$/m, 'version: N').replace(/(max_amount_cents: |over_cents: )\d+/g, '$1N').replace(/\$\d+(?:,\d{3})*(?:\.\d{2})?/g, '$N').replace(/^- KNOW-HOURS: .+$/m, '- KNOW-HOURS: TEXT');
function compileFile(domain, text) {
  if (!FIXTURE_RULES[domain] || shape(text) !== shape(FIXTURE_RULES[domain])) throw new Error('Demo editor: edit only the displayed amounts or hours. Nothing saved.');
  const policy = [...text.matchAll(/^  ([A-Z][A-Z0-9-]*): +\{ (max_amount_cents|over_cents): (\d+),/gm)]
    .map(([, id, kind, cents]) => ({ id, limit_cents: Number(cents), outcome: kind === 'over_cents' ? 'review' : 'block' }));
  if (policy.some((p) => !Number.isSafeInteger(p.limit_cents))) throw new Error('Use whole cents. Nothing saved.');
  return policy;
}
// Compiles every fixture file. The refund limits come from two files, as on the server:
// the company cap blocks, the billing approval limit holds for the owner.
export function compileRules(texts = FIXTURE_RULES) {
  const policies = Object.fromEntries(DOMAINS.map((domain) => [domain, compileFile(domain, texts[domain])]));
  const limit = (domain, id) => policies[domain].find((p) => p.id === id).limit_cents;
  const cap = limit('company', 'REFUND-CAP'), reviewLimit = limit('billing', 'REFUND-APPROVAL');
  if (reviewLimit > cap) throw new Error('Use whole cents and keep the approval limit below the cap.');
  const hours = texts.company.match(/^- KNOW-HOURS: (.+)$/m)[1];
  return { cap, reviewLimit, hours, policies, sales: 'Please arrive 15 minutes early with a photo ID and insurance card.' };
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
// moves money, or persists decisions. The optional inbox imports browser-local widget input.
export function createDemoStore({ readInbox = () => [] } = {}) {
  let state;
  let sequence;
  const imported = new Set();
  function stamp() {
    sequence += 1;
    return new Date(Date.UTC(2026, 9, 25, 9, 41, 0) + sequence * 17000).toISOString();
  }
  function audit(item, title, detail, tone = 'neutral') {
    const at = stamp();
    state.audit.unshift({ id: `event-${sequence}`, case_id: item?.id, at, title, detail, tone });
  }
  function draftFor(item, version = 1) {
    const rules = state.compiled;
    // Like the server: company binds every department, so a draft records both files' versions.
    const rules_versions = { company: state.files.company.version, [item.domain]: state.files[item.domain].version };
    const common = { version, rules_version: state.files[item.domain].version, rules_versions, reply_to: item.reply_to, channel: item.channel, evidence: [], missing_info: [] };
    if (item.intent === 'refund') {
      const verdict = evaluateRefund(item.amount_cents, rules);
      return {
        ...common, gate_verdict: verdict, cap: rules.cap, reviewLimit: rules.reviewLimit, amount_cents: item.amount_cents, action_type: 'refund', gate_policy_id: verdict === 'block' ? 'REFUND-CAP' : verdict === 'review' ? 'REFUND-APPROVAL' : null,
        gate_reason: verdict === 'block' ? `${money(item.amount_cents)} is over REFUND-CAP (${money(rules.cap)})` : verdict === 'review' ? `${money(item.amount_cents)} is over REFUND-APPROVAL (${money(rules.reviewLimit)})` : 'auto-send is off: every reply waits for the owner',
        rule_citations: ['REFUND-CAP', 'REFUND-APPROVAL'],
        evidence: [{ rule_id: 'REFUND-CAP', quote: 'Larger refunds are handled by the billing coordinator' }],
        missing_info: ['the date of the original charge'],
        text: verdict === 'block'
          ? `I can refund ${money(item.amount_cents)} to your card today.`
          : `We can review refunds up to ${money(rules.cap)}. Your ${money(item.amount_cents)} request is within that limit. I will ask the owner to review your request; no payment is promised.`,
      };
    }
    if (item.intent === 'hours') return { ...common, gate_verdict: 'pass', action_type: 'reply', gate_reason: 'auto-send is off: every reply waits for the owner', rule_citations: ['KNOW-HOURS'], text: `You can stop by ${rules.hours} We look forward to seeing you!` };
    if (item.intent === 'sales') return { ...common, gate_verdict: 'pass', action_type: 'reply', gate_reason: 'auto-send is off: every reply waits for the owner', rule_citations: ['NEW-1', 'KNOW-NEW-PATIENT'],
      evidence: [{ rule_id: 'NEW-1', quote: 'arrive 15 minutes early' }, { rule_id: 'KNOW-NEW-PATIENT', quote: 'New patient visits take about 90 minutes' }],
      missing_info: ['which Delta Dental plan they have (PPO or HMO)'],
      text: `Welcome to Harbor Smile Dental, and yes, we are accepting new patients. Your first visit takes about 90 minutes: exam, cleaning and X-rays. ${rules.sales} Which Delta Dental plan do you have, so we can check it before your visit?` };
    return { ...common, gate_verdict: 'pass', action_type: 'reply', gate_reason: 'auto-send is off: every reply waits for the owner', rule_citations: [], text: item.widget ? 'Demo widget submission awaiting owner review. No AI ran and nothing was sent.' : 'Thanks for asking. I will check with the owner about insurance coverage and get back to you.' };
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
    if (item.widget) {
      audit(item, 'Demo widget submission received', 'Browser-local input. No AI ran. Awaiting owner review; nothing sent.', 'review');
      return structuredClone(item);
    }
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
    // Reset clears this desk's run without replaying old widget submissions on the next poll.
    if (state) for (const message of readInbox()) imported.add(message.message_id);
    sequence = 0;
    state = { cases: [], audit: [], selected: 'company', diff: { domain: null, lines: [] }, compiled: compileRules(),
      files: Object.fromEntries(DOMAINS.map((domain) => [domain, { version: Number(FIXTURE_RULES[domain].match(/^version: (\d+)$/m)[1]), text: FIXTURE_RULES[domain] }])) };
    if (!empty) {
      inject('hours');
      inject('sales');
      inject('gap');
      inject('refund', { amount_cents: 15000, message: 'Could you refund $150 for our cancelled appointment?', title: 'A $150 refund to review' });
      inject('unsafe');
    }
    return snapshot();
  }
  function refresh() {
    for (const envelope of readInbox()) {
      if (imported.has(envelope.message_id)) continue;
      inject('gap', { widget: true, customer: envelope.customer?.name || 'Demo visitor',
        reply_to: envelope.reply_to, channel: 'webform', title: 'Demo widget submission', message: envelope.content.text });
      imported.add(envelope.message_id);
    }
  }
  // The same shape as the live store's snapshot, so the desk renders one way in both modes.
  function snapshot() {
    const file = state.files[state.selected];
    const domains = DOMAINS.map((domain) => ({ domain, version: state.files[domain].version, policy: state.compiled.policies[domain] }));
    // As on the server, a department's own definition wins over company.rules.md.
    const ruleIndex = Object.assign({}, ...DOMAINS.map((domain) => indexRules(domain, state.files[domain].text)));
    return structuredClone({ cases: state.cases, audit: state.audit, domains, ruleIndex,
      rules: { domain: state.selected, version: file.version, text: file.text, policy: state.compiled.policies[state.selected], compiled: state.compiled,
        diff: state.diff.domain === state.selected ? state.diff.lines : [] },
      // Like GET /api/approvals: escalations first and urgent, then held replies oldest first.
      approvals: [...state.cases.filter(item => item.status === 'escalated' && !item.decided), ...state.cases.filter(item => item.status === 'held').toReversed()]
        .map(item => ({ case_id: item.id, draft_id: item.id, urgent: item.status === 'escalated', case_status: item.status })) });
  }
  function selectDomain(domain) {
    if (!state.files[domain]) throw new Error('No such rules file in the demo.');
    state.selected = domain;
    return snapshot();
  }
  function selectCitation(id) {
    const domain = snapshot().ruleIndex[id]?.domain;
    if (!domain) throw new Error('This citation is absent from the current rules. The draft retains its original version.');
    return selectDomain(domain);
  }
  function saveRules(text, expectedVersion) {
    const domain = state.selected;
    const previous = state.files[domain];
    if (expectedVersion !== previous.version) throw new Error('The rules changed since you opened the editor. Reload the active rules and reapply your edit.');
    const texts = (next) => Object.fromEntries(DOMAINS.map((d) => [d, d === domain ? next : state.files[d].text]));
    compileRules(texts(text));
    if (text === previous.text) return snapshot();
    const version = previous.version + 1;
    const nextText = text.replace(/^version: \d+$/m, `version: ${version}`);
    const compiled = compileRules(texts(nextText));
    const before = previous.text.trimEnd().split('\n');
    const after = nextText.trimEnd().split('\n');
    const changed = compiled.policies[domain].filter((p, i) => p.limit_cents !== state.compiled.policies[domain][i].limit_cents)
      .map((p) => `${p.id} ${money(state.compiled.policies[domain].find((q) => q.id === p.id).limit_cents)} → ${money(p.limit_cents)}`);
    state.files[domain] = { version, text: nextText };
    state.compiled = compiled;
    state.diff = { domain, lines: [
      ...before.filter((line) => !after.includes(line)).map((line) => ({ op: 'del', text: line })),
      ...after.filter((line) => !before.includes(line)).map((line) => ({ op: 'add', text: line })),
    ] };
    audit(null, `Rules ${domain} v${previous.version} → v${version}`, `${changed.join(', ') || `${domain}.rules.md text changed`}. Existing drafts need a fresh check.`, 'rules');
    return snapshot();
  }
  function recheck(id) {
    const item = find(id);
    if (['approved', 'rejected', 'simulated'].includes(item.status)) throw new Error('This case is complete. Inject a new message to try the current rules.');
    item.draft = draftFor(item, item.draft.version + 1);
    item.status = statusFor(item);
    audit(item, 'Draft checked against current rules', `${item.draft.gate_verdict.toUpperCase()} / draft v${item.draft.version} / ${Object.entries(item.draft.rules_versions).map(([d, v]) => `${d} v${v}`).join(', ')}. No message sent.`, item.draft.gate_verdict);
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
    if (decision === 'approve') {
      if (Object.entries(draft.rules_versions).some(([domain, v]) => state.files[domain].version !== v)) throw new Error('Rules changed. Recheck the draft before approving.');
      if (item.intent === 'refund' && evaluateRefund(item.amount_cents, state.compiled) === 'block') throw new Error('The current refund cap blocks this reply. Recheck the draft.');
    }
    item.status = decision === 'approve' ? 'approved' : 'escalated';
    item.decided = true;
    audit(item, decision === 'approve' ? 'Reply approved locally' : 'Reply rejected', decision === 'approve' ? `${item.customer} / draft v${draft.version}. No message sent. No payment made.` : `${item.customer} / escalated to owner. No message sent.`, decision === 'approve' ? 'pass' : 'review');
    return snapshot();
  }
  reset();
  refresh();
  return { mode: 'demo', snapshot, refresh, inject, selectDomain, selectCitation, saveRules, recheck, review, reset };
}
