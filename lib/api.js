// HTTP routing on web-standard Request/Response, so the same handler runs as a
// Netlify Function in production and behind node:http locally.
//
// CSRF: every state-changing request must carry the X-Termwise header. Browsers
// will not attach a custom header cross-origin without a CORS preflight, and
// this API answers no preflights, so a forged form post from another site is
// rejected before it reaches a handler. The session cookie is also SameSite=Lax.

import { Service, fail } from './service.js';
import { COOKIE, readCookie, sessionCookie } from './auth.js';
import { PLANS } from './plans.js';
import { toIcs } from './ics.js';
import { SAMPLES } from './samples.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

async function body(req) {
  const len = Number(req.headers.get('content-length') || 0);
  if (len > 1_000_000) fail(413, 'Request too large.');
  const text = await req.text();
  if (text.length > 1_000_000) fail(413, 'Request too large.');
  if (!text) return {};
  try { return JSON.parse(text); } catch { fail(400, 'Request body is not valid JSON.'); }
}

// [method, pattern, handler, auth]. auth: 'none' | 'session'
function routes(svc) {
  const R = [];
  const on = (method, path, handler, auth = 'session') => {
    const names = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
    R.push({ method, re, names, handler, auth });
  };

  on('GET', '/api/health', async () => json({ ok: true, time: new Date().toISOString() }), 'none');
  on('GET', '/api/plans', async () => json(Object.values(PLANS)), 'none');

  on('POST', '/api/auth/signup', async ({ req, secure }) => {
    const b = await body(req);
    const s = await svc.signup(b);
    return json({ ok: true }, 201, { 'set-cookie': sessionCookie(s.token, { secure }) });
  }, 'none');

  on('POST', '/api/auth/login', async ({ req, secure }) => {
    const s = await svc.login(await body(req));
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(s.token, { secure }) });
  }, 'none');

  on('POST', '/api/auth/demo', async ({ secure }) => {
    const s = await svc.demo(SAMPLES);
    return json({ ok: true }, 201, { 'set-cookie': sessionCookie(s.token, { secure }) });
  }, 'none');

  on('POST', '/api/auth/logout', async ({ req, secure }) => {
    await svc.endSession(readCookie(req.headers.get('cookie'), COOKIE));
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', { secure, maxAge: 0 }) });
  }, 'none');

  on('GET', '/api/invites/:token', async ({ p }) => json(await svc.inviteInfo(p.token)), 'none');
  on('POST', '/api/invites/:token/accept', async ({ req, p, secure }) => {
    const b = await body(req);
    const s = await svc.acceptInvite({ ...b, token: p.token });
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(s.token, { secure }) });
  }, 'none');

  on('GET', '/api/calendar/:token', async ({ p }) => {
    const t = p.token.replace(/\.ics$/, '');
    const { ws, items } = await svc.feed(t);
    return new Response(toIcs(ws, items), { headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'private, max-age=900' } });
  }, 'none');

  on('GET', '/api/me', async ({ ctx }) => json(await svc.me(ctx)));
  on('POST', '/api/me/workspace', async ({ ctx, req }) => { await svc.switchWorkspace(ctx, (await body(req)).workspaceId); return json({ ok: true }); });

  on('POST', '/api/preview', async ({ req }) => json(svc.preview((await body(req)).text)));
  on('GET', '/api/contracts', async ({ ctx }) => json(await svc.list(ctx)));
  on('POST', '/api/contracts', async ({ ctx, req }) => {
    const doc = await svc.addContract(ctx, await body(req));
    return json({ id: doc.id }, 201);
  });
  on('GET', '/api/contracts/:id', async ({ ctx, p }) => json(await svc.contract(ctx, p.id)));
  on('DELETE', '/api/contracts/:id', async ({ ctx, p, req }) => { await svc.deleteContract(ctx, p.id, (await body(req)).reason); return json({ ok: true }); });
  on('POST', '/api/contracts/:id/perspective', async ({ ctx, p, req }) => { await svc.setPerspective(ctx, p.id, (await body(req)).perspective); return json({ ok: true }); });
  on('PATCH', '/api/contracts/:id/items/:key', async ({ ctx, p, req }) => json(await svc.updateItem(ctx, p.id, decodeURIComponent(p.key), await body(req))));
  on('POST', '/api/contracts/:id/findings/:fid', async ({ ctx, p, req }) => {
    const b = await body(req);
    await svc.reviewFinding(ctx, p.id, p.fid, b.decision, b.reason);
    return json({ ok: true });
  });

  on('GET', '/api/register', async ({ ctx }) => json(await svc.register(ctx)));

  on('GET', '/api/members', async ({ ctx }) => json(ctx.ws.members.map(({ userId, email, name, role, joinedAt, placeholder }) => ({ userId, email, name, role, joinedAt, placeholder: !!placeholder }))));
  on('POST', '/api/members/invite', async ({ ctx, req }) => json(await svc.invite(ctx, await body(req)), 201));
  on('PATCH', '/api/members/:userId', async ({ ctx, p, req }) => { await svc.setRole(ctx, p.userId, (await body(req)).role); return json({ ok: true }); });
  on('DELETE', '/api/members/:userId', async ({ ctx, p }) => { await svc.removeMember(ctx, p.userId); return json({ ok: true }); });

  on('POST', '/api/billing/plan', async ({ ctx, req }) => json(await svc.changePlan(ctx, (await body(req)).plan)));
  on('POST', '/api/calendar', async ({ ctx }) => json({ token: await svc.feedToken(ctx) }, 201));

  on('GET', '/api/keys', async ({ ctx }) => json(svc.listApiKeys(ctx)));
  on('POST', '/api/keys', async ({ ctx, req }) => json(await svc.createApiKey(ctx, await body(req)), 201));
  on('DELETE', '/api/keys/:id', async ({ ctx, p }) => { await svc.revokeApiKey(ctx, p.id); return json({ ok: true }); });

  on('GET', '/api/audit', async ({ ctx, url }) => json(await svc.auditLog(ctx, url.searchParams.get('after'), url.searchParams.get('limit'))));
  on('GET', '/api/audit/verify', async ({ ctx }) => json(await svc.auditVerify(ctx)));
  on('GET', '/api/audit/export', async ({ ctx }) => {
    const events = await svc.auditExport(ctx);
    return new Response(events.map((e) => JSON.stringify(e)).join('\n') + '\n', {
      headers: { 'content-type': 'application/x-ndjson', 'content-disposition': `attachment; filename="termwise-audit-${ctx.ws.id}.jsonl"`, 'cache-control': 'no-store' }
    });
  });
  on('GET', '/api/workspace/export', async ({ ctx }) => {
    const data = await svc.exportAll(ctx);
    return new Response(JSON.stringify(data, null, 2), {
      headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="termwise-export-${ctx.ws.id}.json"`, 'cache-control': 'no-store' }
    });
  });
  on('DELETE', '/api/workspace', async ({ ctx, req, secure }) => {
    const r = await svc.eraseWorkspace(ctx, (await body(req)).confirm);
    return json(r, 200, { 'set-cookie': sessionCookie('', { secure, maxAge: 0 }) });
  });

  return R;
}

export function createHandler(store, opts = {}) {
  const svc = new Service(store, opts);
  const table = routes(svc);

  const handler = async (req) => {
    const url = new URL(req.url);
    const secure = url.protocol === 'https:';
    try {
      const matches = table.filter((r) => r.re.test(url.pathname));
      if (!matches.length) return json({ error: 'Not found.' }, 404);
      const route = matches.find((r) => r.method === req.method);
      if (!route) return json({ error: 'Method not allowed.' }, 405);

      if (req.method !== 'GET' && req.headers.get('x-termwise') !== '1') {
        return json({ error: 'Missing request header.' }, 403);
      }

      const m = url.pathname.match(route.re);
      const p = Object.fromEntries(route.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      let ctx = null;
      if (route.auth === 'session') {
        ctx = await svc.context(readCookie(req.headers.get('cookie'), COOKIE));
        if (!ctx) return json({ error: 'Sign in to continue.' }, 401);
      }
      return await route.handler({ req, url, p, ctx, secure });
    } catch (e) {
      if (e.expose) return json({ error: e.message, upgrade: e.upgrade || undefined }, e.status || 400);
      if (e.status === 503) return json({ error: e.message }, 503, { 'retry-after': '1' });
      console.error(e);
      return json({ error: 'Something went wrong on our side.' }, 500);
    }
  };
  handler.service = svc;
  return handler;
}
