import { api, h, toast, startDemo } from './common.js';
import { overview } from './views/overview.js';
import { contracts, contractDetail } from './views/contracts.js';
import { obligations } from './views/obligations.js';
import { auditView } from './views/audit.js';
import { team } from './views/team.js';
import { billing } from './views/billing.js';
import { settings } from './views/settings.js';
import { assistant } from './views/assistant.js';

const root = document.getElementById('root');

const NAV = [
  ['overview', 'Overview', 'M3 12h4l3-8 4 16 3-8h4'],
  ['contracts', 'Contracts', 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7'],
  ['obligations', 'Obligations', 'M4 6h2M4 12h2M4 18h2M9 6h11M9 12h11M9 18h11'],
  ['assistant', 'Assistant', 'M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3zM5 11a7 7 0 0014 0M12 18v3'],
  ['audit', 'Audit trail','M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4'],
  ['team', 'Team', 'M16 19v-1a4 4 0 00-4-4H7a4 4 0 00-4 4v1M9.5 10a3 3 0 100-6 3 3 0 000 6zM21 19v-1a4 4 0 00-3-3.9M16 4.1a3 3 0 010 5.8'],
  ['billing', 'Plan & billing', 'M3 7h18v10H3zM3 11h18'],
  ['settings', 'Settings', 'M12 15a3 3 0 100-6 3 3 0 000 6zM19 12a7 7 0 00-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 00-2-1.2L14 3h-4l-.5 2.6a7 7 0 00-2 1.2l-2.4-1-2 3.4 2 1.6a7 7 0 000 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 002 1.2L10 21h4l.5-2.6a7 7 0 002-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z']
];

function icon(d) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'ico');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d);
  svg.append(p);
  return svg;
}

const state = { me: null, members: null, counts: {} };

export function go(path, replace = false) {
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  route();
}

window.addEventListener('popstate', route);
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="/app"]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || a.target) return;
  e.preventDefault();
  go(a.getAttribute('href'));
});

const ctx = {
  go,
  get me() { return state.me; },
  async refreshMe() { state.me = await api('GET', '/api/me'); return state.me; },
  async members(force = false) {
    if (!state.members || force) state.members = await api('GET', '/api/members');
    return state.members;
  },
  can(action) {
    const order = ['viewer', 'member', 'admin', 'owner'];
    const need = { work: 'member', manage: 'admin', own: 'owner' }[action] || 'viewer';
    return order.indexOf(state.me.role) >= order.indexOf(need);
  },
  setCount(key, n, hot) { state.counts[key] = { n, hot }; paintCounts(); },
  upgradeHint(e) {
    if (e.upgrade) toast(`${e.message} Open Plan & billing to switch.`, 'error');
    else toast(e.message, 'error');
  }
};

async function route() {
  const parts = location.pathname.replace(/^\/app\/?/, '').split('/').filter(Boolean);
  const [page = 'overview', arg] = parts;

  if (page === 'login' || page === 'signup') return authPage(page);
  if (page === 'invite') return invitePage(arg);

  if (!state.me) {
    try { await ctx.refreshMe(); } catch (e) {
      if (e.status === 401) return go('/app/login', true);
      root.replaceChildren(h('div.empty', h('h3', 'Could not reach Termwise'), h('p', e.message)));
      return;
    }
  }

  const views = { overview, contracts, obligations, assistant, audit: auditView, team, billing, settings };
  const view = page === 'contracts' && arg ? (c) => contractDetail(c, arg) : views[page];
  if (!view) return go('/app/overview', true);

  const shell = renderShell(page);
  const slot = shell.querySelector('.page');
  root.replaceChildren(shell);
  slot.append(h('div.muted.small', 'Loading...'));
  try {
    const el = await view(ctx);
    slot.replaceChildren(el);
    document.title = `${NAV.find((n) => n[0] === page)?.[1] || 'Termwise'} · Termwise`;
  } catch (e) {
    if (e.status === 401) { state.me = null; return go('/app/login', true); }
    slot.replaceChildren(h('div.card.pad.empty', h('h3', 'That did not load'), h('p', e.message), h('a.btn', { href: '/app/overview' }, 'Back to overview')));
  }
  window.scrollTo(0, 0);
}

function paintCounts() {
  for (const [key, { n, hot }] of Object.entries(state.counts)) {
    const el = document.querySelector(`a.nav[data-key="${key}"] .count`);
    if (!el) continue;
    el.textContent = n || '';
    el.classList.toggle('hidden', !n);
    el.classList.toggle('hot', !!hot);
  }
}

function renderShell(active) {
  const me = state.me;
  const side = h('aside.side',
    h('a.brand', { href: '/app/overview' }, h('img', { src: '/img/mark.svg', width: 24, height: 24, alt: '' }), 'Termwise'),
    h('div.ws',
      h('span.muted', 'Workspace'),
      h('b', me.workspace.name),
      me.workspaces.length > 1
        ? h('select', {
            'aria-label': 'Switch workspace',
            onchange: async (e) => { await api('POST', '/api/me/workspace', { workspaceId: e.target.value }); state.me = null; state.members = null; go('/app/overview'); }
          }, me.workspaces.map((w) => h('option', { value: w.id, selected: w.id === me.workspace.id }, w.name)))
        : null
    ),
    NAV.map(([key, label, d]) => h(`a.nav${key === active ? '.on' : ''}`, { href: `/app/${key}`, dataset: { key } }, icon(d), label, h('span.count.hidden'))),
    h('div.foot',
      h('div.who', me.user.name),
      h('div.muted', `${me.role[0].toUpperCase()}${me.role.slice(1)} · ${me.plan.name} plan`),
      h('button.btn.ghost.small', {
        onclick: async () => { await api('POST', '/api/auth/logout'); state.me = null; location.href = '/'; }
      }, 'Sign out')
    )
  );
  const banner = me.workspace.demo
    ? h('div.banner', 'This is a demo workspace with sample contracts. Change anything you like; it deletes itself after 24 hours. ', h('a', { href: '/app/signup' }, 'Create a real workspace'))
    : null;
  const shell = h('div.shell', side, h('main.main', banner, h('div.page')));
  queueMicrotask(paintCounts);
  return shell;
}

// ---------- sign in, sign up, invites ----------

function authCard(title, sub, form, alt) {
  return h('div.auth', h('div.card',
    h('a.brand.row', { href: '/' }, h('img', { src: '/img/mark.svg', width: 26, height: 26, alt: '' }), h('b', 'Termwise')),
    h('h1', title),
    sub ? h('p.muted', sub) : null,
    form,
    alt
  ));
}

function field(label, attrs, hint) {
  const id = `f-${attrs.name}`;
  return h('div.field', h('label', { for: id }, label), h('input', { id, ...attrs }), hint ? h('div.hint', hint) : null);
}

function authPage(kind) {
  const err = h('div.err');
  const signup = kind === 'signup';
  const submit = h('button.btn.primary.big', { type: 'submit', style: { width: '100%' } }, signup ? 'Create workspace' : 'Sign in');
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      submit.disabled = true;
      const data = Object.fromEntries(new FormData(e.target));
      try {
        await api('POST', `/api/auth/${kind}`, data);
        state.me = null;
        const plan = new URLSearchParams(location.search).get('plan');
        go(signup && plan ? '/app/billing' : '/app/overview');
      } catch (x) {
        err.textContent = x.message;
        submit.disabled = false;
      }
    }
  },
    signup ? field('Your name', { name: 'name', type: 'text', autocomplete: 'name', required: true }) : null,
    signup ? field('Company or team', { name: 'workspace', type: 'text', placeholder: 'Brightpath Logistics' }) : null,
    field('Work email', { name: 'email', type: 'email', autocomplete: 'email', required: true }),
    field('Password', { name: 'password', type: 'password', autocomplete: signup ? 'new-password' : 'current-password', required: true, minlength: signup ? 10 : null }, signup ? 'At least 10 characters.' : null),
    err,
    submit
  );
  const alt = h('div.alt',
    signup ? h('span', 'Already have a workspace? ', h('a', { href: '/app/login' }, 'Sign in')) : h('span', 'New here? ', h('a', { href: '/app/signup' }, 'Create a workspace')),
    h('div', { style: { marginTop: '10px' } }, h('button.btn.ghost.small', { type: 'button', onclick: (e) => startDemo(e.target) }, 'Or open the live demo'))
  );
  root.replaceChildren(authCard(signup ? 'Create your workspace' : 'Sign in', signup ? 'Free for up to five contracts. No card needed.' : null, form, alt));
  document.title = `${signup ? 'Create workspace' : 'Sign in'} · Termwise`;
}

async function invitePage(token) {
  let info;
  try { info = await api('GET', `/api/invites/${encodeURIComponent(token)}`); } catch (e) {
    root.replaceChildren(authCard('Invite not valid', e.message, h('a.btn', { href: '/app/login' }, 'Go to sign in')));
    return;
  }
  const err = h('div.err');
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      try {
        await api('POST', `/api/invites/${encodeURIComponent(token)}/accept`, Object.fromEntries(new FormData(e.target)));
        state.me = null;
        go('/app/overview');
      } catch (x) { err.textContent = x.message; }
    }
  },
    h('p.small', `Joining as ${info.email}, role: ${info.role}.`),
    info.hasAccount ? null : field('Your name', { name: 'name', type: 'text', required: true }),
    field(info.hasAccount ? 'Your existing password' : 'Choose a password', { name: 'password', type: 'password', required: true, minlength: info.hasAccount ? null : 10 }),
    err,
    h('button.btn.primary', { type: 'submit' }, 'Join workspace')
  );
  root.replaceChildren(authCard(`Join ${info.workspace}`, `${info.invitedBy} invited you.`, form));
}

route();
