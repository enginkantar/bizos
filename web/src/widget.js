// The customer's side of the trust boundary. It may know only what the customer
// already knows: their own messages and the replies that were actually sent.
// Case status, drafts, gate reasons, the outbox and reply_to never reach the DOM,
// even though GET /api/cases/:id returns them today (a messages-only route is E2).

import { submitDemoMessage } from './demo-inbox.js';

const POLL_MS = 2000;
const STORE_KEY = 'bizos.widget.cases';

export function buildEnvelope({ messageId, name, email, text }) {
  const envelope = {
    message_id: messageId,
    source: 'webform',
    reply_to: email.trim(),
    content: { type: 'text', text: text.trim() },
  };
  if (name.trim()) envelope.customer = { name: name.trim() };
  return envelope;
}

// In v1 every inbound message opens its own case (#25), so one conversation is
// the union of every remembered case, ordered the way the server ordered it.
// Only the fields the customer may see survive this function.
export function mergeMessages(cases) {
  const seen = new Set();
  const out = [];
  for (const c of cases) {
    for (const m of c?.messages ?? []) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push({
        id: m.id,
        direction: m.direction === 'out' ? 'out' : 'in',
        text: String(m.text ?? ''),
        received_at: String(m.received_at ?? ''),
        source_message_id: m.source_message_id ?? null,
      });
    }
  }
  return out.sort((a, b) => a.received_at.localeCompare(b.received_at) || a.id.localeCompare(b.id));
}

// With no server behind the page (the GitHub Pages copy), Send stays on this page: the
// patient's words appear in the browser-local demo desk, never at a real clinic.
export function demoExchange(text, n) {
  return [
    { id: `demo-${n}-in`, direction: 'in', text },
    { id: `demo-${n}-out`, direction: 'out', demo: true,
      text: 'This is an offline demo. Your message is saved in this browser for the demo owner desk. It did not reach the clinic, no AI ran, and no real reply was sent.' },
  ];
}

// The page is live only when the BizOS API answers its health check.
async function serverUp() {
  try {
    const res = await fetch('./api/health', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
    return res.ok && (await res.json())?.ok === true;
  } catch {
    return false;
  }
}

function loadCaseIds() {
  try {
    const ids = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? '[]');
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function saveCaseIds(ids) {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(ids));
  } catch {
    // Private windows can refuse storage; the chat still works until reload.
  }
}

function start() {
  const $ = (id) => document.getElementById(id);
  const log = $('log');
  const form = $('form');
  const nameInput = $('name');
  const emailInput = $('email');
  const textInput = $('text');
  const sendButton = $('send');
  const errorLine = $('error');
  const connLine = $('conn');
  const demoLine = $('demo');

  const params = new URLSearchParams(location.search);
  nameInput.value = params.get('name') ?? '';
  emailInput.value = params.get('email') ?? '';

  let caseIds = loadCaseIds();
  const cases = new Map();
  // Sends not yet visible in a case: { messageId, text, state: 'sending' | 'failed' | 'sent' }.
  let pending = [];
  let lastFingerprint = '';
  let demo = false;
  const demoMessages = [];

  function remember(caseId) {
    if (caseIds.includes(caseId)) return;
    caseIds = [...caseIds, caseId];
    saveCaseIds(caseIds);
  }

  function bubble(direction, text, note, isDemo = false) {
    const li = document.createElement('li');
    li.className = `msg msg-${direction}${isDemo ? ' msg-demo' : ''}`;
    if (direction === 'out') {
      const who = document.createElement('span');
      who.className = 'msg-who';
      who.textContent = isDemo ? 'Demo reply · not from the clinic' : 'BrightSmile Dental';
      li.append(who);
    }
    const body = document.createElement('p');
    body.textContent = text;
    li.append(body);
    if (note) li.append(note);
    return li;
  }

  function render() {
    const messages = demo ? demoMessages : mergeMessages(caseIds.map((id) => cases.get(id)));
    const shown = new Set(messages.map((m) => m.source_message_id));
    pending = pending.filter((p) => !shown.has(p.messageId));
    // Rebuilding only on change keeps scroll position and text selection still on every tick.
    const fingerprint = JSON.stringify([messages.map((m) => m.id), pending.map((p) => [p.messageId, p.state])]);
    if (fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;

    const items = [];
    if (!messages.length && !pending.length) {
      items.push(bubble('out', 'Hi! Ask us about opening hours, appointments or a bill. A team member checks every reply before it is sent.'));
    }
    for (const m of messages) items.push(bubble(m.direction, m.text, null, m.demo));
    for (const p of pending) {
      let note = null;
      if (p.state === 'failed') {
        note = document.createElement('span');
        note.className = 'msg-note msg-failed';
        note.append('Not sent. ');
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'msg-retry';
        retry.textContent = 'Retry';
        retry.addEventListener('click', () => send(p));
        note.append(retry);
      } else {
        note = document.createElement('span');
        note.className = 'msg-note';
        note.textContent = 'Sending…';
      }
      items.push(bubble('in', p.text, note));
    }
    const last = messages.at(-1);
    if (!pending.length && last?.direction === 'in') {
      const wait = document.createElement('li');
      wait.className = 'msg-wait';
      wait.textContent = 'Sent. The clinic will reply here.';
      items.push(wait);
    }
    log.replaceChildren(...items);
    log.scrollTop = log.scrollHeight;
  }

  async function send(item) {
    item.state = 'sending';
    errorLine.hidden = true;
    render();
    try {
      // The same message_id on a retry is what keeps a flaky network from opening two cases.
      const res = await fetch('./api/inbox', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(item.envelope),
      });
      if (res.status !== 201 && res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const { case_id: caseId } = await res.json();
      remember(caseId);
      item.state = 'sent';
      // render() drops the pending bubble once the case shows this message_id, which
      // also covers a 200 duplicate: it is drawn once, from the server's copy.
      await refresh(caseId);
    } catch {
      item.state = 'failed';
    }
    render();
  }

  async function refresh(caseId) {
    const res = await fetch(`./api/cases/${encodeURIComponent(caseId)}`, { cache: 'no-store' });
    if (res.status === 404) {
      // The database was reset under us; forget the case rather than poll it forever.
      caseIds = caseIds.filter((id) => id !== caseId);
      saveCaseIds(caseIds);
      cases.delete(caseId);
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    cases.set(caseId, await res.json());
  }

  async function tick() {
    try {
      await Promise.all(caseIds.map(refresh));
      connLine.hidden = true;
    } catch {
      connLine.hidden = false;
    }
    render();
    setTimeout(tick, POLL_MS);
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = textInput.value.trim();
    const email = emailInput.value.trim();
    let problem = '';
    if (!email || !emailInput.checkValidity()) problem = 'Please enter your email so the clinic can reply.';
    else if (!text) problem = 'Please type a message.';
    if (problem) {
      errorLine.textContent = problem;
      errorLine.hidden = false;
      (problem.includes('email') ? emailInput : textInput).focus();
      return;
    }
    if (demo) {
      try {
        submitDemoMessage(buildEnvelope({ messageId: crypto.randomUUID(), name: nameInput.value, email, text }));
      } catch {
        errorLine.textContent = 'Demo message not saved. Allow browser storage to share it with the demo desk.';
        errorLine.hidden = false;
        return;
      }
      errorLine.hidden = true;
      demoMessages.push(...demoExchange(text, demoMessages.length));
      textInput.value = '';
      textInput.focus();
      render();
      return;
    }
    const messageId = crypto.randomUUID();
    const item = {
      messageId,
      text,
      state: 'sending',
      envelope: buildEnvelope({ messageId, name: nameInput.value, email, text }),
    };
    pending.push(item);
    textInput.value = '';
    textInput.focus();
    send(item);
  });

  textInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit(sendButton);
    }
  });

  render();
  serverUp().then((up) => {
    demo = !up;
    demoLine.hidden = up;
    lastFingerprint = '';
    render();
    if (up) tick();
  });
}

if (typeof document !== 'undefined') start();
