import { api, h, date, money, daysText, urgency } from '../common.js';
import { openUpload } from './contracts.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export async function overview(ctx) {
  const [list, register] = await Promise.all([api('GET', '/api/contracts'), api('GET', '/api/register')]);
  const open = register.filter((i) => i.status === 'open');
  const dated = open.filter((i) => i.due).sort((a, b) => a.due.localeCompare(b.due));
  // Routine fee dates are in the register; the overview is for decisions.
  const decisions = dated.filter((i) => i.key !== 'fee_cycle');
  const soon = decisions.filter((i) => i.daysLeft <= 90);
  const overdue = dated.filter((i) => i.daysLeft < 0);
  const unowned = open.filter((i) => !i.owner && i.kind !== 'risk');
  const risks = open.filter((i) => i.kind === 'risk');
  const unreviewed = list.reduce((n, c) => n + c.unreviewed, 0);

  ctx.setCount('obligations', soon.filter((i) => i.daysLeft <= 30).length, true);

  // Money that renews by default in the next 90 days unless someone acts.
  const exposure = new Map();
  for (const i of soon.filter((x) => x.key === 'renewal_decision')) {
    const c = list.find((x) => x.id === i.contract.id);
    if (c?.annualValue) exposure.set(c.annualValue.currency || 'INR', (exposure.get(c.annualValue.currency || 'INR') || 0) + c.annualValue.amount);
  }
  const renewalsSoon = soon.filter((x) => x.key === 'renewal_decision').length;

  const head = h('div.page-head',
    h('div', h('h1', 'Overview'), h('div.sub', `${list.length} contract${list.length === 1 ? '' : 's'} in ${ctx.me.workspace.name}`)),
    h('span.spacer'),
    ctx.can('manage') ? h('button.btn.primary', { onclick: () => openUpload(ctx) }, 'Add contract') : null
  );

  if (!list.length) {
    return h('div', head, h('div.card.empty',
      h('h3', 'No contracts yet'),
      h('p', 'Add a vendor contract and Termwise will pull out every renewal window, notice period and duty in it.'),
      ctx.can('manage') ? h('button.btn.primary', { onclick: () => openUpload(ctx) }, 'Add your first contract') : null
    ));
  }

  const next = decisions.find((i) => i.daysLeft >= 0 && i.severity !== 'low') || decisions.find((i) => i.daysLeft >= 0);
  const kpis = h('div.kpis',
    kpi('Next deadline', next ? `${next.daysLeft} days` : 'None', next ? `${next.title.slice(0, 48)}${next.title.length > 48 ? '...' : ''}` : 'Nothing dated is open', next ? urgency(next.daysLeft) : ''),
    kpi('Renews by default in 90 days', exposure.size ? [...exposure].map(([c, a]) => money(a, c)).join(' + ') : '₹0', `${renewalsSoon} contract${renewalsSoon === 1 ? '' : 's'} a year at a time unless someone acts`, exposure.size ? 'amber' : ''),
    kpi('Open with no owner', String(unowned.length), unowned.length ? 'Give each one a person' : 'Every obligation has an owner', unowned.length ? 'amber' : ''),
    kpi('Findings to review', String(unreviewed), overdue.length ? `${overdue.length} deadline${overdue.length === 1 ? '' : 's'} overdue` : 'Confirm or reject each one', overdue.length ? 'red' : '')
  );

  const timeline = h('div.card.pad',
    h('h2', 'Next 90 days'),
    soon.length
      ? h('ul.timeline', soon.slice(0, 12).map((i) => timelineRow(ctx, i)))
      : h('p.muted', 'Nothing dated falls due in the next 90 days.'),
    h('a.small', { href: '/app/obligations' }, `See all ${dated.length} dated obligations, including routine fee dates`)
  );

  const riskCard = h('div.card.pad',
    h('h2', 'Terms working against you'),
    risks.length
      ? h('ul.risk-list', risks.map((r) => h('li', { onclick: () => ctx.go(`/app/contracts/${r.contract.id}?item=${encodeURIComponent(r.key)}`) },
          h(`span.pill.${r.severity}`, r.severity),
          h('div', h('div', r.title), h('div.small.muted', r.contract.title)))))
      : h('p.muted', 'No price, interest or renewal risks found.')
  );

  const byContract = h('div.card',
    h('table.grid',
      h('thead', h('tr', h('th', 'Contract'), h('th', 'Term ends'), h('th', 'Next action'), h('th', 'Value / year'))),
      h('tbody', list.map((c) => h('tr.click', { onclick: () => ctx.go(`/app/contracts/${c.id}`) },
        h('td', h('div', h('b', c.title)), h('div.small.muted', c.counterparty || '')),
        h('td.nowrap', c.term ? date(c.term.end) : h('span.muted', 'Not stated'), c.term?.autoRenews ? h('div.small.muted', 'renews itself') : null),
        h('td', c.next ? [h('div', c.next.title), h(`div.small`, h(`span.pill.${urgency(c.next.daysLeft)}`, `${date(c.next.due)}, ${daysText(c.next.daysLeft)}`))] : h('span.muted', 'Nothing dated')),
        h('td.nowrap', c.annualValue ? money(c.annualValue.amount, c.annualValue.currency) : h('span.muted', '-'))
      )))
    )
  );

  return h('div', head, kpis, h('div.two', timeline, riskCard), h('div.section-title', 'Contracts'), byContract);
}

function kpi(label, value, foot, tone) {
  return h('div.card.kpi', h('div.label', label), h(`div.value${tone ? '.' + tone : ''}`, value), h('div.foot', foot));
}

function timelineRow(ctx, i) {
  const [, m, d] = i.due.split('-').map(Number);
  return h('li', { onclick: () => ctx.go(`/app/contracts/${i.contract.id}?item=${encodeURIComponent(i.key)}`) },
    h(`div.when-box.${urgency(i.daysLeft)}`, h('div.d', String(d)), h('div.m', MONTHS[m - 1])),
    h('div',
      h('div.tl-title', i.title),
      h('div.tl-sub', `${i.contract.title} · ${daysText(i.daysLeft)}${i.owner ? ` · ${i.owner.name}` : ' · no owner'}`)),
    h(`span.pill.${i.severity}`, i.severity)
  );
}
