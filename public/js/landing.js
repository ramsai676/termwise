import { api, h, startDemo } from './common.js';

document.querySelectorAll('[data-demo]').forEach((b) => b.addEventListener('click', () => startDemo(b)));

const FEATURES = {
  free: ['5 contracts', '2 people', 'Deadline register and audit log', 'Clause-cited findings'],
  team: ['150 contracts', '10 people', 'Calendar feed for Google or Outlook', 'Audit log export'],
  business: ['2,000 contracts', '50 people', 'Everything in Team', 'Priority help with onboarding']
};

api('GET', '/api/plans').then((plans) => {
  const box = document.getElementById('plans');
  for (const p of plans) {
    box.append(h(`div.plan${p.id === 'team' ? '.featured' : ''}`,
      h('h3', p.name),
      h('p.price', p.priceInr ? `₹${p.priceInr.toLocaleString('en-IN')}` : 'Free', p.priceInr ? h('small', ' / month') : null),
      h('p.muted.small', p.blurb),
      h('ul', FEATURES[p.id].map((f) => h('li', f))),
      p.id === 'free'
        ? h('a.btn', { href: '/app/signup' }, 'Start free')
        : h('a.btn.primary', { href: `/app/signup?plan=${p.id}` }, `Start with ${p.name}`)
    ));
  }
}).catch(() => {});
