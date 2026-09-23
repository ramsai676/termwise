import { api, h, toast, when } from '../common.js';

const ACTIONS = {
  'workspace.created': 'Created the workspace',
  'contract.added': 'Added a contract',
  'contract.erased': 'Erased a contract',
  'contract.perspective_changed': 'Changed which side we are',
  'obligation.updated': 'Updated an obligation',
  'finding.confirmed': 'Confirmed a finding',
  'finding.rejected': 'Rejected a finding',
  'member.invited': 'Invited someone',
  'member.joined': 'Joined',
  'member.role_changed': 'Changed a role',
  'member.removed': 'Removed someone',
  'billing.plan_changed': 'Changed plan',
  'calendar.feed_issued': 'Issued a calendar link',
  'audit.exported': 'Exported the audit trail',
  'workspace.exported': 'Exported the workspace'
};

export async function auditView(ctx) {
  const [events, check, members] = await Promise.all([api('GET', '/api/audit?limit=500'), api('GET', '/api/audit/verify'), ctx.members()]);
  // The log stores ids, which stay true if someone changes their name; the
  // page shows the current name next to them.
  const names = new Map(members.map((m) => [m.userId, m.name]));
  const who = (idOrNull) => (idOrNull ? names.get(idOrNull) || idOrNull : 'none');
  const status = h('div');
  const paintCheck = (r) => status.replaceChildren(h(`div.card.verify.${r.ok ? 'ok' : 'bad'}`,
    h('div',
      h('div.big', r.ok ? `Chain intact: ${r.count} events` : `Chain broken at event ${r.brokenAt}`),
      h('div.small', r.ok
        ? 'Each event carries the SHA-256 of the one before it. Recomputed just now from the stored events; every link checks out.'
        : `${r.problem}. Events after this point cannot be trusted until someone finds out what changed.`),
      h('div.hash', `head ${r.head}`)),
    h('span.spacer'),
    h('button.btn', {
      onclick: async (e) => {
        e.target.disabled = true;
        const again = await api('GET', '/api/audit/verify');
        paintCheck(again);
        toast(again.ok ? 'Verified' : 'Chain is broken', again.ok ? '' : 'error');
      }
    }, 'Verify again')));
  paintCheck(check);

  const rows = [...events].reverse().map((e) => h('tr',
    h('td.nowrap', h('b', `#${e.seq}`)),
    h('td.nowrap.small', when(e.at)),
    h('td.small', names.get(e.actor.id) || e.actor.email || 'system', names.has(e.actor.id) ? h('div.muted', e.actor.email) : null),
    h('td', h('div', ACTIONS[e.action] || e.action), h('div.hash', e.action)),
    h('td', h('div.detail-json', describe(e, who))),
    h('td', h('div.hash', { title: `hash ${e.hash}\nprev ${e.prev}` }, e.hash.slice(0, 10)))
  ));

  return h('div',
    h('div.page-head',
      h('div', h('h1', 'Audit trail'), h('div.sub', 'Every change in this workspace, in order, chained by hash. Nothing here can be edited from the app.')),
      h('span.spacer'),
      ctx.can('manage')
        ? h('button.btn', {
            onclick: async () => {
              const r = await fetch('/api/audit/export', { credentials: 'same-origin' });
              if (!r.ok) { const d = await r.json(); return ctx.upgradeHint({ message: d.error, upgrade: d.upgrade }); }
              const blob = await r.blob();
              const a = h('a', { href: URL.createObjectURL(blob), download: `termwise-audit-${ctx.me.workspace.id}.jsonl` });
              document.body.append(a); a.click(); a.remove();
            }
          }, 'Export as JSON Lines')
        : null),
    status,
    h('div.card', h('table.grid',
      h('thead', h('tr', h('th', 'Seq'), h('th', 'When'), h('th', 'Who'), h('th', 'What'), h('th', 'Detail'), h('th', 'Hash'))),
      h('tbody', rows)))
  );
}

function describe(e, who) {
  const d = e.detail || {};
  switch (e.action) {
    case 'contract.added': return `${d.title} · ${d.findings} findings · as ${d.perspective || 'unset'} · text sha256 ${String(d.textHash).slice(0, 12)}`;
    case 'contract.erased': return `${d.title} · text sha256 ${String(d.textHash).slice(0, 12)}${d.reason ? ` · ${d.reason}` : ''}`;
    case 'obligation.updated': return `${e.target.split('#')[1]}: ${Object.entries(d).map(([k, v]) => {
      if (!Array.isArray(v)) return k;
      const [a, b] = k === 'owner' ? [who(v[0]), who(v[1])] : [v[0] ?? 'none', v[1] ?? 'none'];
      return `${k} ${a} → ${b}`;
    }).join(', ')}`;
    case 'member.role_changed': return `${who(e.target)}: ${d.from} → ${d.to}`;
    case 'finding.rejected': return `"${d.quote}" · ${d.reason}`;
    case 'finding.confirmed': return `"${d.quote}"`;
    case 'billing.plan_changed': return `${d.from} → ${d.to} (test mode, no charge)`;
    default: return Object.keys(d).length ? JSON.stringify(d) : '';
  }
}
