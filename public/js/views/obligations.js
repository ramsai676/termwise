import { api, h, toast, date, daysText, urgency } from '../common.js';

const KINDS = [
  ['all', 'All'],
  ['dated', 'Dated'],
  ['recurring', 'Recurring'],
  ['playbook', 'If it happens'],
  ['risk', 'Risks']
];

export async function obligations(ctx) {
  const [items, members] = await Promise.all([api('GET', '/api/register'), ctx.members()]);
  const filter = { kind: 'dated', status: 'open', owner: '' };
  const body = h('tbody');
  const count = h('span.muted.small');

  const paint = () => {
    const rows = items.filter((i) =>
      (filter.kind === 'all' || (filter.kind === 'dated' ? !!i.due : filter.kind === 'recurring' ? i.kind === 'recurring' : i.kind === filter.kind)) &&
      (filter.status === 'all' || i.status === filter.status) &&
      (!filter.owner || (filter.owner === 'none' ? !i.owner : i.owner?.id === filter.owner)));
    count.textContent = `${rows.length} shown`;
    body.replaceChildren(...(rows.length ? rows.map(row) : [h('tr', h('td', { colspan: 5 }, h('div.empty', 'Nothing matches these filters.')))]));
  };

  const row = (i) => h('tr.click', { onclick: (e) => { if (e.target.closest('select')) return; ctx.go(`/app/contracts/${i.contract.id}?item=${encodeURIComponent(i.key)}`); } },
    h('td.nowrap', i.due ? [h(`span.pill.${urgency(i.daysLeft)}`, date(i.due)), h('div.small.muted', daysText(i.daysLeft))] : h('span.small.muted', i.trigger || i.window || '')),
    h('td', h('div', h('b', i.title)), i.consequence ? h('div.small.muted', i.consequence) : null),
    h('td.small', i.contract.title, h('div.muted', i.contract.counterparty || '')),
    h('td', ctx.can('work') && i.kind !== 'risk'
      ? h('select', {
          'aria-label': 'Owner',
          onchange: async (e) => {
            try {
              await api('PATCH', `/api/contracts/${i.contract.id}/items/${encodeURIComponent(i.key)}`, { owner: e.target.value || null });
              const m = members.find((x) => x.userId === e.target.value);
              i.owner = m ? { id: m.userId, name: m.name } : null;
              toast('Owner updated');
            } catch (x) { toast(x.message, 'error'); }
          }
        }, h('option', { value: '' }, 'No owner'), members.map((m) => h('option', { value: m.userId, selected: i.owner?.id === m.userId }, m.name)))
      : h('span.small', i.owner?.name || '-')),
    h('td', h(`span.pill.${i.severity}`, i.severity), i.confirmed ? h('div.small.muted', 'confirmed') : h('div.small', h('span.pill.amber', 'unconfirmed')))
  );

  const seg = (options, key) => {
    const box = h('div.seg');
    for (const [v, label] of options) {
      box.append(h(`button${filter[key] === v ? '.on' : ''}`, {
        onclick: (e) => {
          filter[key] = v;
          box.querySelectorAll('button').forEach((b) => b.classList.remove('on'));
          e.currentTarget.classList.add('on');
          paint();
        }
      }, label));
    }
    return box;
  };

  const ownerSel = h('select', { style: { width: 'auto' }, 'aria-label': 'Filter by owner', onchange: (e) => { filter.owner = e.target.value; paint(); } },
    h('option', { value: '' }, 'Anyone'), h('option', { value: 'none' }, 'No owner'), members.map((m) => h('option', { value: m.userId }, m.name)));

  paint();
  return h('div',
    h('div.page-head',
      h('div', h('h1', 'Obligations'), h('div.sub', 'Everything the workspace\'s contracts hold you to, across every contract, soonest first.')),
      h('span.spacer'),
      h('a.btn', { href: '/app/settings#calendar' }, 'Add to calendar')),
    h('div.filters', seg(KINDS, 'kind'), seg([['open', 'Open'], ['done', 'Done'], ['all', 'Any status']], 'status'), ownerSel, h('span.spacer'), count),
    h('div.card', h('table.grid',
      h('thead', h('tr', h('th', 'Due'), h('th', 'Obligation'), h('th', 'Contract'), h('th', 'Owner'), h('th', 'Status'))),
      body))
  );
}
