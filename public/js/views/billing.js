import { api, h, toast } from '../common.js';

const FEATURES = {
  free: ['5 contracts', '2 people', 'Deadline register', 'Audit trail with verification'],
  team: ['150 contracts', '10 people', 'Calendar feed for Google or Outlook', 'Audit trail export'],
  business: ['2,000 contracts', '50 people', 'Everything in Team', 'Onboarding help']
};

export async function billing(ctx) {
  const [me, plans] = await Promise.all([ctx.refreshMe(), api('GET', '/api/plans')]);
  const usage = (label, used, max) => {
    const pct = Math.min(100, Math.round((used / max) * 100));
    return h('div.card.pad',
      h('div.row', h('b', label), h('span.spacer'), h('span.small.muted', `${used} of ${max.toLocaleString('en-IN')}`)),
      h(`div.bar${pct >= 80 ? '.warn' : ''}`, h('span', { style: { width: `${pct}%` } })),
      h('div.small.muted', pct >= 100 ? 'At the limit. The server will refuse more until you upgrade.' : `${pct}% used`));
  };

  const cards = plans.map((p) => {
    const current = p.id === me.plan.id;
    return h(`div.card.plan${current ? '.current' : ''}`,
      h('div.row', h('h2', p.name), h('span.spacer'), current ? h('span.pill.green', 'Current') : null),
      h('div.price', p.priceInr ? `₹${p.priceInr.toLocaleString('en-IN')}` : 'Free', p.priceInr ? h('span.small.muted', ' / month') : null),
      h('div.small.muted', p.blurb),
      h('ul', FEATURES[p.id].map((f) => h('li', f))),
      current ? h('button.btn', { disabled: true }, 'Your plan')
        : ctx.can('own')
          ? h('button.btn.primary', {
              onclick: async (e) => {
                e.target.disabled = true;
                try { await api('POST', '/api/billing/plan', { plan: p.id }); toast(`Switched to ${p.name}`); ctx.go('/app/billing', true); } catch (x) { toast(x.message, 'error'); e.target.disabled = false; }
              }
            }, p.priceInr > me.plan.priceInr ? `Upgrade to ${p.name}` : `Switch to ${p.name}`)
          : h('button.btn', { disabled: true, title: 'Only an owner can change the plan' }, 'Owner only'));
  });

  return h('div',
    h('div.page-head', h('div', h('h1', 'Plan & billing'), h('div.sub', 'Priced per workspace, not per contract, so adding the next contract never needs a purchase order.'))),
    h('div.usage', usage('Contracts', me.usage.contracts, me.plan.contracts), usage('People', me.usage.seats, me.plan.seats)),
    h('div.plans', cards),
    h('div.assume', { style: { marginTop: '18px' } }, 'Payments are in test mode while Termwise is in its pilot. Changing plan applies every limit and feature for real, and is recorded in the audit trail as a test-mode change. No card is taken.')
  );
}
