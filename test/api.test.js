import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../lib/api.js';
import { MemoryStore } from '../lib/store/index.js';
import { SAMPLES } from '../lib/samples.js';

const NOW = new Date('2026-09-23T06:00:00Z');

function app() {
  const store = new MemoryStore();
  const handler = createHandler(store, { now: () => NOW });
  return { store, handler };
}

// A tiny client that keeps its own cookie, like one browser.
function client(handler) {
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const res = await handler(new Request(`https://termwise.test${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-termwise': '1', ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    }));
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') && !type.includes('ndjson') ? await res.json() : await res.text();
    return { status: res.status, data, res };
  };
  return {
    get: (p) => call('GET', p),
    post: (p, b = {}, h) => call('POST', p, b, h),
    patch: (p, b = {}) => call('PATCH', p, b),
    del: (p, b = {}) => call('DELETE', p, b)
  };
}

async function owner(handler, email = 'ram@brightpath.example') {
  const c = client(handler);
  const r = await c.post('/api/auth/signup', { email, password: 'correct horse battery', name: 'Ram', workspace: 'Brightpath' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return c;
}

const crm = SAMPLES.find((s) => s.title.startsWith('CRM'));

test('signup, session and me', async () => {
  const { handler } = app();
  const c = await owner(handler);
  const me = await c.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.role, 'owner');
  assert.equal(me.data.plan.id, 'free');
  const anon = client(handler);
  assert.equal((await anon.get('/api/me')).status, 401);
});

test('duplicate signup and wrong password are refused', async () => {
  const { handler } = app();
  await owner(handler);
  const again = client(handler);
  assert.equal((await again.post('/api/auth/signup', { email: 'RAM@brightpath.example', password: 'another long one' })).status, 409);
  assert.equal((await again.post('/api/auth/login', { email: 'ram@brightpath.example', password: 'wrong password!!' })).status, 401);
  assert.equal((await again.post('/api/auth/login', { email: 'ram@brightpath.example', password: 'correct horse battery' })).status, 200);
});

test('login is rate limited per email', async () => {
  const { handler } = app();
  await owner(handler);
  const c = client(handler);
  let last;
  for (let i = 0; i < 9; i++) last = await c.post('/api/auth/login', { email: 'ram@brightpath.example', password: 'nope nope nope' });
  assert.equal(last.status, 429);
});

test('state-changing requests without the CSRF header are rejected', async () => {
  const { handler } = app();
  const c = await owner(handler);
  const r = await c.post('/api/contracts', { text: crm.text }, { 'x-termwise': '' });
  assert.equal(r.status, 403);
});

test('upload, schedule and register', async () => {
  const { handler } = app();
  const c = await owner(handler);
  const up = await c.post('/api/contracts', { title: crm.title, text: crm.text, perspective: 'Customer' });
  assert.equal(up.status, 201);
  const doc = (await c.get(`/api/contracts/${up.data.id}`)).data;
  const renewal = doc.schedule.items.find((i) => i.key === 'renewal_decision');
  assert.equal(renewal.due, '2026-11-02');
  const reg = (await c.get('/api/register')).data;
  assert.ok(reg.length >= 5);
  assert.ok(reg.every((i) => i.appliesToUs !== false), 'register only lists what binds us');
  const list = (await c.get('/api/contracts')).data;
  assert.equal(list[0].next.due, '2026-11-02');
});

test('the same document cannot be added twice', async () => {
  const { handler } = app();
  const c = await owner(handler);
  await c.post('/api/contracts', { text: crm.text, perspective: 'Customer' });
  assert.equal((await c.post('/api/contracts', { text: crm.text.replace(/\n/g, '\r\n'), perspective: 'Customer' })).status, 409);
});

test('plan limit holds under parallel uploads', async () => {
  const { handler } = app();
  const c = await owner(handler);
  const texts = Array.from({ length: 9 }, (_, i) => `${crm.text}\n\nSchedule ${i}`);
  const results = await Promise.all(texts.map((text) => c.post('/api/contracts', { text, perspective: 'Customer' })));
  assert.equal(results.filter((r) => r.status === 201).length, 5);
  assert.ok(results.filter((r) => r.status === 402).every((r) => r.data.upgrade));
  assert.equal((await c.get('/api/contracts')).data.length, 5);
});

test('closing an obligation needs a note, and the change is audited', async () => {
  const { handler } = app();
  const c = await owner(handler);
  const { id } = (await c.post('/api/contracts', { text: crm.text, perspective: 'Customer' })).data;
  assert.equal((await c.patch(`/api/contracts/${id}/items/renewal_decision`, { status: 'done' })).status, 400);
  const ok = await c.patch(`/api/contracts/${id}/items/renewal_decision`, { status: 'done', note: 'Non-renewal notice emailed to Helixa legal, ref BP-114' });
  assert.equal(ok.status, 200);
  const log = (await c.get('/api/audit')).data;
  const e = log.find((x) => x.action === 'obligation.updated');
  assert.deepEqual(e.detail.status, ['open', 'done']);
});

test('rejecting a finding needs a reason and removes items built on it', async () => {
  const { handler } = app();
  const c = await owner(handler);
  const { id } = (await c.post('/api/contracts', { text: crm.text, perspective: 'Customer' })).data;
  const doc = (await c.get(`/api/contracts/${id}`)).data;
  const notice = doc.findings.find((f) => f.type === 'renewal_notice');
  assert.equal((await c.post(`/api/contracts/${id}/findings/${notice.id}`, { decision: 'rejected' })).status, 400);
  assert.equal((await c.post(`/api/contracts/${id}/findings/${notice.id}`, { decision: 'rejected', reason: 'Side letter changed notice to 90 days' })).status, 200);
  const reg = (await c.get('/api/register')).data;
  assert.ok(!reg.some((i) => i.key === 'renewal_decision'));
});

test('roles: a viewer can read but not change anything', async () => {
  const { handler } = app();
  const o = await owner(handler);
  const { id } = (await o.post('/api/contracts', { text: crm.text, perspective: 'Customer' })).data;
  const inv = await o.post('/api/members/invite', { email: 'auditor@firm.example', role: 'viewer' });
  assert.equal(inv.status, 201);
  const v = client(handler);
  const info = await v.get(`/api/invites/${inv.data.token}`);
  assert.equal(info.data.role, 'viewer');
  assert.equal((await v.post(`/api/invites/${inv.data.token}/accept`, { name: 'Auditor', password: 'auditor password 1' })).status, 200);
  assert.equal((await v.get(`/api/contracts/${id}`)).status, 200);
  assert.equal((await v.patch(`/api/contracts/${id}/items/renewal_decision`, { note: 'x' })).status, 403);
  assert.equal((await v.post('/api/contracts', { text: 'x' })).status, 403);
  assert.equal((await v.del(`/api/contracts/${id}`)).status, 403);
  // The invite is single use.
  assert.equal((await client(handler).get(`/api/invites/${inv.data.token}`)).status, 404);
});

test('roles: demotion applies to live sessions immediately', async () => {
  const { handler } = app();
  const o = await owner(handler);
  const inv = await o.post('/api/members/invite', { email: 'ops@firm.example', role: 'member' });
  const m = client(handler);
  await m.post(`/api/invites/${inv.data.token}/accept`, { name: 'Ops', password: 'ops password 123' });
  const { id } = (await o.post('/api/contracts', { text: crm.text, perspective: 'Customer' })).data;
  assert.equal((await m.patch(`/api/contracts/${id}/items/payment_terms`, { note: 'AP team owns this' })).status, 200);
  const members = (await o.get('/api/members')).data;
  const ops = members.find((x) => x.email === 'ops@firm.example');
  assert.equal((await o.patch(`/api/members/${ops.userId}`, { role: 'viewer' })).status, 200);
  assert.equal((await m.patch(`/api/contracts/${id}/items/payment_terms`, { note: 'again' })).status, 403);
});

test('the last owner cannot be demoted', async () => {
  const { handler } = app();
  const o = await owner(handler);
  const me = (await o.get('/api/me')).data;
  assert.equal((await o.patch(`/api/members/${me.user.id}`, { role: 'admin' })).status, 400);
});

test('audit chain verifies, and detects an edited event', async () => {
  const { handler, store } = app();
  const c = await owner(handler);
  const { id } = (await c.post('/api/contracts', { text: crm.text, perspective: 'Customer' })).data;
  await c.patch(`/api/contracts/${id}/items/payment_terms`, { note: 'Owned by AP' });
  await c.post('/api/billing/plan', { plan: 'team' });
  const good = (await c.get('/api/audit/verify')).data;
  assert.equal(good.ok, true);
  assert.equal(good.count, 4);

  // Quietly rewrite history: pretend the plan change never happened.
  const me = (await c.get('/api/me')).data;
  const key = (await store.list(`ws/${me.workspace.id}/audit/`))[3];
  const ev = (await store.get(key)).value;
  await store.put(key, { ...ev, detail: { ...ev.detail, to: 'free' } });
  const bad = (await c.get('/api/audit/verify')).data;
  assert.equal(bad.ok, false);
  assert.equal(bad.brokenAt, 4);
  assert.match(bad.problem, /altered/);
});

test('audit chain detects a deleted event', async () => {
  const { handler, store } = app();
  const c = await owner(handler);
  await c.post('/api/contracts', { text: crm.text, perspective: 'Customer' });
  await c.post('/api/billing/plan', { plan: 'team' });
  const me = (await c.get('/api/me')).data;
  const keys = await store.list(`ws/${me.workspace.id}/audit/`);
  await store.del(keys[1]);
  const r = (await c.get('/api/audit/verify')).data;
  assert.equal(r.ok, false);
  assert.equal(r.brokenAt, 2);
});

test('parallel audit appends never fork the chain', async () => {
  const { handler } = app();
  const c = await owner(handler);
  const { id } = (await c.post('/api/contracts', { text: crm.text, perspective: 'Customer' })).data;
  await Promise.all(Array.from({ length: 12 }, (_, i) => c.patch(`/api/contracts/${id}/items/payment_terms`, { note: `note ${i}` })));
  const r = (await c.get('/api/audit/verify')).data;
  assert.equal(r.ok, true);
  assert.equal(r.count, 2 + 12);
});

test('erasing a contract removes its text and keeps the chain valid', async () => {
  const { handler, store } = app();
  const c = await owner(handler);
  const { id } = (await c.post('/api/contracts', { text: crm.text, perspective: 'Customer' })).data;
  // Review some findings first: reviews are logged, and the log must not keep
  // any of the text they were about.
  const doc = (await c.get(`/api/contracts/${id}`)).data;
  for (const f of doc.findings.slice(0, 3)) await c.post(`/api/contracts/${id}/findings/${f.id}`, { decision: 'confirmed' });
  await c.post(`/api/contracts/${id}/findings/${doc.findings[3].id}`, { decision: 'rejected', reason: 'Superseded by amendment 2' });
  assert.equal((await c.del(`/api/contracts/${id}`, { reason: 'Contract ended, retention period over' })).status, 200);
  assert.equal((await c.get(`/api/contracts/${id}`)).status, 404);
  const probes = doc.findings.map((f) => f.quote.slice(0, 40)).concat(['Helixa Software']);
  for (const k of await store.list('')) {
    const v = JSON.stringify((await store.get(k)).value);
    for (const p of probes) assert.ok(!v.includes(p), `contract text "${p}" survived in ${k}`);
  }
  const log = (await c.get('/api/audit')).data;
  const erased = log.find((e) => e.action === 'contract.erased');
  assert.match(erased.detail.textHash, /^[0-9a-f]{64}$/);
  assert.equal((await c.get('/api/audit/verify')).data.ok, true);
});

test('paid features are gated by plan on the server', async () => {
  const { handler } = app();
  const c = await owner(handler);
  assert.equal((await c.post('/api/calendar')).status, 402);
  assert.equal((await c.get('/api/audit/export')).status, 402);
  await c.post('/api/billing/plan', { plan: 'team' });
  const feed = await c.post('/api/calendar');
  assert.equal(feed.status, 201);
  await c.post('/api/contracts', { text: crm.text, perspective: 'Customer' });
  const ics = await client(handler).get(`/api/calendar/${feed.data.token}.ics`);
  assert.equal(ics.status, 200);
  assert.match(ics.data, /BEGIN:VEVENT/);
  assert.match(ics.data, /DTSTART;VALUE=DATE:20261102/);
  const exp = await c.get('/api/audit/export');
  assert.equal(exp.status, 200);
  assert.ok(exp.data.trim().split('\n').every((l) => JSON.parse(l).hash));
});

test('a new calendar link revokes the old one', async () => {
  const { handler } = app();
  const c = await owner(handler);
  await c.post('/api/billing/plan', { plan: 'team' });
  const a = (await c.post('/api/calendar')).data.token;
  const b = (await c.post('/api/calendar')).data.token;
  assert.equal((await client(handler).get(`/api/calendar/${a}.ics`)).status, 404);
  assert.equal((await client(handler).get(`/api/calendar/${b}.ics`)).status, 200);
});

test('downgrade is refused while over the lower limit', async () => {
  const { handler } = app();
  const c = await owner(handler);
  await c.post('/api/billing/plan', { plan: 'team' });
  for (let i = 0; i < 6; i++) await c.post('/api/contracts', { text: `${crm.text}\n${i}`, perspective: 'Customer' });
  assert.equal((await c.post('/api/billing/plan', { plan: 'free' })).status, 409);
});

test('demo workspace comes loaded and expires', async () => {
  const store = new MemoryStore();
  let now = NOW;
  const handler = createHandler(store, { now: () => now });
  const c = client(handler);
  assert.equal((await c.post('/api/auth/demo')).status, 201);
  const list = (await c.get('/api/contracts')).data;
  assert.equal(list.length, SAMPLES.length);
  now = new Date(NOW.getTime() + 25 * 3600e3);
  assert.equal((await c.get('/api/me')).status, 401);
  assert.equal(await handler.service.sweepDemos(), 1);
  assert.equal((await store.list('ws/')).length, 0);
});

test('workspace erasure removes everything', async () => {
  const { handler, store } = app();
  const c = await owner(handler);
  await c.post('/api/contracts', { text: crm.text, perspective: 'Customer' });
  assert.equal((await c.del('/api/workspace', { confirm: 'wrong' })).status, 400);
  assert.equal((await c.del('/api/workspace', { confirm: 'Brightpath' })).status, 200);
  assert.equal((await store.list('ws/')).length, 0);
  assert.equal((await c.get('/api/me')).status, 401);
});
