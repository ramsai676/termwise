// Termwise as an MCP server, so a voice assistant such as Alexa+ can answer
// "what contract deadlines are coming up?" and act on the answer.
//
// Streamable HTTP, stateless: every request carries a workspace key as a bearer
// token and gets a fresh server bound to that key's workspace and role. Tools
// call the same Service methods the web app uses, so roles, plan limits and the
// audit trail apply to an assistant exactly as they apply to a person.
//
// Answers are written to be spoken. Every tool returns a short sentence in
// `content` for the assistant to read out, and the full data in
// `structuredContent` for anything that wants to show it.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { Service } from './service.js';

const SPOKEN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function spokenDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${SPOKEN_MONTHS[m - 1]} ${y}`;
}

function spokenDays(n) {
  if (n == null) return '';
  if (n < 0) return `${-n} day${n === -1 ? '' : 's'} overdue`;
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  return `in ${n} days`;
}

function spokenMoney(amount, currency) {
  if (amount == null) return '';
  if (currency === 'INR' || !currency) {
    if (amount >= 1e7) return `${+(amount / 1e7).toFixed(2)} crore rupees`;
    if (amount >= 1e5) return `${+(amount / 1e5).toFixed(2)} lakh rupees`;
    return `${Math.round(amount).toLocaleString('en-IN')} rupees`;
  }
  return `${Math.round(amount).toLocaleString('en-US')} ${currency}`;
}

const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2);
const STOP = new Set(['the', 'and', 'contract', 'agreement', 'with', 'for', 'our', 'pvt', 'ltd', 'private', 'limited', 'llp']);

// People say "the hosting contract" or "Stratus", not a contract id. Match on
// words from the title and counterparty, and ask again if two tie.
export function matchContract(list, query) {
  const exact = list.find((c) => c.id === query);
  if (exact) return exact;
  const q = words(query).filter((w) => !STOP.has(w));
  if (!q.length) return null;
  const scored = list.map((c) => {
    const hay = new Set(words(`${c.title} ${c.counterparty || ''}`));
    const score = q.filter((w) => hay.has(w) || [...hay].some((h) => h.startsWith(w) || w.startsWith(h))).length;
    return { c, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  if (scored.length > 1 && scored[0].score === scored[1].score) return { ambiguous: scored.filter((x) => x.score === scored[0].score).map((x) => x.c) };
  return scored[0].c;
}

const OBLIGATION_ALIASES = [
  [/renew|notice|cancel/, 'renewal_decision'],
  [/expir|end/, 'expiry'],
  [/lock/, 'lock_in_end'],
  [/pay|invoice/, 'payment_terms'],
  [/fee|rent|charge/, 'fee_cycle'],
  [/insur/, 'insurance'],
  [/credit|sla|service level/, 'sla_credit_claim'],
  [/breach|incident|security/, 'breach_notification'],
  [/data|delete|return/, 'data_return']
];

export function matchObligation(items, query) {
  if (!query) return items.find((i) => i.key === 'renewal_decision') || items.find((i) => i.kind === 'deadline') || items[0] || null;
  const direct = items.find((i) => i.key === query || i.id === query);
  if (direct) return direct;
  const q = String(query).toLowerCase();
  for (const [re, key] of OBLIGATION_ALIASES) {
    if (re.test(q)) {
      const hit = items.find((i) => i.key === key || i.key.startsWith(`${key}:`));
      if (hit) return hit;
    }
  }
  const qw = words(q);
  return items.map((i) => ({ i, s: qw.filter((w) => i.title.toLowerCase().includes(w)).length })).sort((a, b) => b.s - a.s).find((x) => x.s > 0)?.i || null;
}

function text(t, structured) {
  return { content: [{ type: 'text', text: t }], ...(structured ? { structuredContent: structured } : {}) };
}

function problem(t) {
  return { content: [{ type: 'text', text: t }], isError: true };
}

// Runs a tool body and turns service errors into a sentence the assistant can
// say, instead of a protocol error the user never hears.
const safely = (fn) => async (args) => {
  try { return await fn(args || {}); } catch (e) {
    if (e.expose) return problem(e.message);
    console.error(e);
    return problem('Termwise could not do that just now.');
  }
};

export function createMcpServer(svc, ctx) {
  const server = new McpServer(
    { name: 'termwise', title: 'Termwise contract deadlines', version: '1.0.0' },
    {
      instructions: 'Termwise tracks the deadlines and duties inside a company\'s contracts. Every date it gives is computed from quoted contract clauses. When the user asks about a deadline, call explain_deadline to give the clauses behind it. Read dates and amounts out in full.'
    }
  );

  async function resolveContract(query) {
    const list = await svc.list(ctx);
    if (!list.length) throw Object.assign(new Error('There are no contracts in this workspace yet.'), { expose: true });
    const m = matchContract(list, query);
    if (!m) throw Object.assign(new Error(`I could not find a contract matching "${query}". The contracts are: ${list.map((c) => c.title).join('; ')}.`), { expose: true });
    if (m.ambiguous) throw Object.assign(new Error(`That could be ${m.ambiguous.map((c) => c.title).join(' or ')}. Which one?`), { expose: true });
    return m;
  }

  server.registerTool('upcoming_deadlines', {
    title: 'Upcoming contract deadlines',
    description: 'Lists open, dated obligations falling due in the next N days across every contract in the workspace, soonest first. Routine monthly fee dates are left out unless include_routine is true.',
    inputSchema: {
      days: z.number().int().min(1).max(730).default(60).describe('How many days ahead to look'),
      include_routine: z.boolean().default(false).describe('Include routine fee payment dates')
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, safely(async ({ days = 60, include_routine = false }) => {
    const reg = await svc.register(ctx);
    const due = reg.filter((i) => i.status === 'open' && i.due && i.daysLeft <= days && (include_routine || i.key !== 'fee_cycle'));
    const items = due.map((i) => ({ contract: i.contract.title, obligation: i.key, title: i.title, due: i.due, daysLeft: i.daysLeft, severity: i.severity, owner: i.owner?.name || null }));
    if (!items.length) return text(`Nothing is due in the next ${days} days.`, { days, items });
    const head = `${items.length} deadline${items.length === 1 ? '' : 's'} in the next ${days} days.`;
    const lines = items.slice(0, 5).map((i, n) => `${n + 1}. ${i.contract}: ${i.title}, due ${spokenDate(i.due)}, ${spokenDays(i.daysLeft)}${i.owner ? `, owned by ${i.owner}` : ', with no owner'}.`);
    return text([head, ...lines, items.length > 5 ? `And ${items.length - 5} more.` : ''].filter(Boolean).join(' '), { days, items });
  }));

  server.registerTool('renewal_exposure', {
    title: 'Money that renews by default',
    description: 'Totals the yearly value of contracts that will renew themselves in the next N days unless someone sends notice, with the last day to send it.',
    inputSchema: { days: z.number().int().min(1).max(730).default(90) },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, safely(async ({ days = 90 }) => {
    const [list, reg] = await Promise.all([svc.list(ctx), svc.register(ctx)]);
    const rows = reg.filter((i) => i.key === 'renewal_decision' && i.status === 'open' && i.daysLeft != null && i.daysLeft <= days).map((i) => {
      const c = list.find((x) => x.id === i.contract.id);
      return { contract: i.contract.title, noticeBy: i.due, daysLeft: i.daysLeft, renewsOn: i.renewsOn, annualValue: c?.annualValue?.amount ?? null, currency: c?.annualValue?.currency ?? null };
    });
    const total = rows.reduce((s, r) => s + (r.annualValue || 0), 0);
    if (!rows.length) return text(`No contracts renew by default in the next ${days} days.`, { days, total: 0, rows });
    const t = `${rows.length} contract${rows.length === 1 ? '' : 's'} worth about ${spokenMoney(total, rows[0].currency)} a year will renew unless notice is sent. ` +
      rows.map((r) => `${r.contract}: send notice by ${spokenDate(r.noticeBy)}, ${spokenDays(r.daysLeft)}.`).join(' ');
    return text(t, { days, total, rows });
  }));

  server.registerTool('list_contracts', {
    title: 'List contracts',
    description: 'Lists the contracts in the workspace with their counterparty, term end and next action.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, safely(async () => {
    const list = await svc.list(ctx);
    const rows = list.map((c) => ({ id: c.id, title: c.title, counterparty: c.counterparty, termEnds: c.term?.end || null, autoRenews: !!c.term?.autoRenews, next: c.next }));
    if (!rows.length) return text('There are no contracts in this workspace yet.', { contracts: [] });
    return text(`${rows.length} contracts: ${rows.map((r) => r.title).join('; ')}.`, { contracts: rows });
  }));

  server.registerTool('contract_obligations', {
    title: 'Obligations in one contract',
    description: 'Lists what one contract holds the workspace to: deadlines, recurring duties, event-triggered duties and risks. Name the contract the way a person would, for example "hosting" or "Helixa".',
    inputSchema: { contract: z.string().min(1).describe('Contract name, counterparty or id') },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, safely(async ({ contract }) => {
    const c = await resolveContract(contract);
    const doc = await svc.contract(ctx, c.id);
    const items = doc.schedule.items.filter((i) => i.appliesToUs !== false && !i.basedOnRejected)
      .map((i) => ({ obligation: i.key, kind: i.kind, title: i.title, due: i.due, daysLeft: i.daysLeft, status: i.status, owner: i.owner?.name || null }));
    const t = `${doc.title} has ${items.length} obligations for you. ` + items.slice(0, 6).map((i) => `${i.title}${i.due ? `, due ${spokenDate(i.due)}` : ''}.`).join(' ');
    return text(t, { contract: doc.title, items });
  }));

  server.registerTool('explain_deadline', {
    title: 'Explain a deadline from its clauses',
    description: 'Explains how a deadline was worked out, quoting each contract clause it depends on. Defaults to the renewal decision. Use this whenever the user asks why a date is what it is.',
    inputSchema: {
      contract: z.string().min(1).describe('Contract name, counterparty or id'),
      obligation: z.string().optional().describe('Which obligation, for example "renewal", "payment", "insurance". Defaults to the renewal decision.')
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, safely(async ({ contract, obligation }) => {
    const c = await resolveContract(contract);
    const doc = await svc.contract(ctx, c.id);
    const item = matchObligation(doc.schedule.items, obligation);
    if (!item) return problem(`I could not find that obligation in ${doc.title}.`);
    const byId = new Map(doc.findings.map((f) => [f.id, f]));
    const sources = item.citations.map((id) => byId.get(id)).filter(Boolean).map((f) => ({
      term: f.label,
      clause: f.clause.number ? `clause ${f.clause.number}` : 'the opening paragraph',
      quote: f.quote
    }));
    const lead = item.due
      ? `${item.title}. Due ${spokenDate(item.due)}, ${spokenDays(item.daysLeft)}.`
      : `${item.title}.`;
    // Renewal and its notice period usually share one sentence; say it once.
    const grouped = [];
    for (const s of sources) {
      const g = grouped.find((x) => x.quote === s.quote);
      if (g) g.terms.push(s.term.toLowerCase()); else grouped.push({ ...s, terms: [s.term] });
    }
    const because = grouped.map((s) => `${s.terms.join(' and ')}, from ${s.clause}: "${s.quote}"`).join(' ');
    const t = [lead, item.consequence || '', sources.length ? `This comes from: ${because}` : '', ...(item.assumptions || [])].filter(Boolean).join(' ');
    return text(t, { contract: doc.title, obligation: item.key, title: item.title, due: item.due, renewsOn: item.renewsOn || null, sources, assumptions: item.assumptions || [], textSha256: doc.textHash });
  }));

  server.registerTool('assign_obligation', {
    title: 'Give an obligation an owner',
    description: 'Assigns one obligation to a person in the workspace. The change is recorded in the audit trail as made through this assistant.',
    inputSchema: {
      contract: z.string().min(1),
      obligation: z.string().optional().describe('Defaults to the renewal decision'),
      person: z.string().min(1).describe('Name or email of a workspace member')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, safely(async ({ contract, obligation, person }) => {
    const c = await resolveContract(contract);
    const doc = await svc.contract(ctx, c.id);
    const item = matchObligation(doc.schedule.items, obligation);
    if (!item) return problem(`I could not find that obligation in ${doc.title}.`);
    const p = person.toLowerCase();
    const member = ctx.ws.members.find((m) => m.email.toLowerCase() === p) || ctx.ws.members.find((m) => m.name.toLowerCase().includes(p));
    if (!member) return problem(`Nobody called ${person} is in this workspace. The people are ${ctx.ws.members.map((m) => m.name).join(', ')}.`);
    await svc.updateItem(ctx, c.id, item.key, { owner: member.userId });
    return text(`Done. ${member.name} now owns "${item.title}" on ${doc.title}.`, { contract: doc.title, obligation: item.key, owner: member.name });
  }));

  server.registerTool('complete_obligation', {
    title: 'Mark an obligation done',
    description: 'Marks one obligation as done with a note saying what was done. The note is required and goes into the audit trail.',
    inputSchema: {
      contract: z.string().min(1),
      obligation: z.string().optional().describe('Defaults to the renewal decision'),
      note: z.string().min(3).describe('What was done, for example "Non-renewal notice emailed to Stratus Nine on 2 October"')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, safely(async ({ contract, obligation, note }) => {
    const c = await resolveContract(contract);
    const doc = await svc.contract(ctx, c.id);
    const item = matchObligation(doc.schedule.items, obligation);
    if (!item) return problem(`I could not find that obligation in ${doc.title}.`);
    await svc.updateItem(ctx, c.id, item.key, { status: 'done', note });
    return text(`Marked "${item.title}" on ${doc.title} as done, with your note. It is in the audit trail.`, { contract: doc.title, obligation: item.key, status: 'done' });
  }));

  server.registerTool('verify_audit_trail', {
    title: 'Verify the audit trail',
    description: 'Recomputes the hash chain over every audit event in the workspace and reports whether any event was altered, removed or reordered.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, safely(async () => {
    const r = await svc.auditVerify(ctx);
    return text(r.ok
      ? `The audit trail checks out: ${r.count} events, every link intact.`
      : `The audit trail is broken at event ${r.brokenAt}: ${r.problem}.`, r);
  }));

  return server;
}

// HTTP entry point for /mcp. Stateless: no session, one server per request.
export function createMcpHandler(store, opts = {}) {
  const svc = new Service(store, opts);
  return async (req) => {
    const auth = req.headers.get('authorization') || '';
    const key = auth.replace(/^Bearer\s+/i, '').trim();
    let ctx = null;
    try { ctx = await svc.apiContext(key); } catch (e) {
      if (e.status === 429) return new Response(JSON.stringify({ error: e.message }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '60' } });
      throw e;
    }
    if (!ctx) {
      return new Response(JSON.stringify({ error: 'A valid Termwise workspace key is required. Create one in Settings.' }), {
        status: 401,
        headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="termwise"' }
      });
    }
    const server = createMcpServer(svc, ctx);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(req);
  };
}

