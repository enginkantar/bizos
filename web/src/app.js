import { connectStore } from './live-store.js';
import { money } from './demo-store.js';

const store = await connectStore();
let connectionError = '';
if (store.mode === 'live') { try { await store.refresh(); } catch (e) { connectionError = e.message; } }
let state = store.snapshot();
let selectedId = state.cases[0]?.id;
let rulesOpen = false;
let editorText = state.rules.text;
let editorVersion = state.rules.version;
let query = '';
let filter = 'all';
let notice = connectionError;
let noticeError = Boolean(connectionError);
let approvalIndex = 0;
let auditIndex = 0;

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const time = (at) => (at ?? '').slice(11, 19);
const domainLabel = (domain) => ({ 'front-desk': 'Front desk', billing: 'Billing', company: 'Company' })[domain] ?? domain;
const channelLabel = (channel) => ({ webform: 'Web chat', email: 'Email' })[channel] ?? channel;
const initials = (name) => escape(String(name ?? 'Guest').split(' ').map(word => word[0] ?? '').join(''));
const selected = () => state.cases.find((item) => item.id === selectedId);
const statuses = {
  blocked: ['block', 'Blocked'], held: ['review', 'Needs approval'], simulated: ['pass', 'Reply simulated'],
  new: ['neutral', 'new'], routed: ['neutral', 'routed'], drafted: ['neutral', 'drafted'], sent: ['pass', 'sent'], quote_sent: ['pass', 'quote_sent'], escalated: ['review', 'escalated'], approved: ['pass', 'approved'], rejected: ['neutral', 'Rejected'], gap: ['review', 'Rules gap'],
};
const icon = (name) => {
  const paths = {
    inbox: '<path d="M4 4h16v16H4zM4 13h5l2 3h2l2-3h5"/>',
    rule: '<path d="M6 3h12v18H6zM9 7h6M9 11h6M9 15h4"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM12 8v5M12 16h.01"/>',
    arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    reset: '<path d="M4 10a8 8 0 1 1 1 8M4 4v6h6"/>',
    search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
    spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/>',
  };
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
};
function chip(tone, label) { return `<span class="chip ${tone}">${escape(label)}</span>`; }
function citations(draft) {
  return draft.rule_citations.length ? draft.rule_citations.map((id) => `<button class="citation" data-citation="${escape(id)}" title="Find ${escape(id)} in the active rules">${icon('rule')}${escape(id)}</button>`).join('') : '<span class="muted">No matching rule</span>';
}
function stats() {
  const values = [state.cases.length, state.cases.filter(c => c.draft).length,
    store.mode === 'live' ? state.cases.filter(c => ['approved', 'sent', 'quote_sent'].includes(c.status)).length : state.cases.filter(c => c.status === 'approved').length,
    state.cases.filter(c => c.status === 'blocked').length,
    state.cases.filter(c => c.draft && !c.draft.rule_citations.length).length];
  return ['Received', 'Drafted', 'Approved', 'Blocked', 'Rules gaps'].map((label, i) => `<div class="stat"><strong>${values[i]}</strong><span>${label}</span></div>`).join('');
}
function staleDraft(draft) {
  if (store.mode === 'demo') return draft.rules_version !== state.rules.version;
  return Object.entries(draft.rules_versions ?? {}).some(([domain, version]) => state.domains.find(r => r.domain === domain)?.version !== version);
}
function decisionBadges(item) {
  const d = item.draft;
  return `<div class="decision-badges">${d ? chip(d.gate_verdict, `Gate: ${{pass:'PASS',review:'REVIEW',block:'BLOCK'}[d.gate_verdict]}`) : ''}${chip(statuses[item.status]?.[0] ?? 'neutral', `Status: ${item.status}`)}${d ? `<strong class="action-amount">${d.amount_cents == null ? '' : money(d.amount_cents)} ${escape(d.action_type ?? 'reply')}</strong>` : ''}</div>`;
}
function caseRows() {
  const cases = state.cases.filter((item) => (filter === 'all' || (filter === 'gap' ? item.draft && !item.draft.rule_citations.length : item.status === filter)) && `${escape(item.customer ?? 'Guest')} ${escape(item.title)} ${escape(domainLabel(item.domain) ?? 'Unrouted')}`.toLowerCase().includes(query.toLowerCase()));
  return cases.length ? cases.map((item) => `<button class="case-row ${item.id === selectedId ? 'selected' : ''}" data-case="${item.id}" aria-pressed="${item.id === selectedId}">
    <span class="case-person"><span class="avatar ${escape((item.domain ?? 'unrouted').toLowerCase())}">${initials(item.customer)}</span><span><strong>${escape(item.customer ?? 'Guest')}</strong><small>${escape(channelLabel(item.channel))} <span aria-hidden="true">·</span> ${escape(domainLabel(item.domain) ?? 'Unrouted')}</small></span><span class="case-dot ${statuses[item.status][0]}" aria-label="${statuses[item.status][1]}"></span></span>
    <span class="case-subject">${escape(item.title)}</span><span class="case-bottom">${chip(...statuses[item.status])}<small>v${item.draft?.rules_version ?? '-'}</small></span>
  </button>`).join('') : '<div class="empty"><strong>No matching cases</strong><p>Try a different search or add a message from the demo controls.</p></div>';
}
function inbox() {
  return `<aside class="panel inbox" aria-labelledby="inbox-heading"><div class="panel-heading"><h2 id="inbox-heading">Cases <span class="count">${state.cases.length}</span></h2>${icon('inbox')}</div>
    <label class="search">${icon('search')}<input id="case-search" type="search" placeholder="Find a case" aria-label="Search cases" value="${escape(query)}"></label>
    <label class="filter-label">Show <select id="case-filter"><option value="all" ${filter === 'all' ? 'selected' : ''}>All cases</option><option value="held" ${filter === 'held' ? 'selected' : ''}>Needs approval</option><option value="blocked" ${filter === 'blocked' ? 'selected' : ''}>Blocked</option><option value="gap" ${filter === 'gap' ? 'selected' : ''}>Rules gaps</option></select></label>
    <div id="case-rows" class="case-rows">${caseRows()}</div><div class="inbox-note">${icon('spark')}<p>Your front desk, in one place.<br><span>${store.mode === 'demo' ? 'Synthetic patient fixtures.' : 'Connected to BizOS.'}</span></p></div>
  </aside>`;
}
function verdictBanner(item) {
  const draft = item.draft;
  if (draft.gate_verdict === 'block') {
    const cap = draft.cap;
    const id = draft.gate_policy_id ?? 'REFUND-CAP';
    return `<div class="gate-banner block" role="status"><div class="gate-title">${icon('shield')}<strong>Blocked by ${escape(id)}${cap == null ? '' : `: ${money(cap)}`}</strong></div><div class="gate-amounts"><span><small>Attempted action</small><b>${money(draft.amount_cents ?? 0)}</b></span>${cap == null ? '' : `<span class="amount-divider">&gt;</span><span><small>Rule cap at check</small><b>${money(cap)}</b></span>`}</div><p>${escape(draft.gate_reason)}. Nothing sent; owner review required.</p></div>`;
  }
  if (item.status === 'escalated' && !draft.rule_citations.length) return `<div class="gate-banner review"><strong>Your rules don't cover this yet</strong><p>A person must review this request.</p></div>`;
  return '';
}
function detail() {
  const item = selected();
  if (!item) return `<main class="panel case-detail empty-detail" id="case-detail"><div class="empty">${icon('inbox')}<h2>A little breathing room.</h2><p>Add a support question, sales lead, or refund from the demo controls to get started.</p></div></main>`;
  const draft = item.draft;
  if (!draft) return `<main class="panel case-detail"><header class="detail-heading"><h2>${escape(item.customer)}</h2></header><div class="detail-scroll">${decisionBadges(item)}<p>${escape(item.message)}</p><p>Waiting for a draft.</p></div></main>`;
  const stale = staleDraft(draft);
  const gate_verdict = { pass: ['pass', 'PASS'], review: ['review', 'REVIEW'], block: ['block', 'BLOCK'] }[draft.gate_verdict];
  const completed = ['approved', 'sent', 'escalated'].includes(item.status);
  return `<main class="panel case-detail" id="case-detail" aria-labelledby="case-title"><header class="detail-heading"><div><div class="detail-context">${escape(domainLabel(item.domain) ?? 'Unrouted')} / ${escape(channelLabel(item.channel))} / <span>${store.mode === 'demo' ? 'Synthetic patient' : 'Live case'}</span></div><h2 id="case-title">${escape(item.title)}</h2><p>${escape(item.customer)} <span class="muted">&lt;${escape(item.reply_to)}&gt;</span></p></div>${chip('neutral', `Rules v${draft.rules_version}`)}</header>
    <div class="detail-scroll">${decisionBadges(item)}${verdictBanner(item)}
      <section class="conversation" aria-label="Customer conversation"><div class="message-label"><span class="avatar ${escape((item.domain ?? 'unrouted').toLowerCase())}">${initials(item.customer)}</span><strong>${escape(item.customer ?? 'Guest')}</strong><time>${time(item.at)}</time></div><div class="message-bubble">${escape(item.message)}</div><small class="fixture-note">${item.unsafe ? 'Unsafe suggestion fixture / deliberately proposes an over-cap refund' : store.mode === 'demo' ? 'Simulated inbound message' : 'Received by the BizOS server'}</small></section>
      <section class="draft" aria-labelledby="draft-heading"><div class="draft-heading"><h3 id="draft-heading">${icon('spark')}${draft.gate_verdict === 'block' ? 'Blocked suggestion' : 'Front desk draft'}</h3>${chip(...gate_verdict)}</div><p class="held-reason">${escape(draft.gate_reason ?? '')}</p><p class="draft-text">${escape(draft.text)}</p><div class="citations">${citations(draft)}</div><div class="draft-binding"><span>Draft v${draft.version} / rules v${draft.rules_version}</span><span>To: ${escape(draft.reply_to)} / ${escape(channelLabel(draft.channel))}</span></div></section>
      ${stale && !completed ? `<div class="stale"><strong>Rules changed to v${state.rules.version}</strong><p>This draft still shows its original policy check. Recheck it before a decision.</p><button class="button secondary" data-recheck="${item.id}">Recheck draft</button></div>` : ''}
      ${draft.gate_verdict === 'block' ? '<div class="owner-next"><strong>The owner takes it from here.</strong><p>Suggested response: “Thanks for letting us know. I have passed your request to the owner for a personal review.”</p></div>' : ''}
      ${item.status === 'held' && !stale ? `<div class="detail-actions"><span>Ready for your review in the approval queue.</span><button class="button secondary" data-focus-approval="${item.id}">Review reply ${icon('arrow')}</button></div>` : ''}
      ${completed ? `<div class="completion ${item.status === 'rejected' ? 'review' : 'pass'}">${icon('check')}<span><strong>${statuses[item.status][1]}</strong><br>${store.mode === 'demo' ? 'Local demo decision. No message sent.' : item.status === 'sent' ? 'Reply sent by the server.' : 'Server status shown above. Approval never makes a payment.'}</span></div>` : ''}
    </div><footer class="detail-footer"><span class="small-dot"></span>${store.mode === 'demo' ? 'Fixture simulation' : 'Live Policy Gate'} <span>Auto-send off</span></footer></main>`;
}
function approvalQueue() {
  const items = state.cases.filter((item) => item.status === 'held').toReversed();
  approvalIndex = Math.min(approvalIndex, Math.max(0, items.length - 1));
  const visible = items.slice(approvalIndex, approvalIndex + 1);
  return `<section class="panel approvals" aria-labelledby="approvals-heading"><div class="panel-heading"><h2 id="approvals-heading">Your approval <span class="count amber">${items.length}</span></h2><span class="muted">Replies only</span></div><div class="approval-items">${items.length ? visible.map((item) => {
    const d = item.draft;
    const stale = staleDraft(d);
    return `<article class="approval-card" id="approval-${item.id}">${decisionBadges(item)}<div class="approval-title"><button data-case="${item.id}" title="Read the full draft for ${escape(item.customer)}">${escape(item.customer)}</button>${d.amount_cents ? chip('neutral', money(d.amount_cents)) : chip('neutral', domainLabel(item.domain))}</div><p>${escape(d.text)}</p><p class="held-reason">${escape(d.gate_reason ?? '')}</p><div class="citations">${citations(d)}</div><div class="approval-binding">Draft v${d.version} / rules v${d.rules_version}<br>To: ${escape(d.reply_to)} / ${escape(channelLabel(d.channel))}</div>${stale ? `<button class="button secondary full stale-recheck" data-recheck="${item.id}">Rules changed. Recheck draft</button>` : `<div class="approval-actions"><button class="button primary" data-review="approve" data-id="${item.id}">${icon('check')}Approve reply</button><button class="button secondary" data-review="reject" data-id="${item.id}">Reject</button></div>`}</article>`;
  }).join('') : '<div class="empty"><span class="empty-check">✓</span><strong>You’re all caught up.</strong><p>Replies that need your review will appear here.</p></div>'}</div>${items.length ? `<div class="queue-pager"><button class="pager-button" data-approval-page="-1" ${approvalIndex === 0 ? 'disabled' : ''} aria-label="Previous approval">‹</button><span>${approvalIndex + 1} of ${items.length} replies</span><button class="pager-button" data-approval-page="1" ${approvalIndex === items.length - 1 ? 'disabled' : ''} aria-label="Next approval">›</button></div>` : ''}<p class="approval-note">${store.mode === 'demo' ? 'Local approval only. Nothing is sent.' : 'Approves a reply, never a payment.'}</p></section>`;
}
function auditFeed() {
  auditIndex = Math.min(auditIndex, Math.max(0, state.audit.length - 1));
  return `<section class="panel audit" aria-labelledby="audit-heading"><div class="panel-heading"><h2 id="audit-heading">Audit feed</h2><span class="clock-label">${store.mode === 'demo' ? 'Demo time' : 'Live events'}</span></div><div class="audit-items">${state.audit.length ? state.audit.slice(auditIndex, auditIndex + 1).map((entry) => `<div class="audit-entry"><span class="audit-marker ${entry.tone}"></span><div><div class="audit-event-top">${entry.case_id ? `<button class="audit-link" data-case="${entry.case_id}">${escape(entry.title)}</button>` : `<strong>${escape(entry.title)}</strong>`}<time>${time(entry.at)}</time></div><p title="${escape(entry.detail)}">${escape(entry.detail)}</p></div></div>`).join('') : '<div class="empty"><strong>A clean slate.</strong><p>New demo decisions will be recorded here.</p></div>'}</div>${state.audit.length ? `<div class="audit-pager"><button class="pager-button" data-audit-page="-1" ${auditIndex === 0 ? 'disabled' : ''}>Newer</button><span>${auditIndex + 1} / ${state.audit.length}</span><button class="pager-button" data-audit-page="1" ${auditIndex === state.audit.length - 1 ? 'disabled' : ''}>Older</button></div>` : ''}</section>`;
}
function readout() {
  if (store.mode === 'demo') return `<strong>Demo limits - fixture simulation</strong><div><span>REFUND-CAP</span><b>${money(state.rules.compiled.cap)}</b></div>`;
  return `<strong>Server-compiled policy</strong>${state.rules.policy.map(p => `<div><span>${escape(p.id)} (${escape(p.outcome)})</span><b>${money(p.limit_cents)}</b></div>`).join('') || '<p>No limits in this file.</p>'}${[...(state.rules.warnings ?? []), ...(state.rules.error?.errors ?? [])].map(w => `<p class="form-error">${escape(w)}</p>`).join('')}`;
}
function rulesEditor() {
  return `<aside class="panel rules-panel" aria-labelledby="rules-heading"><div class="panel-heading"><h2 id="rules-heading">Your rules ${chip('blue', `v${state.rules.version}`)}</h2><button class="icon-button" id="close-rules" aria-label="Close rules editor">${icon('close')}</button></div><p class="rules-intro">One file shapes the demo’s answers and policy checks. Amounts are in cents.</p><form id="rules-form"><label for="rules-text">${store.mode === 'live' ? `<select id="rules-domain" aria-label="Rules domain">${state.domains.map(r => `<option value="${escape(r.domain)}" ${r.domain === state.rules.domain ? 'selected' : ''}>${escape(r.domain)}.rules.md</option>`).join('')}</select>` : 'company.rules.md'}</label><textarea id="rules-text" spellcheck="false" aria-describedby="rules-help rules-error">${escape(editorText)}</textarea><p id="rules-help">Try changing 20000 to 25000, then save and add a $225 request.</p><p id="rules-error" class="form-error" role="alert"></p><div class="rules-buttons"><button class="button primary" type="submit">Save rules</button><button class="button secondary" type="button" id="reload-rules">Reload active</button></div></form><div id="compiled-limits" class="compiled-limits">${readout()}</div>${state.rules.diff.length ? `<div class="rule-diff"><h3>Saved change / v${state.rules.version - 1} → v${state.rules.version}</h3>${state.rules.diff.map((line) => `<${line.op === 'del' ? 'del' : 'ins'}>${escape(line.text)}</${line.op === 'del' ? 'del' : 'ins'}>`).join('')}</div>` : ''}<p class="rules-boundary">${store.mode === 'demo' ? 'Narrow fixture editor. No server policy is changed.' : 'Limits come only from the API compiled policy. Existing drafts keep their original versions.'}</p></aside>`;
}
function render() {
  state = store.snapshot();
  if (!state.cases.some(c => c.id === selectedId)) selectedId = state.cases[0]?.id;
  document.querySelector('#app').innerHTML = `<div class="app-shell"><header class="app-header"><a class="brand" href="./" aria-label="BizOS owner desk"><span class="brand-mark">b<span></span></span><strong>BizOS</strong><span class="brand-divider"></span><span class="workspace-name">Owner desk</span></a><div class="header-actions"><span class="mode-badge"><span class="small-dot"></span>${store.mode === 'demo' ? 'Demo mode' : 'Live mode'}</span><button class="button secondary rules-toggle" id="toggle-rules" aria-expanded="${rulesOpen}">${icon('rule')}${rulesOpen ? 'Show cases' : 'Edit rules'}<span class="version-pill">v${state.rules.version}</span></button><span class="owner-avatar" title="Demo owner">K</span></div></header>
    <div class="overview"><div class="overview-title"><h1>A front desk that knows your rules.</h1><p>Review the exceptions. See every decision.</p></div><div class="stats" aria-label="Counts for loaded cases">${stats()}</div></div>
    <div class="demo-disclosure"><span>${icon('inbox')}<strong>${store.mode === 'demo' ? 'Demo data - start the BizOS server for live mode' : 'Live mode - every non-blocked reply waits for approval'}</strong></span><span>${store.mode === 'demo' ? 'Synthetic patients / resets on refresh' : 'Updates every 2 seconds'}</span></div>
    ${notice ? `<div class="notice ${noticeError ? 'error' : ''}" role="${noticeError ? 'alert' : 'status'}">${escape(notice)}<button class="icon-button" id="dismiss-notice" aria-label="Dismiss notification">${icon('close')}</button></div>` : ''}
    <div class="workspace ${rulesOpen ? 'rules-open' : ''}">${rulesOpen ? rulesEditor() : inbox()}${detail()}<aside class="right-rail" aria-label="Approvals and audit activity">${approvalQueue()}${auditFeed()}</aside></div>
    <footer class="demo-controls"><div class="controls-label">${icon('spark')}<span><strong>Demo controls</strong><small>Deterministic fixture inputs</small></span></div><div class="fixture-buttons"><button class="button fixture" data-inject="hours"><span class="key">1</span>Hours question</button><button class="button fixture" data-inject="sales"><span class="key">2</span>New patient</button><button class="button fixture" data-inject="refund"><span class="key">3</span>$225 request</button><button class="button danger-outline" data-inject="unsafe">${icon('shield')}Unsafe $500</button></div><div class="reset-controls" ${store.mode === 'live' ? 'hidden' : ''}><button class="text-button" id="empty-demo">Start empty</button><button class="button secondary" id="reset-demo">${icon('reset')}Reset demo</button></div></footer><p class="simulation-note">Rev 2 / ${store.mode === 'demo' ? 'Fixture simulation only. Nothing leaves this page.' : 'Demo controls submit synthetic messages and labeled fixture suggestions to the real gate. No model is called.'}</p></div>`;
}
function notify(message, error = false) { notice = message; noticeError = error; render(); }
async function openRules(citation) {
  if (store.mode === 'live' && citation) {
    await store.selectCitation(citation);
    state = store.snapshot(); editorText = state.rules.text; editorVersion = state.rules.version;
  }
  rulesOpen = true;
  render();
  if (citation) {
    const textarea = document.querySelector('#rules-text');
    const policyIndex = editorText.indexOf(`  ${citation}:`);
    const index = policyIndex >= 0 ? policyIndex : Math.max(editorText.indexOf(`- ${citation}:`), editorText.indexOf(`- [${citation}]`));
    if (index >= 0) {
      textarea.focus();
      textarea.setSelectionRange(index, editorText.indexOf('\n', index) < 0 ? editorText.length : editorText.indexOf('\n', index));
      textarea.scrollTop = Math.max(0, (editorText.slice(0, index).split('\n').length - 4) * 20);
    }
  }
}
function reset(empty) {
  state = store.reset(empty);
  selectedId = state.cases[0]?.id;
  editorText = state.rules.text;
  editorVersion = state.rules.version;
  query = '';
  filter = 'all';
  approvalIndex = 0;
  auditIndex = 0;
  rulesOpen = false;
  notify(empty ? 'Empty workspace ready. Add a fixture to begin.' : 'Demo reset to the original fixtures and $200 cap.');
}
document.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  try {
    if (button.dataset.approvalPage) { approvalIndex += Number(button.dataset.approvalPage); render(); }
    else if (button.dataset.auditPage) { auditIndex += Number(button.dataset.auditPage); render(); }
    else if (button.dataset.case) { selectedId = button.dataset.case; render(); }
    else if (button.dataset.citation) await openRules(button.dataset.citation);
    else if (button.dataset.inject) {
      const item = await store.inject(button.dataset.inject);
      auditIndex = 0;
      selectedId = item.id;
      notify(`${escape(item.customer ?? 'Guest')} fixture added. ${statuses[item.status][1]}.`);
    } else if (button.dataset.recheck) {
      await store.recheck(button.dataset.recheck);
      auditIndex = 0;
      notify('Draft rechecked against the active rules. No message sent.');
    } else if (button.dataset.review) {
      const item = state.cases.find((entry) => entry.id === button.dataset.id);
      await store.review(item.id, button.dataset.review, item.draft);
      auditIndex = 0;
      notify(store.mode === 'demo' ? 'Demo decision recorded. Nothing sent.' : 'Server decision recorded.');
    } else if (button.dataset.focusApproval) {
      approvalIndex = state.cases.filter((item) => item.status === 'held').toReversed().findIndex((item) => item.id === button.dataset.focusApproval);
      render();
      document.querySelector(`#approval-${button.dataset.focusApproval}`).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      document.querySelector(`#approval-${button.dataset.focusApproval} [data-review]`)?.focus({ preventScroll: true });
    } else if (button.id === 'toggle-rules' || button.id === 'close-rules') { rulesOpen = !rulesOpen; render(); }
    else if (button.id === 'reload-rules') { if (store.mode === 'live') { await store.refresh(); state = store.snapshot(); } editorText = state.rules.text; editorVersion = state.rules.version; render(); }
    else if (button.id === 'reset-demo') reset(false);
    else if (button.id === 'empty-demo') reset(true);
    else if (button.id === 'dismiss-notice') { notice = ''; render(); }
  } catch (error) { notify(error.message, true); }
});
document.addEventListener('input', event => {
  if (event.target.id === 'rules-text') editorText = event.target.value;
  if (event.target.id === 'case-search') { query = event.target.value; document.querySelector('#case-rows').innerHTML = caseRows(); }
});
document.addEventListener('change', async event => {
  if (event.target.id === 'case-filter') { filter = event.target.value; render(); }
  if (event.target.id === 'rules-domain') {
    try { await store.selectDomain(event.target.value); state = store.snapshot(); editorText = state.rules.text; editorVersion = state.rules.version; render(); }
    catch (e) { notify(e.message, true); }
  }
});
document.addEventListener('submit', async event => {
  if (event.target.id !== 'rules-form') return;
  event.preventDefault();
  try {
    await store.saveRules(editorText, editorVersion);
    state = store.snapshot(); editorText = state.rules.text; editorVersion = state.rules.version;
    notify(`Saved rules v${editorVersion}. Send the next request to use the new version. Held drafts retain their old versions.`);
  } catch (e) { document.querySelector('#rules-error').textContent = e.message; }
});
render();
if (store.mode === 'live') setInterval(async () => {
  if (document.activeElement?.closest('form, .approval-card')) return;
  try { await store.refresh(); render(); }
  catch (e) { notify(`Live connection interrupted. Showing the last loaded data. ${e.message}`, true); }
}, 2000);
