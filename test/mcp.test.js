import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../lib/api.js';
import { createMcpHandler, matchContract } from '../lib/mcp.js';
import { MemoryStore } from '../lib/store/index.js';

const NOW = new Date('2026-09-24T06:00:00Z');

async function setup() {
  const store = new MemoryStore();
  const api = createHandler(store, { now: () => NOW });
  const mcp = createMcpHandler(store, { now: () => NOW });
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await api(new Request(`https://t.test${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-termwise': '1', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    }));
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
  await call('POST', '/api/auth/demo');
  return { store, api, mcp, call };
}

let seq = 0;
async function rpc(mcp, key, method, params) {
  const res = await mcp(new Request('https://t.test/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
      ...(key ? { authorization: `Bearer ${key}` } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params })
  }));
  const body = res.status === 202 ? null : await res.json();
  return { status: res.status, body };
}

const tool = async (mcp, key, name, args = {}) => (await rpc(mcp, key, 'tools/call', { name, arguments: args })).body.result;

test('no key, bad key: 401 with a bearer challenge', async () => {
  const { mcp } = await setup();
  const r = await mcp(new Request('https://t.test/mcp', { method: 'POST', body: '{}' }));
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), /Bearer/);
  assert.equal((await rpc(mcp, 'tw_notarealkeynotarealkey00', 'tools/list', {})).status, 401);
});

test('initialize speaks the 2025-11-25 protocol and lists the tools', async () => {
  const { mcp, call } = await setup();
  const { key } = (await call('POST', '/api/keys', { name: 'Alexa', role: 'member' })).data;
  const init = await rpc(mcp, key, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.body.result.protocolVersion, '2025-11-25');
  assert.equal(init.body.result.serverInfo.name, 'termwise');
  const list = await rpc(mcp, key, 'tools/list', {});
  const names = list.body.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['assign_obligation', 'complete_obligation', 'contract_obligations', 'explain_deadline', 'list_contracts', 'renewal_exposure', 'upcoming_deadlines', 'verify_audit_trail']);
  const ro = list.body.result.tools.find((t) => t.name === 'upcoming_deadlines');
  assert.equal(ro.annotations.readOnlyHint, true);
});

test('upcoming deadlines reads out dates in words', async () => {
  const { mcp, call } = await setup();
  const { key } = (await call('POST', '/api/keys', { name: 'Alexa' })).data;
  const r = await tool(mcp, key, 'upcoming_deadlines', { days: 60 });
  assert.match(r.content[0].text, /16 October 2026/);
  assert.match(r.content[0].text, /Managed cloud hosting/);
  assert.ok(r.structuredContent.items.every((i) => i.daysLeft <= 60));
  assert.ok(!r.structuredContent.items.some((i) => i.obligation === 'fee_cycle'));
});

test('explain_deadline quotes every clause the date depends on', async () => {
  const { mcp, call } = await setup();
  const { key } = (await call('POST', '/api/keys', { name: 'Alexa' })).data;
  const r = await tool(mcp, key, 'explain_deadline', { contract: 'the hosting contract' });
  const s = r.structuredContent;
  assert.equal(s.due, '2026-10-16');
  assert.deepEqual(s.sources.map((x) => x.clause), ['the opening paragraph', 'clause 1.1', 'clause 1.2', 'clause 1.2']);
  assert.match(r.content[0].text, /at least thirty \(30\) days/);
});

test('renewal exposure totals what renews by default', async () => {
  const { mcp, call } = await setup();
  const { key } = (await call('POST', '/api/keys', { name: 'Alexa' })).data;
  const r = await tool(mcp, key, 'renewal_exposure', { days: 90 });
  assert.equal(r.structuredContent.total, 2880000 + 1800000);
  assert.match(r.content[0].text, /46\.8 lakh rupees/);
});

test('an unclear contract name asks which one instead of guessing', async () => {
  const list = [{ id: 'a', title: 'Office lease Hyderabad' }, { id: 'b', title: 'Office cleaning Hyderabad' }];
  assert.ok(matchContract(list, 'office hyderabad').ambiguous);
  assert.equal(matchContract(list, 'lease').id, 'a');
  const { mcp, call } = await setup();
  const { key } = (await call('POST', '/api/keys', { name: 'Alexa' })).data;
  const r = await tool(mcp, key, 'contract_obligations', { contract: 'spaceship' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /could not find/);
});

test('assistant changes go through the audit trail, marked as via mcp', async () => {
  const { mcp, call } = await setup();
  const { key, id } = (await call('POST', '/api/keys', { name: 'Alexa' })).data;
  const a = await tool(mcp, key, 'assign_obligation', { contract: 'Stratus', person: 'Priya' });
  assert.match(a.content[0].text, /Priya \(Finance\) now owns/);
  const d = await tool(mcp, key, 'complete_obligation', { contract: 'Stratus', obligation: 'renewal', note: 'Notice emailed to Stratus Nine legal' });
  assert.match(d.content[0].text, /as done/);
  const log = (await call('GET', '/api/audit')).data;
  const viaMcp = log.filter((e) => e.detail.via === 'mcp');
  assert.equal(viaMcp.length, 2);
  assert.ok(viaMcp.every((e) => e.detail.keyId === id));
  const v = await tool(mcp, key, 'verify_audit_trail');
  assert.match(v.content[0].text, /checks out/);
});

test('a viewer key can read but not change anything', async () => {
  const { mcp, call } = await setup();
  const { key } = (await call('POST', '/api/keys', { name: 'Read only', role: 'viewer' })).data;
  assert.equal((await tool(mcp, key, 'upcoming_deadlines')).isError, undefined);
  const r = await tool(mcp, key, 'complete_obligation', { contract: 'Stratus', note: 'should fail' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /cannot do this/);
});

test('a revoked key stops working at once', async () => {
  const { mcp, call } = await setup();
  const { key, id } = (await call('POST', '/api/keys', { name: 'Alexa' })).data;
  assert.equal((await rpc(mcp, key, 'tools/list', {})).status, 200);
  assert.equal((await call('DELETE', `/api/keys/${id}`)).status, 200);
  assert.equal((await rpc(mcp, key, 'tools/list', {})).status, 401);
  const log = (await call('GET', '/api/audit')).data;
  assert.ok(log.some((e) => e.action === 'apikey.revoked'));
});

test('keys are stored only as hashes and never listed back', async () => {
  const { store, call } = await setup();
  const { key } = (await call('POST', '/api/keys', { name: 'Alexa' })).data;
  for (const k of await store.list('')) assert.ok(!JSON.stringify((await store.get(k)).value).includes(key), `raw key stored in ${k}`);
  const listed = (await call('GET', '/api/keys')).data;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].hash, undefined);
});

test('console router sends each sample question to the right tool', async () => {
  const { route } = await import('../public/js/views/assistant.js');
  assert.equal(route('What contract deadlines are coming up?').name, 'upcoming_deadlines');
  assert.deepEqual(route('Anything due in the next 14 days?').arguments, { days: 14 });
  assert.equal(route('How much renews by default in the next 90 days?').name, 'renewal_exposure');
  assert.equal(route('Why is the hosting deadline on the 16th of October?').name, 'explain_deadline');
  const give = route('Give the hosting renewal to Priya.');
  assert.equal(give.name, 'assign_obligation');
  assert.equal(give.arguments.person, 'priya');
  assert.equal(route('Is our audit trail intact?').name, 'verify_audit_trail');
});

test('a question that names only the contract explains its main deadline', async () => {
  const { mcp, call } = await setup();
  const { key } = (await call('POST', '/api/keys', { name: 'Alexa' })).data;
  const r = await tool(mcp, key, 'explain_deadline', { contract: 'Why is the hosting deadline on the 16th of October?', obligation: 'Why is the hosting deadline on the 16th of October?' });
  assert.equal(r.structuredContent.obligation, 'renewal_decision');
});

test('a key cannot have more access than the person who makes it', async () => {
  const { call } = await setup();
  assert.equal((await call('POST', '/api/keys', { name: 'x', role: 'owner' })).status, 400);
});
