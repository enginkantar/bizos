import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoStore, compileRules, evaluateRefund, INITIAL_RULES } from '../src/demo-store.js';

const capText = (cents) => INITIAL_RULES.replace('max_amount_cents: 20000', `max_amount_cents: ${cents}`);
const heldCase = (store) => store.snapshot().cases.find((item) => item.status === 'held' && item.intent === 'refund');

test('starts with reproducible fixture cases, decisions, and audit times', () => {
  const first = createDemoStore().snapshot();
  const second = createDemoStore().snapshot();
  assert.deepEqual(first, second);
  assert.equal(first.cases.length, 5);
  assert.equal(first.cases[0].status, 'blocked');
  assert.equal(first.cases[0].draft.cap, 20000);
  assert.equal(first.cases.filter((item) => item.status === 'held').length, 3);
  assert.ok(first.audit[0].detail.includes('No message sent.'));
});

test('uses strict whole-cent thresholds, including their exact boundaries', () => {
  const rules = compileRules(INITIAL_RULES);
  assert.equal(evaluateRefund(12000, rules), 'pass');
  assert.equal(evaluateRefund(12001, rules), 'review');
  assert.equal(evaluateRefund(20000, rules), 'review');
  assert.equal(evaluateRefund(20001, rules), 'block');
  for (const amount of [-1, 12.5, NaN, Infinity, '15000']) assert.throws(() => evaluateRefund(amount, rules));
});

test('live rule edit changes the next refund verdict and its generated answer', () => {
  const store = createDemoStore();
  assert.equal(store.inject('refund').status, 'blocked');
  store.saveRules(capText(25000), 3);
  const next = store.inject('refund');
  assert.equal(next.status, 'held');
  assert.equal(next.draft.cap, 25000);
  assert.equal(next.draft.rules_version, 4);
  assert.match(next.draft.text, /\$250/);
  assert.equal(store.inject('unsafe').status, 'blocked');
  assert.ok(store.snapshot().rules.diff.some((line) => line.op === 'add' && line.text.includes('25000')));
});

test('editing the hours rule changes the next support reply', () => {
  const store = createDemoStore();
  store.saveRules(INITIAL_RULES.replace('Monday-Thursday 7:30 am-5 pm, Friday 7:30 am-1 pm. Closed weekends.', 'Tuesday-Saturday, 10am-6pm.'), 3);
  assert.match(store.inject('hours').draft.text, /Tuesday-Saturday, 10am-6pm/);
});

test('invalid rule saves leave active limits, version, cases, and audit intact', () => {
  const store = createDemoStore();
  const before = store.snapshot();
  const invalid = [
    INITIAL_RULES.replace('max_amount_cents', 'max_ammount_cents'),
    capText(10000), capText(20000.5), capText(-1),
    INITIAL_RULES.replace('above: block', 'above: pass'),
    INITIAL_RULES.replace('applies_to: refund', 'applies_to: store_credit'),
    INITIAL_RULES.replace('- [KNOW-HOURS]', '- REMOVED:'),
    INITIAL_RULES.replace('policy:', 'other:'),
    `${INITIAL_RULES}\n- HOURS: A duplicate.`,
    'not a rules file',
  ];
  for (const text of invalid) {
    assert.throws(() => store.saveRules(text, 3));
    assert.deepEqual(store.snapshot(), before);
  }
});

test('no-op save does not bump the version and stale editor cannot overwrite a save', () => {
  const store = createDemoStore();
  assert.equal(store.saveRules(INITIAL_RULES, 3).rules.version, 3);
  store.saveRules(capText(25000), 3);
  assert.throws(() => store.saveRules(INITIAL_RULES, 3), /rules changed/i);
  assert.equal(store.snapshot().rules.compiled.cap, 25000);
});

test('old drafts keep original verdict and cap; rechecking creates a new binding', () => {
  const store = createDemoStore();
  const before = store.inject('refund');
  store.saveRules(capText(25000), 3);
  const unchanged = store.snapshot().cases.find((item) => item.id === before.id);
  assert.deepEqual(unchanged.draft, before.draft);
  store.recheck(before.id);
  const updated = store.snapshot().cases.find((item) => item.id === before.id);
  assert.equal(updated.status, 'held');
  assert.equal(updated.draft.version, 2);
  assert.equal(updated.draft.rules_version, 4);
  assert.throws(() => store.review(before.id, 'approve', before.draft), /draft changed/i);
});

test('rule changes invalidate approval and recheck can block an existing draft', () => {
  const store = createDemoStore();
  const item = heldCase(store);
  store.saveRules(capText(14000), 3);
  assert.throws(() => store.review(item.id, 'approve', item.draft), /Rules changed/);
  store.recheck(item.id);
  assert.equal(store.snapshot().cases.find((entry) => entry.id === item.id).status, 'blocked');
  assert.throws(() => store.review(item.id, 'approve', item.draft), /no longer awaiting/);
});

test('approvals are bound to draft, rule version, reply_to, channel, and action', () => {
  const store = createDemoStore();
  const item = heldCase(store);
  for (const key of ['version', 'rules_version', 'reply_to', 'channel', 'action_type']) {
    assert.throws(() => store.review(item.id, 'approve', { ...item.draft, [key]: 'changed' }), /draft changed/i);
  }
  assert.equal(store.snapshot().cases.find((entry) => entry.id === item.id).status, 'held');
});

test('approval records only local approval and a duplicate cannot create another event', () => {
  const store = createDemoStore();
  const item = heldCase(store);
  store.review(item.id, 'approve', item.draft);
  const after = store.snapshot();
  assert.equal(after.cases.find((entry) => entry.id === item.id).status, 'approved');
  assert.equal(after.audit[0].title, 'Reply approved locally');
  assert.match(after.audit[0].detail, /No message sent. No payment made./);
  assert.throws(() => store.review(item.id, 'approve', item.draft));
  assert.deepEqual(store.snapshot(), after);
});

test('reject escalates without sending and removes the case from approvals', () => {
  const store = createDemoStore();
  const item = heldCase(store);
  store.review(item.id, 'reject', item.draft);
  const after = store.snapshot();
  assert.equal(after.cases.find((entry) => entry.id === item.id).status, 'escalated');
  assert.match(after.audit[0].detail, /escalated to owner. No message sent./);
});

test('blocked cases cannot be approved; an escalation is approved or kept by the owner, like the server', () => {
  const store = createDemoStore();
  const blocked = store.snapshot().cases.find((entry) => entry.status === 'blocked');
  assert.throws(() => store.review(blocked.id, 'approve', blocked.draft));
  const escalated = store.snapshot().cases.find((entry) => entry.status === 'escalated');
  assert.equal(store.snapshot().approvals[0].case_id, escalated.id);
  assert.equal(store.snapshot().approvals[0].urgent, true);
  store.review(escalated.id, 'reject', escalated.draft);
  assert.ok(!store.snapshot().approvals.some((entry) => entry.case_id === escalated.id));
  assert.throws(() => store.review(escalated.id, 'approve', escalated.draft));
});

test('snapshot cannot mutate store state and reset restores the original run', () => {
  const store = createDemoStore();
  const initial = store.snapshot();
  const external = store.snapshot();
  external.rules.compiled.cap = 1;
  external.cases[0].draft.text = 'changed';
  assert.deepEqual(store.snapshot(), initial);
  store.saveRules(capText(25000), 3);
  store.inject('sales');
  assert.deepEqual(store.reset(), initial);
  const empty = store.reset(true);
  assert.equal(empty.cases.length, 0);
  assert.equal(empty.audit.length, 0);
  assert.equal(store.inject('hours').status, 'held');
});
