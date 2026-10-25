import test from 'node:test';
import assert from 'node:assert/strict';
import { connectStore, request, normalizeCase } from '../src/live-store.js';

test('first API failure loads labeled dental fallback; pass replies remain held', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  const store = await connectStore();
  assert.equal(store.mode, 'demo');
  const item = store.inject('hours');
  assert.equal(item.domain, 'front-desk');
  assert.equal(item.status, 'held');
  assert.equal(item.draft.gate_verdict, 'pass');
  assert.equal(item.draft.gate_reason, 'auto-send is off: every reply waits for the owner');
});

test('live adapter uses API compiled policy and preserves shown approval versions', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push([url, options]);
    const result = url === '/api/rules' ? [{domain:'company',version:8,policy:[{id:'FROM-SERVER',limit_cents:12345}]}]
      : url === '/api/rules/company' ? {domain:'company',version:8,content:'Not parsed in browser',policy:[{id:'FROM-SERVER',limit_cents:12345}]}
      : url.startsWith('/api/approvals/') ? {status:'approved'} : [];
    return Response.json(result);
  });
  const store = await connectStore(); await store.refresh();
  assert.equal(store.mode, 'live');
  assert.equal(store.snapshot().rules.policy[0].limit_cents,12345);
  await store.review('case', 'approve', {id:'draft',version:2,rules_version:7});
  const approval = calls.find(([url]) => url === '/api/approvals/draft');
  assert.deepEqual(JSON.parse(approval[1].body), {decision:'approve',draft_version:2,rules_version:7});
});

test('rules refusal explains that old rules stay active', async t => {
  t.mock.method(globalThis,'fetch',async () => Response.json({error:'invalid_rules',errors:['Unknown policy key']},{status:422}));
  await assert.rejects(request('rules/company',{content:'bad'},'PUT'),/not saved.*previous version.*Unknown policy key/);
});

test('case normalization uses channel recipient and preserves original rule bindings', () => {
  const item=normalizeCase({reply_to:'patient@example.com',messages:[],drafts:[{rule_citations:'["KNOW-HOURS"]',rules_versions:'{"company":3}',rules_version:1,text:'reply',gate_verdict:'pass'}]});
  assert.equal(item.draft.reply_to,'patient@example.com');
  assert.deepEqual(item.draft.rules_versions,{company:3});
  assert.deepEqual(item.draft.rule_citations,['KNOW-HOURS']);
});


test('a later connection failure preserves the live store and its last data', async t => {
  let failed = false;
  t.mock.method(globalThis, 'fetch', async url => {
    if (failed) throw new Error('connection lost');
    return Response.json(url === '/api/rules' ? [{domain:'company',version:3,policy:[]}]
      : url === '/api/rules/company' ? {domain:'company',version:3,content:'loaded',policy:[]} : []);
  });
  const store = await connectStore(); await store.refresh();
  const before = store.snapshot(); failed = true;
  await assert.rejects(store.refresh(), /connection lost/);
  assert.equal(store.mode, 'live'); assert.deepEqual(store.snapshot(), before);
});
