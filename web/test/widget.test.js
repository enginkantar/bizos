import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvelope, mergeMessages } from '../src/widget.js';

test('the widget sends the webform envelope, name only when given', () => {
  assert.deepEqual(buildEnvelope({ messageId: 'm1', name: ' Dana ', email: ' dana@example.com ', text: ' Hours? ' }), {
    message_id: 'm1',
    source: 'webform',
    reply_to: 'dana@example.com',
    customer: { name: 'Dana' },
    content: { type: 'text', text: 'Hours?' },
  });
  assert.equal('customer' in buildEnvelope({ messageId: 'm2', name: '  ', email: 'a@example.com', text: 'x' }), false);
});

test('messages from every remembered case merge by received_at and keep no case internals', () => {
  const a = {
    status: 'held', reply_to: 'dana@example.com', drafts: [{ text: 'secret draft' }], outbox: [],
    messages: [
      { id: 'a1', direction: 'in', text: 'first', received_at: '2026-10-25T10:00:00.000Z' },
      { id: 'a2', direction: 'out', text: 'reply', received_at: '2026-10-25T10:02:00.000Z' },
    ],
  };
  const b = { messages: [{ id: 'b1', direction: 'in', text: 'second', received_at: '2026-10-25T10:01:00.000Z' }] };
  const merged = mergeMessages([a, undefined, b, a]);
  assert.deepEqual(merged.map((m) => m.text), ['first', 'second', 'reply']);
  assert.doesNotMatch(JSON.stringify(merged), /secret draft|held|dana@example\.com/);
});
