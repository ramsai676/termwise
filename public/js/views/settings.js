import { api, h, toast } from '../common.js';

export async function settings(ctx) {
  const me = ctx.me;
  const feedOut = h('div');

  const calendar = h('div.card.pad', { id: 'calendar' },
    h('h2', 'Calendar feed'),
    h('p.small', 'A private link your calendar app subscribes to. Every open, dated obligation appears as an all-day event, with alerts 3 days before, and 14 days before for anything high risk. Making a new link switches the old one off.'),
    me.plan.calendarFeed
      ? ctx.can('manage')
        ? h('button.btn.primary', {
            onclick: async () => {
              try {
                const { token } = await api('POST', '/api/calendar');
                const url = `${location.origin}/api/calendar/${token}.ics`;
                feedOut.replaceChildren(h('div.assume',
                  'In Google Calendar: Other calendars, From URL. In Outlook: Add calendar, Subscribe from web.',
                  h('div.row', { style: { marginTop: '6px' } },
                    h('input', { type: 'text', value: url, readOnly: true, onclick: (e) => e.target.select() }),
                    h('button.btn.small', { onclick: async () => { await navigator.clipboard.writeText(url); toast('Link copied'); } }, 'Copy'),
                    h('a.btn.small', { href: url.replace(/^https?:/, 'webcal:') }, 'Open'))));
              } catch (e) { ctx.upgradeHint(e); }
            }
          }, 'Create calendar link')
        : h('p.muted.small', 'An admin can create the link.')
      : h('p', h('span.pill.amber', 'Team plan'), ' ', h('a', { href: '/app/billing' }, 'Upgrade to add deadlines to your calendar.')),
    feedOut
  );

  const exportCard = h('div.card.pad',
    h('h2', 'Export everything'),
    h('p.small', 'One JSON file with every contract, finding, review, obligation state and the full audit trail. Use it to move elsewhere or to answer a data access request.'),
    ctx.can('own')
      ? h('button.btn', {
          onclick: async () => {
            const r = await fetch('/api/workspace/export', { credentials: 'same-origin' });
            if (!r.ok) return toast((await r.json()).error, 'error');
            const a = h('a', { href: URL.createObjectURL(await r.blob()), download: `termwise-export-${me.workspace.id}.json` });
            document.body.append(a); a.click(); a.remove();
          }
        }, 'Download workspace export')
      : h('p.muted.small', 'Only an owner can export the workspace.')
  );

  const confirm = h('input', { type: 'text', placeholder: me.workspace.name, 'aria-label': 'Workspace name' });
  const err = h('div.err');
  const erase = h('div.card.pad',
    h('h2', 'Erase this workspace'),
    h('p.small', 'Deletes every contract, finding, member link and the audit trail, immediately and for good. Download an export first if you might need any of it.'),
    ctx.can('own')
      ? [h('div.field', h('label', `Type "${me.workspace.name}" to confirm`), confirm), err,
         h('button.btn.danger', {
           onclick: async () => {
             err.textContent = '';
             try { await api('DELETE', '/api/workspace', { confirm: confirm.value }); location.href = '/'; } catch (e) { err.textContent = e.message; }
           }
         }, 'Erase workspace')]
      : h('p.muted.small', 'Only an owner can erase the workspace.')
  );

  const el = h('div',
    h('div.page-head', h('div', h('h1', 'Settings'), h('div.sub', me.workspace.name))),
    h('div', { style: { display: 'grid', gap: '16px', maxWidth: '760px' } }, calendar, exportCard, erase));
  if (location.hash === '#calendar') setTimeout(() => el.querySelector('#calendar')?.scrollIntoView({ behavior: 'smooth' }), 100);
  return el;
}
