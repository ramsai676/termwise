// Contracts write durations as "ninety (90) days", "90 days", "three months" or
// "one (1) year". The digit in brackets wins when present because it is the
// figure lawyers check; the word is only used when there is no digit at all.

const WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100
};

const WORD = Object.keys(WORDS).join('|');
// "forty-five", "one hundred and twenty", "ninety (90)", "90", "thirty-six (36)"
const NUMBER = String.raw`(?:(?:${WORD})(?:[\s-]+(?:and\s+)?(?:${WORD}))*\s*\(\s*\d{1,4}\s*\)|\d{1,4}|(?:${WORD})(?:[\s-]+(?:and\s+)?(?:${WORD}))*)`;
const UNIT = String.raw`(?:calendar\s+|business\s+|working\s+)?(?:hours?|days?|weeks?|months?|years?)`;

export const DURATION = String.raw`(${NUMBER})\s*[-\s]?\s*(${UNIT})`;

export function parseNumber(s) {
  if (s == null) return null;
  const str = String(s).toLowerCase();
  const digits = str.match(/\d{1,4}/);
  if (digits) return Number(digits[0]);
  let total = 0, current = 0, seen = false;
  for (const w of str.split(/[\s-]+/)) {
    if (w === 'and' || !w) continue;
    const v = WORDS[w];
    if (v == null) return seen ? total + current : null;
    seen = true;
    if (v === 100) current = (current || 1) * 100;
    else current += v;
  }
  total += current;
  return seen ? total : null;
}

export function parseDuration(numberText, unitText) {
  const n = parseNumber(numberText);
  if (n == null) return null;
  const u = unitText.toLowerCase();
  const business = /business|working/.test(u);
  const unit = /hour/.test(u) ? 'hours' : /day/.test(u) ? 'days' : /week/.test(u) ? 'weeks' : /month/.test(u) ? 'months' : 'years';
  return { n, unit, business };
}

export function durationLabel(d) {
  if (!d) return '';
  const unit = d.n === 1 ? d.unit.replace(/s$/, '') : d.unit;
  return `${d.n} ${d.business ? 'business ' : ''}${unit}`;
}

// Approximate length in days, used only for sorting and sanity checks, never for
// computing a deadline. Deadlines use calendar arithmetic in dates.js.
export function approxDays(d) {
  if (!d) return null;
  const base = { hours: 1 / 24, days: 1, weeks: 7, months: 30.44, years: 365.25 }[d.unit];
  return d.n * base * (d.business ? 7 / 5 : 1);
}

const MONEY = String.raw`(?:(?:USD|EUR|GBP|INR|AUD|CAD|SGD|Rs\.?|₹|\$|£|€)\s?\d[\d,]*(?:\.\d{1,2})?(?:\s?(?:lakh|crore|million|thousand|k))?|\d[\d,]*(?:\.\d{1,2})?\s?(?:USD|EUR|GBP|INR|dollars|rupees))`;
export const MONEY_RE = MONEY;

export function parseMoney(s) {
  const str = String(s);
  const cur = /USD|\$|dollar/i.test(str) ? 'USD' : /EUR|€/.test(str) ? 'EUR' : /GBP|£/.test(str) ? 'GBP'
    : /INR|Rs|₹|rupee/i.test(str) ? 'INR' : /AUD/.test(str) ? 'AUD' : /CAD/.test(str) ? 'CAD' : /SGD/.test(str) ? 'SGD' : null;
  const num = str.match(/\d[\d,]*(?:\.\d{1,2})?/);
  if (!num) return null;
  let amount = Number(num[0].replace(/,/g, ''));
  if (/crore/i.test(str)) amount *= 1e7;
  else if (/lakh/i.test(str)) amount *= 1e5;
  else if (/million/i.test(str)) amount *= 1e6;
  else if (/thousand|\dk\b/i.test(str)) amount *= 1e3;
  return { amount, currency: cur };
}
