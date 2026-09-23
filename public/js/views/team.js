import { api, h, toast, date } from '../common.js';

const ROLE_HELP = {
  viewer: 'Reads everything. Changes nothing.',
  member: 'Owns and closes obligations, reviews findings.',
  admin: 'Adds and erases contracts, invites people.',
  owner: 'Billing, admin roles, workspace export and erasure.'
};

export async function team(ctx) {
  const members = await ctx.members(true);
  const me = ctx.me;
  const link = h('div');
  const err = h('div.err');

  const invite = ctx.can('manage') ? h('div.card.pad',
    h('h2', 'Invite someone'),
    h('form.row.wrap', {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        const data = Object.fromEntries(new FormData(e.target));
        try {
          const r = await api('POST', '/api/members/invite', data);
          const url = `${location.origin}/app/invite/${r.token}`;
          link.replaceChildren(h('div.assume', 'Send this link to ', h('b', data.email), '. It works once and expires on ', date(r.expires), '.', h('div.row', { style: { marginTop: '6px' } },
            h('input', { type: 'text', value: url, readOnly: true, onclick: (x) => x.target.select() }),
            h('button.btn.small', { type: 'button', onclick: async () => { await navigator.clipboard.writeText(url); toast('Link copied'); } }, 'Copy'))));
          e.target.reset();
        } catch (x) {
          if (x.upgrade) err.replaceChildren(x.message, ' ', h('a', { href: '/app/billing' }, 'See plans'));
          else err.textContent = x.message;
        }
      }
    },
      h('input', { type: 'email', name: 'email', placeholder: 'name@company.com', required: true, style: { flex: '2', minWidth: '220px' }, 'aria-label': 'Email' }),
      h('select', { name: 'role', style: { flex: '1', minWidth: '140px' }, 'aria-label': 'Role' },
        ['member', 'viewer', ...(ctx.can('own') ? ['admin'] : [])].map((r) => h('option', { value: r }, r))),
      h('button.btn.primary', { type: 'submit' }, 'Create invite link')),
    err, link,
    h('p.hint', `${members.length} of ${me.plan.seats} seats used on the ${me.plan.name} plan.`)
  ) : null;

  const rows = members.map((m) => {
    const self = m.userId === me.user.id;
    const canEdit = ctx.can('manage') && !self && (ctx.can('own') || !['admin', 'owner'].includes(m.role));
    return h('tr',
      h('td', h('b', m.name), self ? h('span.muted.small', ' (you)') : null, h('div.small.muted', m.email)),
      h('td', canEdit
        ? h('select', {
            'aria-label': `Role for ${m.name}`,
            onchange: async (e) => {
              try { await api('PATCH', `/api/members/${m.userId}`, { role: e.target.value }); toast('Role changed'); ctx.go('/app/team', true); } catch (x) { toast(x.message, 'error'); ctx.go('/app/team', true); }
            }
          }, ['viewer', 'member', 'admin', ...(ctx.can('own') ? ['owner'] : [])].map((r) => h('option', { value: r, selected: r === m.role }, r)))
        : h('span.pill.blue', m.role)),
      h('td.small.muted', ROLE_HELP[m.role]),
      h('td.small.muted.nowrap', `Joined ${date(m.joinedAt)}`),
      h('td', canEdit ? h('button.btn.small.danger', {
        onclick: async () => {
          try { await api('DELETE', `/api/members/${m.userId}`); toast('Removed'); ctx.go('/app/team', true); } catch (x) { toast(x.message, 'error'); }
        }
      }, 'Remove') : null)
    );
  });

  return h('div',
    h('div.page-head', h('div', h('h1', 'Team'), h('div.sub', 'Roles are checked by the server on every request. A change applies to open sessions at once.'))),
    invite,
    h('div.section-title', 'People'),
    h('div.card', h('table.grid', h('thead', h('tr', h('th', 'Person'), h('th', 'Role'), h('th', 'Can'), h('th', ''), h('th', ''))), h('tbody', rows)))
  );
}
