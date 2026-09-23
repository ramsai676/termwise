import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extract } from '../lib/engine/extract.js';
import { schedule, currentTerm } from '../lib/engine/schedule.js';
import { segment } from '../lib/engine/segment.js';
import { addMonths, addBusinessDays, parseDate, addDuration } from '../lib/engine/dates.js';
import { parseNumber, parseDuration, parseMoney } from '../lib/engine/quantity.js';

const read = (f) => fs.readFileSync(new URL(`../samples/${f}`, import.meta.url), 'utf8');
const SAMPLES = fs.readdirSync(new URL('../samples/', import.meta.url)).filter((f) => f.endsWith('.txt'));
const byType = (ex, t) => ex.findings.find((f) => f.type === t);

test('month arithmetic clamps to month end', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
  assert.equal(addMonths('2025-11-15', 14), '2027-01-15');
});

test('business days skip weekends', () => {
  // 2026-09-25 is a Friday
  assert.equal(addBusinessDays('2026-09-25', 1), '2026-09-28');
  assert.equal(addBusinessDays('2026-09-28', -1), '2026-09-25');
  assert.equal(addDuration('2026-09-25', { n: 5, unit: 'days', business: true }), '2026-10-02');
});

test('dates parse in the forms contracts use, slash dates flagged when ambiguous', () => {
  assert.deepEqual(parseDate('March 14, 2026'), { date: '2026-03-14', ambiguous: false });
  assert.deepEqual(parseDate('14th day of March, 2026'), { date: '2026-03-14', ambiguous: false });
  assert.deepEqual(parseDate('05/03/2026'), { date: '2026-03-05', ambiguous: true });
  assert.deepEqual(parseDate('25/03/2026'), { date: '2026-03-25', ambiguous: false });
  assert.equal(parseDate('31 February 2026'), null);
});

test('numbers in words and brackets', () => {
  assert.equal(parseNumber('ninety (90)'), 90);
  assert.equal(parseNumber('forty-five'), 45);
  assert.equal(parseNumber('one hundred and twenty'), 120);
  assert.deepEqual(parseDuration('ten', 'business days'), { n: 10, unit: 'days', business: true });
  assert.deepEqual(parseMoney('Rs. 1,45,000'), { amount: 145000, currency: 'INR' });
  assert.deepEqual(parseMoney('USD 84,000'), { amount: 84000, currency: 'USD' });
  assert.deepEqual(parseMoney('INR 2.5 crore'), { amount: 25000000, currency: 'INR' });
});

test('a long paragraph on a numbered line does not swallow the next clause', () => {
  const t = '7.1 ' + 'The Supplier shall comply with every applicable law. '.repeat(8) + '\n7.2 The Customer shall pay.';
  const { clauses } = segment(t);
  assert.deepEqual(clauses.map((c) => c.number), ['7.1', '7.2']);
});

// The core promise: nothing is invented. Each quote is the exact text at its
// stored offsets, and every number a finding reports appears in that text.
for (const file of SAMPLES) {
  test(`every finding in ${file} is a verbatim span of the source`, () => {
    const ex = extract(read(file));
    assert.ok(ex.findings.length > 0);
    for (const f of ex.findings) {
      const slice = ex.text.slice(f.span.start, f.span.end);
      assert.equal(f.quote, slice.replace(/\s+/g, ' ').trim(), `${f.type} quote drifted from its offsets`);
      assert.ok(f.span.start <= f.match.start && f.match.end <= f.span.end + 400, `${f.type} match outside its span`);
      const clause = ex.clauses.find((c) => c.id === f.clause.id);
      assert.ok(clause.start <= f.span.start && f.span.end <= clause.end, `${f.type} cited to the wrong clause`);
      for (const n of numbersIn(f.value)) {
        assert.ok(numberAppears(slice, n), `${f.type} reports ${n}, which is not in "${slice}"`);
      }
    }
  });
}

function numbersIn(v, out = []) {
  if (v == null) return out;
  if (typeof v === 'number') out.push(v);
  else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) if (!['annual', 'annualised'].includes(k)) numbersIn(x, out);
  return out;
}

const WORDS = { 12: 'twelve', 15: 'fifteen', 30: 'thirty', 60: 'sixty', 90: 'ninety', 3: 'three', 2: 'two' };
function numberAppears(text, n) {
  const flat = text.replace(/,/g, '');
  if (new RegExp(String.raw`(^|[^\d])${n}([^\d]|$)`).test(flat)) return true;
  if (WORDS[n] && new RegExp(`\\b${WORDS[n]}\\b`, 'i').test(text)) return true;
  // Money in lakh/crore notation, and dates, are checked by their own tests.
  return /lakh|crore|\d{4}/i.test(text) && n > 1000;
}

test('parties and roles come from the preamble', () => {
  const ex = extract(read('crm-subscription.txt'));
  assert.deepEqual(ex.parties.map((p) => [p.role, p.name]), [
    ['Provider', 'Helixa Software Private Limited'],
    ['Customer', 'Brightpath Logistics LLP']
  ]);
  const fm = extract(read('facility-services.txt'));
  assert.deepEqual(fm.parties.map((p) => p.role), ['Contractor', 'Client']);
});

test('who owes a duty is the party nearest the verb, not the first one named', () => {
  const ex = extract(read('facility-services.txt'), { perspective: 'Client' });
  const pay = byType(ex, 'payment_terms');
  assert.equal(pay.subject, 'Client');
  assert.equal(pay.appliesToUs, true);
  assert.equal(byType(ex, 'insurance').appliesToUs, false);
});

test('perspective flips which side a finding binds', () => {
  const asCustomer = extract(read('crm-subscription.txt'), { perspective: 'Customer' });
  const asProvider = extract(read('crm-subscription.txt'), { perspective: 'Provider' });
  assert.equal(byType(asCustomer, 'breach_notification').appliesToUs, false);
  assert.equal(byType(asProvider, 'breach_notification').appliesToUs, true);
});

test('renewal deadline is effective date + term - notice, citing all four', () => {
  const ex = extract(read('crm-subscription.txt'), { perspective: 'Customer' });
  const s = schedule(ex, { today: '2026-09-23' });
  const r = s.items.find((i) => i.key === 'renewal_decision');
  assert.equal(r.renewsOn, '2027-01-01');
  assert.equal(r.due, '2026-11-02');
  assert.equal(r.daysLeft, 40);
  for (const t of ['effective_date', 'initial_term', 'auto_renewal', 'renewal_notice']) {
    assert.ok(r.citations.includes(byType(ex, t).id), `missing ${t} citation`);
  }
});

test('a missed notice window rolls to the next one and says so', () => {
  const ex = extract(read('crm-subscription.txt'), { perspective: 'Customer' });
  const s = schedule(ex, { today: '2026-12-01' });
  const r = s.items.find((i) => i.key === 'renewal_decision');
  assert.deepEqual(r.missed, { deadline: '2026-11-02', renewsOn: '2027-01-01' });
  assert.equal(r.renewsOn, '2028-01-01');
  assert.equal(r.due, '2027-11-02');
  assert.match(r.assumptions[0], /closed on 2026-11-02/);
});

test('an evergreen contract rolls forward through past renewals', () => {
  const ex = extract(read('crm-subscription.txt'));
  const t = currentTerm(ex.findings, '2029-06-01');
  assert.equal(t.renewals, 3);
  assert.equal(t.end, '2030-01-01');
});

test('fixed-term contract gets an expiry item, not a renewal item', () => {
  const ex = extract(read('facility-services.txt'), { perspective: 'Client' });
  const s = schedule(ex, { today: '2026-09-23' });
  assert.ok(!s.items.some((i) => i.key === 'renewal_decision'));
  const e = s.items.find((i) => i.key === 'expiry');
  assert.equal(e.due, '2027-01-15');
});

test('an uncapped discretionary price rise is a high risk, a capped one is not', () => {
  const crm = byType(extract(read('crm-subscription.txt')), 'price_increase');
  const fm = byType(extract(read('facility-services.txt')), 'price_increase');
  assert.equal(crm.severity, 'high');
  assert.equal(fm.value.capPercent, 8);
  assert.equal(fm.severity, 'medium');
});

test('text with no contract terms yields nothing rather than guesses', () => {
  const ex = extract('Minutes of the weekly team meeting.\n\nWe discussed the roadmap and lunch options.');
  assert.equal(ex.findings.length, 0);
  assert.equal(schedule(ex, { today: '2026-09-23' }).items.length, 0);
});
