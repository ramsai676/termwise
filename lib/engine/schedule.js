// Turns findings into things a person has to do, with a date where the contract
// supports one. Every item carries the ids of the findings it was computed from,
// so the arithmetic behind a deadline is visible: this effective date, plus this
// term, minus this notice period, each one a quote from the document.

import { addDuration, addDays, addMonths, daysBetween, today as todayOf, formatDate } from './dates.js';
import { durationLabel } from './quantity.js';

const first = (findings, type) => findings.find((f) => f.type === type);
const all = (findings, type) => findings.filter((f) => f.type === type);

// Works out the current term end. For an evergreen contract that means rolling
// forward one renewal period at a time until the end date is in the future.
export function currentTerm(findings, asOf) {
  const eff = first(findings, 'effective_date');
  const term = first(findings, 'initial_term');
  const fixedEnd = first(findings, 'end_date');
  const auto = first(findings, 'auto_renewal');
  const basis = [];

  let end = null;
  if (fixedEnd) { end = fixedEnd.value.date; basis.push(fixedEnd.id); }
  else if (eff && term) { end = addDuration(eff.value.date, term.value.duration); basis.push(eff.id, term.id); }
  if (!end) return null;

  let renewals = 0;
  let renewal = null;
  let assumedRenewal = false;
  if (auto) {
    basis.push(auto.id);
    renewal = auto.value.renewal;
    if (!renewal && term) { renewal = term.value.duration; assumedRenewal = true; }
    if (renewal && renewal.unit !== 'hours') {
      // Bounded so a malformed one-day renewal cannot spin forever.
      while (end <= asOf && renewals < 400) { end = addDuration(end, renewal); renewals++; }
    }
  }
  const start = renewals && renewal ? addDuration(end, renewal, -1) : eff ? eff.value.date : null;
  return { start, end, renewals, renewal, assumedRenewal, autoRenews: !!auto, basis };
}

function item(o) {
  return { status: 'open', ...o };
}

export function schedule(extraction, opts = {}) {
  const asOf = opts.today || todayOf();
  const f = extraction.findings;
  const items = [];
  const term = currentTerm(f, asOf);
  const fees = first(f, 'fees');
  const notice = first(f, 'renewal_notice');

  if (term && term.autoRenews) {
    let renewsOn = term.end;
    let deadline = notice ? addDuration(renewsOn, notice.value.duration, -1) : null;
    // Past the notice window, the coming renewal is locked in. The useful date is
    // the next window, and the person should be told which renewal they missed.
    let missed = null;
    if (deadline && deadline < asOf && term.renewal) {
      missed = { deadline, renewsOn };
      renewsOn = addDuration(renewsOn, term.renewal);
      deadline = addDuration(renewsOn, notice.value.duration, -1);
    }
    const value = fees ? `${fees.value.currency || ''} ${Math.round(fees.value.annual * (term.renewal ? termYears(term.renewal) : 1)).toLocaleString('en-IN')}`.trim() : null;
    items.push(item({
      key: 'renewal_decision',
      kind: 'deadline',
      title: deadline ? 'Decide: renew, renegotiate or send non-renewal notice' : 'Automatic renewal with no notice period found',
      due: deadline || term.end,
      renewsOn,
      missed,
      window: notice ? durationLabel(notice.value.duration) : null,
      consequence: `If nothing is sent, the contract renews on ${formatDate(renewsOn)} for ${term.renewal ? durationLabel(term.renewal) : 'another term'}${value ? `, committing about ${value}` : ''}.`,
      severity: 'high',
      appliesToUs: true,
      assumptions: [
        ...(missed ? [`The notice window for the ${formatDate(missed.renewsOn)} renewal closed on ${formatDate(missed.deadline)}. That renewal is locked in; this is the next window.`] : []),
        ...(term.assumedRenewal ? ['Renewal length not stated; assumed equal to the initial term.'] : []),
        ...(notice ? [] : ['No non-renewal notice period was found. Check the renewal clause by hand.']),
        ...(first(f, 'effective_date')?.value.ambiguous ? ['Effective date written as a slash date; read day first.'] : [])
      ],
      citations: [...term.basis, ...(notice ? [notice.id] : [])]
    }));
  } else if (term) {
    items.push(item({
      key: 'expiry',
      kind: 'deadline',
      title: 'Contract expires: renew, replace or wind down',
      due: term.end,
      remindFrom: addDays(term.end, -60),
      consequence: 'Service and protections under this contract stop on this date unless a renewal is signed.',
      severity: 'medium',
      appliesToUs: true,
      assumptions: [],
      citations: term.basis
    }));
  }

  const lock = first(f, 'lock_in');
  const eff = first(f, 'effective_date');
  if (lock && eff) {
    const ends = addDuration(eff.value.date, lock.value.duration);
    if (ends > asOf) {
      items.push(item({
        key: 'lock_in_end',
        kind: 'milestone',
        title: 'Lock-in ends: earliest date an exit can take effect',
        due: ends,
        severity: 'low',
        appliesToUs: true,
        citations: [eff.id, lock.id]
      }));
    }
  }

  for (const t of all(f, 'termination_convenience')) {
    const ours = t.appliesToUs;
    items.push(item({
      key: `termination_convenience:${t.id}`,
      kind: ours === false ? 'risk' : 'right',
      title: ours === false
        ? `${t.subject} can walk away at will${t.value.notice ? ` on ${durationLabel(t.value.notice)} notice` : ''}`
        : `Exit available for convenience${t.value.notice ? ` on ${durationLabel(t.value.notice)} notice` : ''}`,
      due: null,
      severity: ours === false ? 'medium' : 'low',
      appliesToUs: ours,
      citations: [t.id]
    }));
  }

  const pay = first(f, 'payment_terms');
  if (pay) {
    items.push(item({
      key: 'payment_terms',
      kind: 'recurring',
      title: `Pay each invoice within ${durationLabel(pay.value.duration)}`,
      trigger: 'Invoice received',
      window: durationLabel(pay.value.duration),
      due: null,
      severity: first(f, 'late_interest') ? 'medium' : 'low',
      appliesToUs: pay.appliesToUs,
      citations: [pay.id, ...(first(f, 'late_interest') ? [first(f, 'late_interest').id] : [])]
    }));
  }

  if (fees && term && term.start) {
    const step = fees.value.period === 'month' ? 1 : fees.value.period === 'quarter' ? 3 : 12;
    let next = term.start;
    let guard = 0;
    while (next <= asOf && guard++ < 1200) next = addMonths(next, step);
    items.push(item({
      key: 'fee_cycle',
      kind: 'recurring',
      title: `${fees.value.period === 'year' ? 'Annual' : fees.value.period === 'quarter' ? 'Quarterly' : 'Monthly'} fee of ${fees.value.currency || ''} ${fees.value.amount.toLocaleString('en-IN')}`.replace(/\s+/g, ' '),
      due: next,
      severity: 'low',
      appliesToUs: fees.appliesToUs,
      assumptions: ['Billing cycle assumed to start on the current term start date.'],
      citations: [fees.id, ...term.basis.slice(0, 2)]
    }));
  }

  const ins = first(f, 'insurance');
  if (ins) {
    const anniv = term && term.start ? nextAnniversary(term.start, asOf) : null;
    items.push(item({
      key: 'insurance',
      kind: 'recurring',
      title: 'Keep required insurance in force and hold a current certificate',
      due: anniv,
      severity: 'medium',
      appliesToUs: ins.appliesToUs,
      assumptions: anniv ? ['Certificate check scheduled on the contract anniversary.'] : [],
      citations: [ins.id]
    }));
  }

  for (const type of ['breach_notification', 'sla_credit_claim']) {
    for (const x of all(f, type)) {
      items.push(item({
        key: `${type}:${x.id}`,
        kind: 'playbook',
        title: type === 'breach_notification'
          ? `${x.appliesToUs === false ? `${x.subject} must notify you` : 'Notify the other side'} within ${durationLabel(x.value.window)} of a security incident`
          : `Claim service credits within ${durationLabel(x.value.window)} of a missed service level`,
        trigger: x.trigger,
        window: durationLabel(x.value.window),
        due: null,
        severity: type === 'breach_notification' ? 'high' : 'medium',
        appliesToUs: type === 'sla_credit_claim' ? (x.appliesToUs ?? true) : x.appliesToUs,
        citations: [x.id]
      }));
    }
  }

  const exitBased = [
    ['data_return', (v) => `Return or delete the other side's data within ${durationLabel(v.window)} of exit`, (v) => v.window],
    ['confidentiality_survival', (v) => `Confidentiality keeps binding for ${durationLabel(v.duration)} after exit`, (v) => v.duration],
    ['non_solicit', (v) => `No poaching of the other side's staff for ${durationLabel(v.duration)} after exit`, (v) => v.duration]
  ];
  for (const [type, title, d] of exitBased) {
    const x = first(f, type);
    if (!x) continue;
    const endsOn = term && !term.autoRenews && d(x.value) ? addDuration(term.end, d(x.value)) : null;
    items.push(item({
      key: type,
      kind: 'after_exit',
      title: title(x.value),
      trigger: 'Contract ends',
      window: durationLabel(d(x.value)),
      due: endsOn,
      severity: 'low',
      appliesToUs: x.appliesToUs,
      citations: [x.id, ...(endsOn ? term.basis : [])]
    }));
  }

  for (const r of f.filter((x) => x.kind === 'risk' && x.type !== 'auto_renewal')) {
    items.push(item({
      key: `risk:${r.type}`,
      kind: 'risk',
      title: riskTitle(r),
      due: null,
      severity: r.severity,
      appliesToUs: true,
      citations: [r.id]
    }));
  }

  return {
    asOf,
    term: term && { ...term, daysLeft: daysBetween(asOf, term.end) },
    annualValue: fees ? { amount: fees.value.annual, currency: fees.value.currency } : null,
    items: items.map((x, i) => ({ id: `o${i + 1}`, ...x, daysLeft: x.due ? daysBetween(asOf, x.due) : null }))
  };
}

function termYears(d) {
  return d.unit === 'years' ? d.n : d.unit === 'months' ? d.n / 12 : d.unit === 'weeks' ? d.n / 52 : d.n / 365;
}

function nextAnniversary(start, asOf) {
  let d = start;
  let guard = 0;
  while (d <= asOf && guard++ < 200) d = addMonths(d, 12);
  return d;
}

function riskTitle(r) {
  switch (r.type) {
    case 'price_increase':
      if (r.value.fixedPercent != null) return `Fees go up ${r.value.fixedPercent}% on a fixed schedule`;
      return r.value.capPercent == null ? 'The other side can raise prices with no cap' : `Price rises capped at ${r.value.capPercent}%`;
    case 'late_interest':
      return `Late payment interest of ${r.value.rate}% per ${r.value.per} (${r.value.annualised}% a year)`;
    default:
      return r.label;
  }
}
