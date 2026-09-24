// Business rules. Everything that changes state goes through here, checks the
// caller's role and plan first, and writes an audit event after. The HTTP layer
// only parses requests and formats responses.

import { extract } from './engine/extract.js';
import { schedule } from './engine/schedule.js';
import { normalise } from './engine/segment.js';
import { today as todayOf } from './engine/dates.js';
import * as audit from './audit.js';
import { update } from './store/index.js';
import { hashPassword, checkPassword, sha256, token, id, emailKey, normaliseEmail, validEmail, passwordProblem, SESSION_DAYS } from './auth.js';
import { PLANS, ROLES, allowed, planOf } from './plans.js';

export const MAX_TEXT = 300_000;
const DEMO_HOURS = 24;

export function fail(status, message, extra = {}) {
  throw Object.assign(new Error(message), { status, expose: true, ...extra });
}

const wsKey = (ws) => `ws/${ws}/meta`;
const contractKey = (ws, c) => `ws/${ws}/contract/${c}`;
const indexKey = (ws) => `ws/${ws}/index`;
const sessionKey = (t) => `session/${sha256(t)}`;
const inviteKey = (t) => `invite/${sha256(t)}`;
const feedKey = (t) => `feed/${sha256(t)}`;

const clean = (s, max = 120) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

export class Service {
  constructor(store, { now = () => new Date() } = {}) {
    this.store = store;
    this.now = now;
  }

  today() { return todayOf(this.now()); }

  // Actions taken through an assistant are logged as the person who issued the
  // key, with the key named, so the trail says who acted and through what.
  async log(ctx, action, target, detail) {
    const via = ctx.via ? { via: ctx.via, keyId: ctx.keyId } : {};
    return audit.append(this.store, ctx.ws.id, { actor: ctx.user, action, target, detail: { ...detail, ...via } }, this.now());
  }

  need(ctx, action) {
    if (!allowed(ctx.role, action)) fail(403, `Your role (${ctx.role}) cannot do this.`);
  }

  // ---------- accounts and sessions ----------

  async signup({ email, password, name, workspace }) {
    email = normaliseEmail(email);
    if (!validEmail(email)) fail(400, 'Enter a valid email address.');
    const p = passwordProblem(password);
    if (p) fail(400, p);
    const pw = await hashPassword(password);
    const user = { id: id('usr'), email, name: clean(name, 80) || email.split('@')[0], salt: pw.salt, hash: pw.hash, workspaces: [], createdAt: this.now().toISOString() };
    const w = await this.store.put(emailKey(email), user, { ifNew: true });
    if (!w.ok) fail(409, 'An account with that email already exists. Sign in instead.');
    const ws = await this.createWorkspace(user, clean(workspace, 80) || `${user.name}'s workspace`);
    return this.startSession(user, ws.id);
  }

  async createWorkspace(user, name, extra = {}) {
    const ws = {
      id: id('ws'),
      name,
      plan: 'free',
      createdAt: this.now().toISOString(),
      members: [{ userId: user.id, email: user.email, name: user.name, role: 'owner', joinedAt: this.now().toISOString() }],
      ...extra
    };
    await this.store.put(wsKey(ws.id), ws, { ifNew: true });
    await update(this.store, emailKey(user.email), (u) => u && { ...u, workspaces: [...new Set([...(u.workspaces || []), ws.id])] });
    await audit.append(this.store, ws.id, { actor: user, action: 'workspace.created', target: ws.id, detail: { name, plan: ws.plan, demo: !!extra.demo } }, this.now());
    return ws;
  }

  async login({ email, password }) {
    email = normaliseEmail(email);
    await this.rateLimit(`rl/login/${sha256(email)}`, 8, 15 * 60);
    const got = await this.store.get(emailKey(email));
    // Same work either way so response time does not reveal which emails exist.
    const ok = got
      ? await checkPassword(String(password || ''), got.value.salt, got.value.hash)
      : (await hashPassword(String(password || '')), false);
    if (!ok) fail(401, 'Email or password is wrong.');
    const user = got.value;
    const wsId = user.workspaces?.[0];
    if (!wsId) fail(403, 'This account is not in any workspace.');
    return this.startSession(user, wsId);
  }

  async rateLimit(key, max, windowSeconds) {
    const nowS = Math.floor(this.now().getTime() / 1000);
    const r = await update(this.store, key, (cur) => {
      const fresh = !cur || nowS - cur.start > windowSeconds;
      return fresh ? { start: nowS, count: 1 } : { ...cur, count: cur.count + 1 };
    });
    if (r.count > max) fail(429, 'Too many attempts. Wait a few minutes and try again.');
  }

  async startSession(user, wsId) {
    const t = token();
    const expires = new Date(this.now().getTime() + SESSION_DAYS * 86400e3).toISOString();
    await this.store.put(sessionKey(t), { userId: user.id, email: user.email, wsId, expires }, { ifNew: true });
    return { token: t, expires };
  }

  async endSession(t) {
    if (t) await this.store.del(sessionKey(t));
  }

  // Resolves a session token to the caller's user, workspace and role. Role is
  // read from the workspace member list on every request, so a demotion takes
  // effect immediately rather than when the session expires.
  async context(t) {
    if (!t) return null;
    const s = await this.store.get(sessionKey(t));
    if (!s) return null;
    if (s.value.expires < this.now().toISOString()) { await this.store.del(sessionKey(t)); return null; }
    const [u, w] = await Promise.all([this.store.get(emailKey(s.value.email)), this.store.get(wsKey(s.value.wsId))]);
    if (!u || !w) return null;
    const ws = w.value;
    if (ws.demo && ws.expiresAt < this.now().toISOString()) return null;
    const member = ws.members.find((m) => m.userId === u.value.id);
    if (!member) return null;
    return { user: u.value, ws, role: member.role, token: t };
  }

  async switchWorkspace(ctx, wsId) {
    if (!ctx.user.workspaces.includes(wsId)) fail(404, 'No such workspace.');
    await update(this.store, sessionKey(ctx.token), (s) => s && { ...s, wsId });
  }

  async me(ctx) {
    const plan = planOf(ctx.ws);
    const index = (await this.store.get(indexKey(ctx.ws.id)))?.value || [];
    const workspaces = [];
    for (const w of ctx.user.workspaces || []) {
      const x = await this.store.get(wsKey(w));
      if (x) workspaces.push({ id: w, name: x.value.name });
    }
    return {
      user: { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name },
      workspace: { id: ctx.ws.id, name: ctx.ws.name, plan: plan.id, demo: !!ctx.ws.demo, expiresAt: ctx.ws.expiresAt || null },
      role: ctx.role,
      plan,
      usage: { contracts: index.length, seats: ctx.ws.members.length },
      workspaces
    };
  }

  // A throwaway workspace with sample contracts, so a judge or prospect can
  // see the product without signing up. It expires after a day.
  async demo(samples) {
    const email = `demo-${token(6).toLowerCase()}@demo.termwise.app`;
    const pw = await hashPassword(token());
    const user = { id: id('usr'), email, name: 'Demo user', salt: pw.salt, hash: pw.hash, workspaces: [], demo: true, createdAt: this.now().toISOString() };
    await this.store.put(emailKey(email), user, { ifNew: true });
    const expiresAt = new Date(this.now().getTime() + DEMO_HOURS * 3600e3).toISOString();
    const ws = await this.createWorkspace(user, 'Brightpath Logistics (demo)', { demo: true, expiresAt, plan: 'team' });
    const ctx = { user: { ...user, workspaces: [ws.id] }, ws, role: 'owner' };
    for (const s of samples) await this.addContract(ctx, s);
    // Seed two teammates so assignment and roles have someone to show.
    await update(this.store, wsKey(ws.id), (w) => ({
      ...w,
      members: [
        ...w.members,
        { userId: id('usr'), email: 'priya.finance@brightpath.example', name: 'Priya (Finance)', role: 'admin', joinedAt: this.now().toISOString(), placeholder: true },
        { userId: id('usr'), email: 'arjun.ops@brightpath.example', name: 'Arjun (Operations)', role: 'member', joinedAt: this.now().toISOString(), placeholder: true }
      ]
    }));
    return this.startSession(ctx.user, ws.id);
  }

  // ---------- contracts ----------

  preview(text) {
    const t = normalise(text);
    if (!t.trim()) fail(400, 'The document is empty.');
    if (t.length > MAX_TEXT) fail(413, 'That document is over 300,000 characters. Split it into its parts.');
    const ex = extract(t);
    return { parties: ex.parties.map(({ name, role }) => ({ name, role })), findings: ex.findings.length, clauses: ex.clauses.length };
  }

  async addContract(ctx, { title, text, perspective }) {
    this.need(ctx, 'manage');
    const t = normalise(text);
    if (!t.trim()) fail(400, 'The document is empty.');
    if (t.length > MAX_TEXT) fail(413, 'That document is over 300,000 characters. Split it into its parts.');
    const plan = planOf(ctx.ws);
    const ex = extract(t, { perspective: clean(perspective, 40) || null });
    const textHash = sha256(t);
    const doc = {
      id: id('ctr'),
      title: clean(title, 140) || firstLine(t),
      perspective: ex.perspective,
      parties: ex.parties.map(({ name, role, span }) => ({ name, role, span })),
      counterparty: ex.parties.find((p) => p.role !== ex.perspective)?.name || null,
      text: t,
      textHash,
      findings: ex.findings,
      clauses: ex.clauses.map(({ id: cid, number, label, start, end }) => ({ id: cid, number, label, start, end })),
      state: { items: {}, findings: {} },
      uploadedBy: { id: ctx.user.id, name: ctx.user.name },
      uploadedAt: this.now().toISOString()
    };
    // The index write is where the plan limit is enforced, inside the same
    // compare-and-set as the append, so two parallel uploads cannot both
    // squeeze past the last free slot.
    await update(this.store, indexKey(ctx.ws.id), (idx = []) => {
      if (idx.length >= plan.contracts) fail(402, `The ${plan.name} plan holds ${plan.contracts} contracts. Upgrade to add more.`, { upgrade: true });
      if (idx.some((x) => x.textHash === textHash)) fail(409, 'This exact document is already in the workspace.');
      return [...idx, summaryOf(doc)];
    });
    await this.store.put(contractKey(ctx.ws.id, doc.id), doc, { ifNew: true });
    await this.log(ctx, 'contract.added', doc.id, { title: doc.title, textHash, findings: doc.findings.length, perspective: doc.perspective });
    return doc;
  }

  async loadContract(ctx, cid) {
    const got = await this.store.get(contractKey(ctx.ws.id, String(cid)));
    if (!got) fail(404, 'No such contract in this workspace.');
    return got;
  }

  async contract(ctx, cid) {
    const { value: doc } = await this.loadContract(ctx, cid);
    return { ...doc, schedule: this.scheduleOf(doc, ctx.ws) };
  }

  // Dates are recomputed on every read, so "days left" is always today's
  // figure and an evergreen contract rolls itself forward without a job.
  scheduleOf(doc, ws) {
    const s = schedule({ findings: doc.findings }, { today: this.today() });
    const rejected = new Set(Object.entries(doc.state.findings).filter(([, v]) => v.decision === 'rejected').map(([k]) => k));
    const members = new Map(ws.members.map((m) => [m.userId, m]));
    s.items = s.items.map((it) => {
      const st = doc.state.items[it.key] || {};
      const owner = st.owner && members.get(st.owner);
      return {
        ...it,
        status: st.status || 'open',
        owner: owner ? { id: owner.userId, name: owner.name } : null,
        note: st.note || '',
        confirmed: st.confirmed || null,
        basedOnRejected: it.citations.some((c) => rejected.has(c)),
        history: st.history || []
      };
    });
    return s;
  }

  async list(ctx) {
    const idx = (await this.store.get(indexKey(ctx.ws.id)))?.value || [];
    const docs = await Promise.all(idx.map((x) => this.store.get(contractKey(ctx.ws.id, x.id))));
    return docs.filter(Boolean).map(({ value: doc }) => {
      const s = this.scheduleOf(doc, ctx.ws);
      const next = s.items.filter((i) => i.due && i.status === 'open' && i.appliesToUs !== false && !i.basedOnRejected).sort((a, b) => a.due.localeCompare(b.due))[0] || null;
      return {
        ...summaryOf(doc),
        term: s.term,
        annualValue: s.annualValue,
        next: next && { title: next.title, due: next.due, daysLeft: next.daysLeft, severity: next.severity },
        risks: s.items.filter((i) => i.kind === 'risk' && i.appliesToUs !== false).length,
        unreviewed: doc.findings.filter((f) => !doc.state.findings[f.id]).length
      };
    });
  }

  async register(ctx) {
    const idx = (await this.store.get(indexKey(ctx.ws.id)))?.value || [];
    const docs = await Promise.all(idx.map((x) => this.store.get(contractKey(ctx.ws.id, x.id))));
    const out = [];
    for (const got of docs.filter(Boolean)) {
      const doc = got.value;
      for (const it of this.scheduleOf(doc, ctx.ws).items) {
        if (it.appliesToUs === false || it.basedOnRejected) continue;
        out.push({ ...it, contract: { id: doc.id, title: doc.title, counterparty: doc.counterparty } });
      }
    }
    return out.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
  }

  async setPerspective(ctx, cid, perspective) {
    this.need(ctx, 'manage');
    const p = clean(perspective, 40);
    let before;
    await this.mutateContract(ctx, cid, (doc) => {
      if (!doc.parties.some((x) => x.role === p)) fail(400, 'Pick one of the parties named in the contract.');
      before = doc.perspective;
      // Same text, same rules, so finding ids are stable across a re-run and
      // any reviews already made still attach to the right finding.
      const ex = extract(doc.text, { perspective: p });
      return { ...doc, perspective: p, findings: ex.findings, counterparty: doc.parties.find((x) => x.role !== p)?.name || null };
    });
    await this.log(ctx, 'contract.perspective_changed', cid, { from: before, to: p });
  }

  async updateItem(ctx, cid, key, patch) {
    this.need(ctx, 'work');
    const changes = {};
    const at = this.now().toISOString();
    await this.mutateContract(ctx, cid, (doc) => {
      const item = this.scheduleOf(doc, ctx.ws).items.find((i) => i.key === key);
      if (!item) fail(404, 'No such obligation on this contract.');
      const st = { ...(doc.state.items[key] || {}) };
      if (patch.status !== undefined) {
        if (!['open', 'done', 'not_applicable'].includes(patch.status)) fail(400, 'Unknown status.');
        if (patch.status !== 'open' && !clean(patch.note ?? st.note, 500)) fail(400, 'Add a note saying what was done, so the record explains itself.');
        if (st.status !== patch.status) changes.status = [st.status || 'open', patch.status];
        st.status = patch.status;
      }
      if (patch.owner !== undefined) {
        if (patch.owner && !ctx.ws.members.some((m) => m.userId === patch.owner)) fail(400, 'That person is not in this workspace.');
        if (st.owner !== patch.owner) changes.owner = [st.owner || null, patch.owner || null];
        st.owner = patch.owner || null;
      }
      if (patch.note !== undefined) {
        const n = clean(patch.note, 500);
        if (n !== (st.note || '')) changes.note = true;
        st.note = n;
      }
      if (patch.confirm) {
        st.confirmed = { by: ctx.user.name, byId: ctx.user.id, at };
        changes.confirmed = true;
      }
      if (!Object.keys(changes).length) return undefined;
      st.history = [...(st.history || []), { at, by: ctx.user.name, changes }].slice(-50);
      return { ...doc, state: { ...doc.state, items: { ...doc.state.items, [key]: st } } };
    });
    if (Object.keys(changes).length) await this.log(ctx, 'obligation.updated', `${cid}#${key}`, changes);
    return changes;
  }

  async reviewFinding(ctx, cid, fid, decision, reason) {
    this.need(ctx, 'work');
    if (!['confirmed', 'rejected'].includes(decision)) fail(400, 'Decision must be confirmed or rejected.');
    const why = clean(reason, 300);
    if (decision === 'rejected' && !why) fail(400, 'Say why this finding is wrong. The reason goes in the audit log.');
    // The log names the finding by type, clause and a hash of its quote, never
    // the quote itself, so erasing the contract leaves no contract text behind.
    let what;
    await this.mutateContract(ctx, cid, (doc) => {
      const f = doc.findings.find((x) => x.id === fid);
      if (!f) fail(404, 'No such finding.');
      what = { type: f.type, clause: f.clause.number || null, quoteHash: sha256(f.quote) };
      return { ...doc, state: { ...doc.state, findings: { ...doc.state.findings, [fid]: { decision, reason: why || null, by: ctx.user.name, at: this.now().toISOString() } } } };
    });
    await this.log(ctx, `finding.${decision}`, `${cid}#${fid}`, { ...what, reason: why || undefined });
  }

  async mutateContract(ctx, cid, fn) {
    await this.loadContract(ctx, cid);
    return update(this.store, contractKey(ctx.ws.id, cid), (doc) => (doc ? fn(doc) : fail(404, 'No such contract.')));
  }

  // Erasure removes the text and findings. The audit chain keeps the hash of
  // the text it once held, which proves what was deleted without keeping it.
  async deleteContract(ctx, cid, reason) {
    this.need(ctx, 'manage');
    const { value: doc } = await this.loadContract(ctx, cid);
    await update(this.store, indexKey(ctx.ws.id), (idx = []) => idx.filter((x) => x.id !== cid));
    await this.store.del(contractKey(ctx.ws.id, cid));
    await this.log(ctx, 'contract.erased', cid, { title: doc.title, textHash: doc.textHash, reason: clean(reason, 300) || undefined });
  }

  // ---------- people ----------

  async invite(ctx, { email, role }) {
    this.need(ctx, 'manage');
    email = normaliseEmail(email);
    if (!validEmail(email)) fail(400, 'Enter a valid email address.');
    if (!ROLES.includes(role) || role === 'owner') fail(400, 'Role must be viewer, member or admin.');
    if (role === 'admin') this.need(ctx, 'own');
    const plan = planOf(ctx.ws);
    if (ctx.ws.members.length >= plan.seats) fail(402, `The ${plan.name} plan has ${plan.seats} seats. Upgrade to add people.`, { upgrade: true });
    if (ctx.ws.members.some((m) => m.email === email)) fail(409, 'That person is already in the workspace.');
    const t = token(24);
    const expires = new Date(this.now().getTime() + 7 * 86400e3).toISOString();
    await this.store.put(inviteKey(t), { wsId: ctx.ws.id, email, role, invitedBy: ctx.user.name, expires }, { ifNew: true });
    await this.log(ctx, 'member.invited', email, { role });
    return { token: t, expires };
  }

  async inviteInfo(t) {
    const inv = await this.store.get(inviteKey(String(t || '')));
    if (!inv || inv.value.expires < this.now().toISOString()) fail(404, 'This invite link has expired or was already used.');
    const ws = await this.store.get(wsKey(inv.value.wsId));
    const existing = await this.store.get(emailKey(inv.value.email));
    return { email: inv.value.email, role: inv.value.role, workspace: ws?.value.name, invitedBy: inv.value.invitedBy, hasAccount: !!existing };
  }

  async acceptInvite({ token: t, name, password }) {
    const inv = await this.store.get(inviteKey(String(t || '')));
    if (!inv || inv.value.expires < this.now().toISOString()) fail(404, 'This invite link has expired or was already used.');
    const { wsId, email, role } = inv.value;
    let got = await this.store.get(emailKey(email));
    if (got) {
      if (!(await checkPassword(String(password || ''), got.value.salt, got.value.hash))) fail(401, 'Password does not match the existing account for this email.');
    } else {
      const p = passwordProblem(password);
      if (p) fail(400, p);
      const pw = await hashPassword(password);
      await this.store.put(emailKey(email), { id: id('usr'), email, name: clean(name, 80) || email.split('@')[0], salt: pw.salt, hash: pw.hash, workspaces: [], createdAt: this.now().toISOString() }, { ifNew: true });
      got = await this.store.get(emailKey(email));
    }
    const user = got.value;
    await update(this.store, wsKey(wsId), (ws) => {
      if (ws.members.some((m) => m.userId === user.id)) return undefined;
      const plan = planOf(ws);
      if (ws.members.length >= plan.seats) fail(402, 'The workspace is out of seats.');
      return { ...ws, members: [...ws.members, { userId: user.id, email, name: user.name, role, joinedAt: this.now().toISOString() }] };
    });
    await update(this.store, emailKey(email), (u) => ({ ...u, workspaces: [...new Set([...(u.workspaces || []), wsId])] }));
    await this.store.del(inviteKey(t));
    await audit.append(this.store, wsId, { actor: user, action: 'member.joined', target: user.id, detail: { email, role } }, this.now());
    return this.startSession(user, wsId);
  }

  async setRole(ctx, userId, role) {
    this.need(ctx, 'manage');
    if (!ROLES.includes(role)) fail(400, 'Unknown role.');
    let from;
    await update(this.store, wsKey(ctx.ws.id), (ws) => {
      const m = ws.members.find((x) => x.userId === userId);
      if (!m) fail(404, 'No such member.');
      if (m.role === role) return undefined;
      // Admins manage members and viewers. Only an owner can create or demote
      // an admin or owner, and the last owner cannot step down.
      if ((['admin', 'owner'].includes(role) || ['admin', 'owner'].includes(m.role)) && ctx.role !== 'owner') fail(403, 'Only an owner can change admin or owner roles.');
      if (m.role === 'owner' && ws.members.filter((x) => x.role === 'owner').length === 1) fail(400, 'A workspace needs at least one owner.');
      from = m.role;
      return { ...ws, members: ws.members.map((x) => (x.userId === userId ? { ...x, role } : x)) };
    });
    if (from) await this.log(ctx, 'member.role_changed', userId, { from, to: role });
  }

  async removeMember(ctx, userId) {
    this.need(ctx, 'manage');
    let removed;
    await update(this.store, wsKey(ctx.ws.id), (ws) => {
      const m = ws.members.find((x) => x.userId === userId);
      if (!m) fail(404, 'No such member.');
      if (['admin', 'owner'].includes(m.role) && ctx.role !== 'owner') fail(403, 'Only an owner can remove an admin or owner.');
      if (m.role === 'owner' && ws.members.filter((x) => x.role === 'owner').length === 1) fail(400, 'A workspace needs at least one owner.');
      removed = m;
      return { ...ws, members: ws.members.filter((x) => x.userId !== userId) };
    });
    await this.log(ctx, 'member.removed', userId, { email: removed.email, role: removed.role });
  }

  // ---------- billing ----------

  // Payments run in test mode: no card is taken and the event says so. The
  // plan change itself, and every limit that follows from it, is real.
  async changePlan(ctx, planId) {
    this.need(ctx, 'own');
    const plan = PLANS[planId];
    if (!plan) fail(400, 'Unknown plan.');
    const idx = (await this.store.get(indexKey(ctx.ws.id)))?.value || [];
    if (idx.length > plan.contracts) fail(409, `This workspace holds ${idx.length} contracts; ${plan.name} allows ${plan.contracts}. Remove some first.`);
    if (ctx.ws.members.length > plan.seats) fail(409, `This workspace has ${ctx.ws.members.length} people; ${plan.name} allows ${plan.seats}.`);
    const from = ctx.ws.plan;
    await update(this.store, wsKey(ctx.ws.id), (ws) => (ws.plan === planId ? undefined : { ...ws, plan: planId }));
    if (from !== planId) await this.log(ctx, 'billing.plan_changed', ctx.ws.id, { from, to: planId, priceInr: plan.priceInr, mode: 'test' });
    return plan;
  }

  // ---------- calendar feed ----------

  async feedToken(ctx) {
    this.need(ctx, 'manage');
    if (!planOf(ctx.ws).calendarFeed) fail(402, 'Calendar feeds are on the Team plan and above.', { upgrade: true });
    const t = token(24);
    // One live feed per workspace: issuing a new link revokes the old one.
    let old;
    await update(this.store, wsKey(ctx.ws.id), (ws) => { old = ws.feed; return { ...ws, feed: sha256(t) }; });
    if (old) await this.store.del(`feed/${old}`);
    await this.store.put(feedKey(t), { wsId: ctx.ws.id }, {});
    await this.log(ctx, 'calendar.feed_issued', ctx.ws.id, { revokedPrevious: !!old });
    return t;
  }

  async feed(t) {
    const f = await this.store.get(feedKey(String(t || '')));
    if (!f) fail(404, 'Unknown calendar feed.');
    const ws = (await this.store.get(wsKey(f.value.wsId)))?.value;
    if (!ws || !planOf(ws).calendarFeed) fail(404, 'Unknown calendar feed.');
    const ctx = { ws, role: 'viewer', user: null };
    return { ws, items: (await this.register(ctx)).filter((i) => i.due && i.status === 'open') };
  }

  // ---------- assistant keys (MCP) ----------

  // A key lets an assistant act for the person who made it, never with more
  // power than they have. Only its hash is stored; the key is shown once.
  async createApiKey(ctx, { name, role = 'member' }) {
    this.need(ctx, 'manage');
    if (!ROLES.includes(role) || role === 'owner') fail(400, 'Key role must be viewer, member or admin.');
    if (ROLES.indexOf(role) > ROLES.indexOf(ctx.role)) fail(403, 'A key cannot have more access than you do.');
    const label = clean(name, 60) || 'Assistant';
    const key = `tw_${token(24)}`;
    const keyId = id('key');
    await update(this.store, wsKey(ctx.ws.id), (ws) => {
      const keys = ws.apiKeys || [];
      if (keys.length >= 10) fail(400, 'A workspace can hold 10 keys. Revoke one first.');
      return { ...ws, apiKeys: [...keys, { id: keyId, name: label, role, prefix: key.slice(0, 9), hash: sha256(key), createdAt: this.now().toISOString(), createdBy: ctx.user.name }] };
    });
    await this.store.put(`apikey/${sha256(key)}`, { keyId, wsId: ctx.ws.id, userId: ctx.user.id, email: ctx.user.email, role }, { ifNew: true });
    await this.log(ctx, 'apikey.created', keyId, { name: label, role });
    return { key, id: keyId };
  }

  async revokeApiKey(ctx, keyId) {
    this.need(ctx, 'manage');
    let found;
    await update(this.store, wsKey(ctx.ws.id), (ws) => {
      found = (ws.apiKeys || []).find((k) => k.id === keyId);
      if (!found) fail(404, 'No such key.');
      return { ...ws, apiKeys: ws.apiKeys.filter((k) => k.id !== keyId) };
    });
    await this.store.del(`apikey/${found.hash}`);
    await this.log(ctx, 'apikey.revoked', keyId, { name: found.name });
  }

  listApiKeys(ctx) {
    this.need(ctx, 'manage');
    return (ctx.ws.apiKeys || []).map(({ hash, ...k }) => k);
  }

  // Resolves a bearer key. The key's role is capped by the issuer's current
  // role, so demoting a person also demotes every key they made, and removing
  // them or revoking the key cuts it off at once.
  async apiContext(key) {
    if (!/^tw_[\w-]{20,}$/.test(String(key || ''))) return null;
    const rec = await this.store.get(`apikey/${sha256(key)}`);
    if (!rec) return null;
    const { keyId, wsId, email, role } = rec.value;
    const [u, w] = await Promise.all([this.store.get(emailKey(email)), this.store.get(wsKey(wsId))]);
    if (!u || !w) return null;
    const ws = w.value;
    if (ws.demo && ws.expiresAt < this.now().toISOString()) return null;
    if (!(ws.apiKeys || []).some((k) => k.id === keyId)) return null;
    const member = ws.members.find((m) => m.userId === u.value.id);
    if (!member) return null;
    const effective = ROLES[Math.min(ROLES.indexOf(role), ROLES.indexOf(member.role))];
    await this.rateLimit(`rl/key/${keyId}`, 120, 60);
    return { user: u.value, ws, role: effective, via: 'mcp', keyId };
  }

  // ---------- governance ----------

  async auditLog(ctx, after, limit) {
    return audit.list(this.store, ctx.ws.id, { after: Number(after) || 0, limit: Math.min(Number(limit) || 200, 500) });
  }

  async auditVerify(ctx) {
    return audit.verify(this.store, ctx.ws.id);
  }

  async auditExport(ctx) {
    this.need(ctx, 'manage');
    if (!planOf(ctx.ws).auditExport) fail(402, 'Audit export is on the Team plan and above.', { upgrade: true });
    const events = await audit.list(this.store, ctx.ws.id, { limit: 1e9 });
    await this.log(ctx, 'audit.exported', ctx.ws.id, { events: events.length });
    return events;
  }

  // Everything the workspace holds, in one file, for portability and for
  // subject access requests.
  async exportAll(ctx) {
    this.need(ctx, 'own');
    const idx = (await this.store.get(indexKey(ctx.ws.id)))?.value || [];
    const contracts = [];
    for (const x of idx) {
      const c = await this.store.get(contractKey(ctx.ws.id, x.id));
      if (c) contracts.push(c.value);
    }
    const { feed, apiKeys, ...rest } = ctx.ws;
    const ws = { ...rest, apiKeys: (apiKeys || []).map(({ hash, ...k }) => k) };
    await this.log(ctx, 'workspace.exported', ctx.ws.id, { contracts: contracts.length });
    return { exportedAt: this.now().toISOString(), workspace: ws, contracts, audit: await audit.list(this.store, ctx.ws.id, { limit: 1e9 }) };
  }

  async eraseWorkspace(ctx, confirmName) {
    this.need(ctx, 'own');
    if (clean(confirmName, 80) !== ctx.ws.name) fail(400, 'Type the workspace name exactly to confirm.');
    const keys = await this.store.list(`ws/${ctx.ws.id}/`);
    for (const k of keys) await this.store.del(k);
    if (ctx.ws.feed) await this.store.del(`feed/${ctx.ws.feed}`);
    for (const k of ctx.ws.apiKeys || []) await this.store.del(`apikey/${k.hash}`);
    for (const m of ctx.ws.members) {
      await update(this.store, emailKey(m.email), (u) => u && { ...u, workspaces: (u.workspaces || []).filter((w) => w !== ctx.ws.id) }).catch(() => {});
    }
    await this.endSession(ctx.token);
    return { erased: keys.length };
  }

  // Deletes demo workspaces past their expiry. Run on a schedule.
  async sweepDemos() {
    const metas = (await this.store.list('ws/')).filter((k) => k.endsWith('/meta'));
    let swept = 0;
    for (const k of metas) {
      const w = await this.store.get(k);
      if (!w || !w.value.demo || w.value.expiresAt > this.now().toISOString()) continue;
      for (const key of await this.store.list(`ws/${w.value.id}/`)) await this.store.del(key);
      for (const m of w.value.members) if (!m.placeholder) await this.store.del(emailKey(m.email));
      swept++;
    }
    return swept;
  }
}

function summaryOf(doc) {
  return {
    id: doc.id,
    title: doc.title,
    counterparty: doc.counterparty,
    perspective: doc.perspective,
    textHash: doc.textHash,
    findings: doc.findings.length,
    uploadedAt: doc.uploadedAt,
    uploadedBy: doc.uploadedBy?.name || null
  };
}

function firstLine(t) {
  return (t.split('\n').find((l) => l.trim()) || 'Untitled contract').trim().slice(0, 140);
}
