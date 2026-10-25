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
let filter = 'all';
let sideTab = 'rules';
let notice = connectionError;
let noticeError = Boolean(connectionError);
let pending = '';
let flashUntil = 0;
let seenVersions = versionKey();

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const time = (at) => (at ?? '').slice(11, 16);
const shortId = (id) => String(id ?? '').slice(0, 8);
const domainTag = (domain) => esc(String(domain ?? 'unrouted').toUpperCase());
const statusPill = {
  held: ['hold', 'GATE HOLD'], blocked: ['block', 'BLOCKED'], escalated: ['block', 'ESCALATED'], sent: ['ok', 'SENT'], quote_sent: ['ok', 'QUOTE SENT'],
  approved: ['ok', 'APPROVED'], new: ['neutral', 'NEW'], routed: ['neutral', 'ROUTED'], drafted: ['neutral', 'DRAFTED'],
};
const verdictPill = { pass: ['ok', 'PASS'], review: ['hold', 'REVIEW'], block: ['block', 'BLOCK'] };
const pill = (tone, label, extra = '') => `<span class="pill ${tone} ${extra}">${esc(label)}</span>`;
const status = (item) => pill(...(statusPill[item.status] ?? ['neutral', String(item.status).toUpperCase()]));
const selected = () => state.cases.find((item) => item.id === selectedId);
const approvalFor = (id) => state.approvals.find((entry) => entry.case_id === id);
const versionOf = (domain) => state.domains.find((d) => d.domain === domain)?.version;
function versionKey() { return state.domains.map((d) => `${d.domain}:${d.version}`).join(','); }

// The file that defines a rule ID among the rules in force. Policy keys are searched first
// because the gate compiles limits from them; prose IDs come from the loaded rule text.
function fileFor(id) {
  return state.domains.find((d) => d.policy?.some((p) => p.id === id))?.domain ?? state.ruleIndex[id]?.domain;
}
// The rules file behind the decision on screen: the policy that judged the selected draft,
// else the file that holds the refund cap. Never a hardcoded file name or version.
function fileInPlay() {
  const draft = selected()?.draft;
  const id = draft?.gate_policy_id ?? draft?.rule_citations?.[0];
  return (id && fileFor(id)) ?? fileFor('REFUND-CAP') ?? state.domains[0]?.domain;
}
function citation(id, draft) {
  const domain = fileFor(id);
  const version = draft?.rules_versions?.[domain] ?? versionOf(domain);
  return `<button class="cite" data-citation="${esc(id)}" title="Open ${esc(id)} in the rules">§ ${esc(id)}${domain ? ` · ${esc(domain)} v${esc(version)}` : ''}</button>`;
}
// Files whose version moved since the draft was checked. A company edit leaves the
// department's rules_version unchanged, so every file in rules_versions is compared.
function staleRules(draft) {
  return Object.entries(draft?.rules_versions ?? {}).map(([domain, from]) => ({ domain, from, to: versionOf(domain) })).filter((change) => change.to !== change.from);
}
const staleSummary = (draft) => staleRules(draft).map(({ domain, from, to }) => `${domain} v${from} → ${to == null ? 'removed' : `v${to}`}`).join(', ');
function counts() {
  const values = [state.cases.length, state.cases.filter((c) => c.draft).length,
    state.cases.filter((c) => ['approved', 'sent', 'quote_sent'].includes(c.status)).length,
    // Every draft the gate refused, so a block still counts after a re-run under new rules.
    state.cases.reduce((n, c) => n + (c.drafts ?? [c.draft]).filter((d) => d?.gate_verdict === 'block').length, 0)];
  return ['Received', 'Drafted', 'Approved', 'Blocked'].map((label, i) => `<span class="count"><b>${values[i]}</b>${label}</span>`).join('');
}

function topBar() {
  const file = fileInPlay();
  const flash = Date.now() < flashUntil ? 'flash' : '';
  const live = store.mode === 'live';
  const down = live && noticeError && notice.startsWith('Live connection interrupted');
  return `<header class="topbar"><div class="brand"><strong>BizOS</strong><span class="pack">Dental Office Demo</span>${live ? '' : '<span class="pack demo">Demo data · server offline</span>'}</div>
    <div class="counts" aria-label="Case counts">${counts()}</div>
    <div class="top-actions">${file ? `<button class="rules-pill ${flash}" data-open-rules="${esc(file)}" title="Rules in force for the case on screen. Click to edit.">RULES ${esc(file)} · v${esc(versionOf(file))}</button>` : ''}
    <span class="heartbeat ${down ? 'down' : live ? '' : 'demo'}" role="status"><span class="dot"></span>${down ? 'Reconnecting' : live ? 'Live API' : 'Fixtures'}</span>
    <a class="stage-link" href="./demo.html">Stage view</a></div></header>`;
}

function inFilter(item) {
  if (filter === 'hold') return Boolean(approvalFor(item.id));
  if (filter === 'blocked') return item.status === 'blocked';
  if (filter === 'sent') return ['sent', 'quote_sent', 'approved'].includes(item.status);
  return true;
}
function queueRows() {
  // The Gate Hold tab follows the server's approval queue order: urgent escalations first.
  const cases = filter === 'hold' ? state.approvals.map((entry) => state.cases.find((c) => c.id === entry.case_id)).filter(Boolean) : state.cases.filter(inFilter);
  if (!cases.length) return `<p class="empty">${filter === 'all' ? 'No cases yet. Simulate a patient message below.' : 'Nothing here right now.'}</p>`;
  return cases.map((item) => `<button class="row ${item.id === selectedId ? 'active' : ''}" data-case="${esc(item.id)}" aria-pressed="${item.id === selectedId}">
    <strong>${esc(item.customer ?? 'Guest')}</strong><span class="row-pills">${approvalFor(item.id)?.urgent ? pill('block', 'URGENT', 'solid') : ''}${status(item)}<span class="domain">${domainTag(item.domain)}</span></span></button>`).join('');
}
function queue() {
  const tabs = [['all', 'All', state.cases.length], ['hold', 'Gate Hold', state.approvals.length], ['blocked', 'Blocked', null], ['sent', 'Sent', null]];
  return `<aside class="pane queue" aria-label="Case queue"><div class="pane-head"><h2>Cases</h2></div>
    <div class="tabs" role="tablist">${tabs.map(([id, label, n]) => `<button role="tab" aria-selected="${filter === id}" data-filter="${id}">${label}${n == null ? '' : `<span class="badge ${id === 'hold' && n ? 'amber' : ''}">${n}</span>`}</button>`).join('')}</div>
    <div class="rows scroll" id="rows">${queueRows()}</div>
    <div class="simulate"><span class="label">Simulate a patient message</span><div class="sim-buttons">
      <button class="sim" data-inject="sales">New patient</button><button class="sim warn" data-inject="unsafe">$500 refund</button>
      <button class="sim" data-inject="hours">Hours</button><button class="sim" data-inject="gap">Coverage</button></div>
      ${store.mode === 'demo' ? '<div class="sim-reset"><button class="link" id="empty-demo">Start empty</button><button class="link" id="reset-demo">Reset demo</button></div>' : ''}
      <small>${store.mode === 'demo' ? 'Fixture simulation in this page. Nothing is sent.' : 'Posts a synthetic message and a scripted draft to the real gate. No model call.'}</small></div></aside>`;
}

function thread(item) {
  const messages = item.messages?.length ? item.messages : [{ direction: 'in', text: item.message, received_at: item.at }];
  return messages.map((m) => `<div class="msg ${m.direction === 'out' ? 'out' : 'in'}"><div class="bubble">${esc(m.text)}</div><small>${m.direction === 'out' ? 'Clinic' : esc(item.customer ?? 'Patient')} · ${esc(time(m.received_at ?? m.sent_at ?? m.created_at))}</small></div>`).join('');
}
function blockBanner(draft) {
  const file = fileFor(draft.gate_policy_id);
  const version = draft.rules_versions?.[file] ?? draft.rules_version;
  const parts = [`BLOCKED: ${draft.gate_policy_id ?? 'POLICY'}`, draft.amount_cents == null ? '' : `Requested: ${money(draft.amount_cents)}`,
    draft.cap == null ? '' : `Maximum permitted: ${money(draft.cap)}`, `Rules version: v${version}`].filter(Boolean);
  return `<div class="block-banner" role="status"><strong>${parts.map(esc).join(' · ')}</strong><span>${esc(draft.gate_reason)}. Nothing was sent; the owner takes it from here.</span></div>`;
}
function draftSections(item, draft) {
  const evidence = draft.evidence ?? [];
  const missing = draft.missing_info ?? [];
  return `<div class="draft-text"><span class="to">To: ${esc(item.reply_to ?? draft.reply_to)}</span>${esc(draft.text)}</div>
    <div class="info-grid">${evidence.length ? `<section><h4>Supporting information</h4><ul>${evidence.map((e) => `<li>${citation(e.rule_id, draft)}<q>${esc(e.quote)}</q></li>`).join('')}</ul></section>` : ''}
    ${missing.length ? `<section><h4>Required information</h4><ul class="missing">${missing.map((m) => `<li>${esc(m)}</li>`).join('')}</ul></section>` : ''}</div>`;
}
function gateBox(item) {
  const draft = item.draft;
  if (!draft) return `<div class="gate quiet"><strong>Waiting for a draft</strong><span>An agent is working on this message.</span></div>`;
  const approval = approvalFor(item.id);
  const stale = staleRules(draft).length > 0;
  const chips = draft.rule_citations.length ? draft.rule_citations.map((id) => citation(id, draft)).join('') : pill('hold', 'NO RULE CITED');
  const reason = draft.amount_cents == null ? 'Reply review' : `${draft.action_type ?? 'money'} · ${money(draft.amount_cents)}`;
  const rerun = `<button class="btn rerun" data-rerun="${esc(item.id)}" ${pending ? 'disabled' : ''}>${pending === `rerun:${item.id}` ? 'Re-running…' : 'Re-run same request'}</button>`;
  if (draft.gate_verdict === 'block') {
    return `<div class="gate blocked">${blockBanner(draft)}<div class="gate-head"><strong>Blocked suggestion · draft v${esc(draft.version)}</strong><span class="chips">${chips}</span></div>${draftSections(item, draft)}
      <div class="actions"><span class="hint">${stale ? `Rules changed since this check: ${esc(staleSummary(draft))}.` : 'Edit the rule, then judge this exact request again.'}</span>${rerun}</div></div>`;
  }
  if (approval) {
    const busy = pending.endsWith(`:${draft.id}`);
    return `<div class="gate hold" id="gate"><div class="gate-head"><strong>🔒 GATE HOLD: Owner approval required</strong>${approval.urgent ? pill('block', 'URGENT', 'solid') : ''}<span class="reason">${esc(reason)}</span><span class="chips">${chips}</span></div>
      ${draft.gate_reason ? `<p class="gate-reason">${esc(draft.gate_reason)}</p>` : ''}${draftSections(item, draft)}
      <div class="actions">${stale && item.status === 'held' ? `<span class="hint">Rules changed: ${esc(staleSummary(draft))}. Judge it under the current rules first.</span>${rerun}`
        : `<span class="hint">Draft v${esc(draft.version)} · approves a reply, never a payment</span>
        <button class="btn escalate" data-review="reject" data-id="${esc(item.id)}" ${pending ? 'disabled' : ''}>${busy && pending.startsWith('reject') ? 'Escalating…' : item.status === 'escalated' ? 'Handle in person' : 'Escalate'}</button>
        <button class="btn approve" data-review="approve" data-id="${esc(item.id)}" ${pending ? 'disabled' : ''}>${busy && pending.startsWith('approve') ? 'Approving…' : 'Approve &amp; Send'}</button>`}</div></div>`;
  }
  const done = { sent: '✓ Sent to the patient', quote_sent: '✓ Quote sent', approved: '✓ Approved · sending now', escalated: '! Escalated · the owner handles it in person' }[item.status] ?? `Status: ${item.status}`;
  return `<div class="gate quiet ${['sent', 'quote_sent', 'approved'].includes(item.status) ? 'ok' : 'err'}"><strong>${esc(done)}</strong><span class="hint">Draft v${esc(draft.version)}</span><span class="chips">${chips}</span></div>`;
}
function caseView() {
  const item = selected();
  if (!item) return `<main class="pane stage"><p class="empty center">No case selected. Simulate a patient message to begin.</p></main>`;
  const verdict = item.draft ? pill(...verdictPill[item.draft.gate_verdict]) : '';
  return `<main class="pane stage" aria-labelledby="case-title"><header class="case-head"><div><h1 id="case-title">${esc(item.customer ?? 'Guest')}</h1>
      <p><span class="mono">#${esc(shortId(item.id))}</span> · <span class="domain">${domainTag(item.domain)}</span> · ${esc(item.channel)} · ${esc(item.reply_to)}</p></div>
      <div class="case-badges">${verdict ? `<span class="badge-label">Gate</span>${verdict}` : ''}<span class="badge-label">Status</span>${status(item)}</div></header>
    ${noticeStrip()}<div class="thread scroll" id="thread">${thread(item)}</div>${gateBox(item)}</main>`;
}
function noticeStrip() {
  return notice ? `<div class="notice ${noticeError ? 'error' : ''}" role="${noticeError ? 'alert' : 'status'}"><span>${esc(notice)}</span><button class="link" id="dismiss-notice" aria-label="Dismiss">✕</button></div>` : '';
}

function rulesEditor() {
  const r = state.rules;
  const options = state.domains.map((d) => `<option value="${esc(d.domain)}" ${d.domain === r.domain ? 'selected' : ''}>${esc(d.domain)}.rules.md · v${esc(d.version)}</option>`).join('');
  return `<main class="pane stage editor" aria-labelledby="editor-title"><header class="case-head"><div><h1 id="editor-title">Rules editor</h1><p>Plain Markdown. Saving bumps the version; the gate uses it on its very next check.</p></div>
      <button class="btn ghost" id="close-rules">Back to case</button></header>${noticeStrip()}
    <form id="rules-form" class="scroll"><label class="file-select">File <select id="rules-domain" ${store.mode === 'demo' ? 'disabled' : ''}>${options}</select></label>
      <textarea id="rules-text" spellcheck="false" aria-label="Rules file text">${esc(editorText)}</textarea><p id="rules-error" class="form-error" role="alert"></p>
      <div class="editor-actions"><button class="btn approve" type="submit">Save rules</button><button class="btn ghost" type="button" id="reload-rules">Reload active</button>
      ${store.mode === 'demo' ? '<span class="hint">Fixture editor: change the amounts or hours only.</span>' : ''}</div>
      ${r.diff.length ? `<div class="diff"><h4>Saved · ${esc(r.domain)} v${esc(r.version - 1)} → v${esc(r.version)}</h4>${r.diff.map((line) => `<${line.op === 'del' ? 'del' : 'ins'}><b aria-hidden="true">${line.op === 'del' ? '−' : '+'}</b>${esc(line.text)}</${line.op === 'del' ? 'del' : 'ins'}>`).join('')}</div>` : ''}</form></main>`;
}

function inspector() {
  const item = selected();
  const draft = item?.draft;
  const file = fileInPlay();
  const limits = state.domains.find((d) => d.domain === file)?.policy ?? [];
  const checked = draft?.rules_versions?.[file];
  const body = sideTab === 'activity' ? activity() : `
    <section class="card"><h3>Rule in force</h3>${file ? `<p class="file mono">${esc(file)}.rules.md · v${esc(versionOf(file))}</p>
      ${checked != null && checked !== versionOf(file) ? `<p class="hint">This draft was checked under v${esc(checked)}.</p>` : ''}
      <ul class="limits">${limits.map((p) => `<li><span class="mono">${esc(p.id)}</span><span class="mono">${money(p.limit_cents)}</span>${pill(p.outcome === 'block' ? 'block' : 'hold', p.outcome.toUpperCase())}</li>`).join('') || '<li class="hint">No limits in this file.</li>'}</ul>
      <button class="btn ghost full" data-open-rules="${esc(file)}">Edit ${esc(file)}.rules.md</button>` : '<p class="hint">No rules loaded.</p>'}</section>
    ${draft ? `<section class="card"><h3>Citations</h3>${draft.rule_citations.length ? `<ul class="cites">${draft.rule_citations.map((id) => {
      const quote = draft.evidence?.find((e) => e.rule_id === id)?.quote;
      return `<li>${citation(id, draft)}<p>${esc(quote ?? state.ruleIndex[id]?.text.replace(/^- /, '') ?? 'Not found in the current rules.')}</p></li>`;
    }).join('')}</ul>` : '<p class="hint">No rule cited, so a person must review it.</p>'}</section>
    <section class="card"><h3>Gate result</h3><dl class="gate-result">
      <dt>Verdict</dt><dd>${pill(...verdictPill[draft.gate_verdict])}</dd>
      <dt>Policy</dt><dd class="mono">${esc(draft.gate_policy_id ?? '-')}</dd>
      <dt>Reasons</dt><dd>${esc(draft.gate_reason ?? '-')}</dd>
      <dt>Rules</dt><dd class="mono">${esc(Object.entries(draft.rules_versions ?? {}).map(([d, v]) => `${d} v${v}`).join(', ') || `v${draft.rules_version}`)}</dd></dl>
      ${history(item)}</section>` : ''}`;
  return `<aside class="pane inspector" aria-label="Rules inspector"><div class="tabs" role="tablist"><button role="tab" aria-selected="${sideTab === 'rules'}" data-side="rules">Rules &amp; gate</button><button role="tab" aria-selected="${sideTab === 'activity'}" data-side="activity">Activity<span class="badge">${state.audit.length}</span></button></div>
    <div class="scroll inspector-body" id="inspector">${body}</div></aside>`;
}
// Every draft the gate judged on this case, so the threshold beat shows BLOCK then the new verdict.
function history(item) {
  const drafts = item.drafts ?? [];
  if (drafts.length < 2) return '';
  return `<h4>Draft history</h4><ol class="history">${drafts.map((d) => {
    const versions = typeof d.rules_versions === 'string' ? JSON.parse(d.rules_versions) : d.rules_versions ?? {};
    return `<li><span class="mono">v${esc(d.version)}</span>${pill(...verdictPill[d.gate_verdict])}<span class="mono">${esc(Object.entries(versions).map(([k, v]) => `${k} v${v}`).join(', '))}</span></li>`;
  }).join('')}</ol>`;
}
function activity() {
  if (!state.audit.length) return '<p class="empty">No activity yet.</p>';
  const who = (id) => state.cases.find((c) => c.id === id)?.customer;
  return `<ol class="feed">${state.audit.map((entry) => `<li class="${esc(entry.tone)}"><div><strong>${entry.case_id ? `<button class="link" data-case="${esc(entry.case_id)}">${esc(entry.title)}</button>` : esc(entry.title)}</strong><time>${esc(time(entry.at))}</time></div><p>${who(entry.case_id) ? `${esc(who(entry.case_id))} · ` : ''}${esc(entry.detail)}</p></li>`).join('')}</ol>`;
}

let renderedFingerprint = '';
// Scroll containers that a re-render would otherwise reset.
const scrollRegions = ['#rows', '#thread', '#inspector', '#rules-form', '#rules-text', '.gate'];
function render({ keepView = false } = {}) {
  state = store.snapshot();
  renderedFingerprint = JSON.stringify(state);
  const versions = versionKey();
  if (versions !== seenVersions) { flashUntil = Date.now() + 1600; seenVersions = versions; }
  if (!state.cases.some((c) => c.id === selectedId)) selectedId = state.cases[0]?.id;
  const scrolls = keepView ? scrollRegions.map((selector) => document.querySelector(selector)?.scrollTop ?? 0) : [];
  const focusId = keepView ? document.activeElement?.id : '';
  document.querySelector('#app').innerHTML = `<div class="shell">${topBar()}<div class="grid">${queue()}${rulesOpen ? rulesEditor() : caseView()}${inspector()}</div></div>`;
  if (keepView) scrolls.forEach((top, i) => { const region = document.querySelector(scrollRegions[i]); if (region) region.scrollTop = top; });
  else document.querySelector('#thread')?.scrollTo({ top: 1e6 });
  if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
}
function notify(message, error = false) { notice = message; noticeError = error; render({ keepView: true }); }
async function openRules(domain, citationId) {
  if (store.mode === 'live') {
    if (citationId) await store.selectCitation(citationId);
    else if (domain) await store.selectDomain(domain);
  }
  state = store.snapshot(); editorText = state.rules.text; editorVersion = state.rules.version;
  rulesOpen = true;
  if (!noticeError) notice = '';
  render();
  const textarea = document.querySelector('#rules-text');
  const index = citationId ? [`- ${citationId}:`, `- [${citationId}]`, `  ${citationId}:`].map((key) => editorText.indexOf(key)).find((i) => i >= 0) : -1;
  if (index != null && index >= 0) {
    textarea.focus();
    const end = editorText.indexOf('\n', index);
    textarea.setSelectionRange(index, end < 0 ? editorText.length : end);
    textarea.scrollTop = Math.max(0, (editorText.slice(0, index).split('\n').length - 4) * 20);
  }
}
function reset(empty) {
  store.reset(empty);
  state = store.snapshot();
  selectedId = state.cases[0]?.id;
  editorText = state.rules.text; editorVersion = state.rules.version;
  filter = 'all'; rulesOpen = false;
  notify(empty ? 'Empty workspace ready. Simulate a message to begin.' : 'Demo reset to the original fixtures and the $200 cap.');
}
async function busy(key, work) {
  pending = key; render({ keepView: true });
  try { await work(); } finally { pending = ''; }
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  try {
    if (button.dataset.case) { selectedId = button.dataset.case; rulesOpen = false; notice = noticeError ? notice : ''; render(); }
    else if (button.dataset.filter) { filter = button.dataset.filter; render({ keepView: true }); }
    else if (button.dataset.side) { sideTab = button.dataset.side; render({ keepView: true }); }
    else if (button.dataset.citation) await openRules(null, button.dataset.citation);
    else if (button.dataset.openRules) await openRules(button.dataset.openRules);
    else if (button.dataset.inject) {
      let item;
      await busy('inject', async () => { item = await store.inject(button.dataset.inject); });
      selectedId = item.id; rulesOpen = false;
      notify(`${item.customer ?? 'Guest'}: message received and judged. ${statusPill[item.status]?.[1] ?? item.status}.`);
    } else if (button.dataset.rerun) {
      const before = selected()?.draft;
      await busy(`rerun:${button.dataset.rerun}`, () => store.recheck(button.dataset.rerun));
      state = store.snapshot();
      const after = state.cases.find((c) => c.id === button.dataset.rerun)?.draft;
      notify(`Same request, judged again: ${before?.gate_verdict?.toUpperCase()} → ${after?.gate_verdict?.toUpperCase()} under the current rules. Nothing sent.`);
    } else if (button.dataset.review) {
      const item = state.cases.find((entry) => entry.id === button.dataset.id);
      const decision = button.dataset.review;
      try { await busy(`${decision}:${item.draft.id}`, () => store.review(item.id, decision, item.draft)); }
      catch (error) {
        if (error.code !== 'rules_changed') throw error;
        // The refusal carries only the department's version, so re-read every file to show which one moved.
        await store.refresh(); render({ keepView: true });
        throw new Error(`Rules changed since this draft was checked: ${staleSummary(state.cases.find((c) => c.id === item.id)?.draft)}. Re-run it first.`);
      }
      document.querySelector('#thread')?.classList.add('confirmed');
      notify(decision === 'approve' ? (store.mode === 'demo' ? 'Approved locally. Demo mode sends nothing.' : 'Approved. The reply is on its way to the patient.') : 'Escalated. The owner handles this case in person.');
    } else if (button.id === 'close-rules') { rulesOpen = false; render(); }
    else if (button.id === 'reload-rules') { if (store.mode === 'live') await store.refresh(); state = store.snapshot(); editorText = state.rules.text; editorVersion = state.rules.version; render(); }
    else if (button.id === 'reset-demo') reset(false);
    else if (button.id === 'empty-demo') reset(true);
    else if (button.id === 'dismiss-notice') { notice = ''; noticeError = false; render({ keepView: true }); }
  } catch (error) { notify(error.message, true); }
});
document.addEventListener('input', (event) => { if (event.target.id === 'rules-text') editorText = event.target.value; });
document.addEventListener('change', async (event) => {
  if (event.target.id !== 'rules-domain') return;
  try { await store.selectDomain(event.target.value); state = store.snapshot(); editorText = state.rules.text; editorVersion = state.rules.version; render(); }
  catch (e) { notify(e.message, true); }
});
document.addEventListener('submit', async (event) => {
  if (event.target.id !== 'rules-form') return;
  event.preventDefault();
  try {
    const from = editorVersion;
    await store.saveRules(editorText, editorVersion);
    state = store.snapshot(); editorText = state.rules.text; editorVersion = state.rules.version;
    notify(from === editorVersion ? 'No change to save.' : `Saved ${state.rules.domain ?? 'company'}.rules.md v${from} → v${editorVersion}. Open the case and re-run the same request.`);
  } catch (e) { document.querySelector('#rules-error').textContent = e.message; }
});

render();
if (store.mode === 'live') {
  // A setTimeout chain, so a slow poll never overlaps the next one.
  const tick = async () => {
    if (!document.activeElement?.closest('form') && !pending) {
      try {
        await store.refresh();
        const recovered = noticeError && notice.startsWith('Live connection interrupted');
        if (recovered) { notice = ''; noticeError = false; }
        if (recovered || JSON.stringify(store.snapshot()) !== renderedFingerprint) render({ keepView: true });
        const beat = document.querySelector('.heartbeat');
        beat?.classList.remove('beat'); void beat?.offsetWidth; beat?.classList.add('beat');
      } catch (e) {
        const message = `Live connection interrupted. Showing the last loaded data. ${e.message}`;
        if (message !== notice) { notice = message; noticeError = true; render({ keepView: true }); }
      }
    }
    setTimeout(tick, 2000);
  };
  setTimeout(tick, 2000);
}
