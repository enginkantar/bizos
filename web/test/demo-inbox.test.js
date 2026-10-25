import test from 'node:test';
import assert from 'node:assert/strict';
import { submitDemoMessage, readDemoMessages } from '../src/demo-inbox.js';
import { createDemoStore, INITIAL_RULES } from '../src/demo-store.js';
import { buildEnvelope } from '../src/widget.js';

const memoryStorage = () => {
  const data = new Map();
  return { get length() { return data.size; }, key: i => [...data.keys()][i],
    getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
};
const message = (id, text = 'When are you open?') => buildEnvelope({
  messageId: id, name: 'Dana', email: 'dana@example.com', text,
});

test('static widget submissions reach an open or newly opened demo desk once, without sending', () => {
  const storage = memoryStorage();
  const readInbox = () => readDemoMessages(storage);
  const desk = createDemoStore({ readInbox });
  submitDemoMessage(message('one'), storage);
  submitDemoMessage(message('two', '<script>untrusted text</script>'), storage);
  desk.refresh();
  desk.refresh();
  const received = desk.snapshot().cases.filter(item => item.widget);
  assert.equal(received.length, 2);
  assert.equal(received[0].message, '<script>untrusted text</script>');
  assert.equal(received[1].customer, 'Dana');
  assert.equal(received[1].reply_to, 'dana@example.com');
  assert.equal(received[1].channel, 'webform');
  assert.equal(received[1].status, 'escalated');
  assert.match(received[1].draft.text, /No AI ran and nothing was sent/);
  assert.equal(createDemoStore({ readInbox }).snapshot().cases.filter(item => item.widget).length, 2);
  desk.reset(true);
  desk.refresh();
  assert.equal(desk.snapshot().cases.length, 0);
  submitDemoMessage(message('three'), storage);
  desk.refresh();
  assert.equal(desk.snapshot().cases.length, 1);
});

test('duplicate widget message IDs replace the same record and storage errors reach the sender', () => {
  const storage = memoryStorage();
  submitDemoMessage(message('one'), storage);
  submitDemoMessage(message('one'), storage);
  assert.equal(readDemoMessages(storage).length, 1);
  assert.throws(() => submitDemoMessage(message('two'), { setItem() { throw new Error('storage denied'); } }), /storage denied/);
  assert.deepEqual(readDemoMessages(undefined), []);
});

test('the full refund beat blocks $500, saves company v4 to v5, then holds for billing review', () => {
  const desk = createDemoStore();
  const item = desk.inject('unsafe');
  assert.equal(item.draft.gate_verdict, 'block');
  assert.equal(item.draft.cap, 20000);
  desk.saveRules(INITIAL_RULES.replace('max_amount_cents: 20000', 'max_amount_cents: 60000').replace('more than $200', 'more than $600'), 4);
  assert.equal(desk.snapshot().rules.version, 5);
  assert.equal(desk.snapshot().rules.compiled.cap, 60000);
  desk.recheck(item.id);
  const checked = desk.snapshot().cases.find(c => c.id === item.id);
  assert.equal(checked.draft.gate_verdict, 'review');
  assert.equal(checked.draft.gate_policy_id, 'REFUND-APPROVAL');
  assert.equal(checked.status, 'held');
  assert.deepEqual(checked.draft.rules_versions, { company: 5, billing: 3 });
});
