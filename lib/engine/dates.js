// All dates are plain calendar days as "YYYY-MM-DD" strings. Contracts do not
// care about time zones and neither should a deadline, so nothing here touches
// local time: arithmetic runs on UTC midnight and converts straight back.

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MON = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;

// "March 14, 2026" | "14 March 2026" | "14th day of March, 2026" | "2026-03-14" | "14/03/2026"
export const DATE = String.raw`(?:${MON}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\d{1,2}(?:st|nd|rd|th)?\s+(?:day\s+of\s+)?${MON}\.?,?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}[\/.]\d{1,2}[\/.]\d{4})`;

function monthIndex(name) {
  const n = name.toLowerCase().replace(/\./, '');
  return MONTHS.findIndex((m) => m.startsWith(n.slice(0, 3)));
}

const iso = (y, m, d) => `${String(y).padStart(4, '0')}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

function valid(y, m, d) {
  const t = new Date(Date.UTC(y, m, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m && t.getUTCDate() === d;
}

// Returns { date, ambiguous }. Slash dates are read day-first, the Indian and
// European convention, and flagged ambiguous when both readings are valid so a
// person confirms it instead of the tool guessing silently.
export function parseDate(s) {
  const str = String(s).trim();
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return valid(+m[1], +m[2] - 1, +m[3]) ? { date: iso(+m[1], +m[2] - 1, +m[3]), ambiguous: false } : null;
  m = str.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/);
  if (m) {
    const a = +m[1], b = +m[2], y = +m[3];
    if (!valid(y, b - 1, a)) return valid(y, a - 1, b) ? { date: iso(y, a - 1, b), ambiguous: false } : null;
    return { date: iso(y, b - 1, a), ambiguous: a <= 12 && a !== b };
  }
  m = str.match(/^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i);
  if (m) {
    const mi = monthIndex(m[1]);
    return mi >= 0 && valid(+m[3], mi, +m[2]) ? { date: iso(+m[3], mi, +m[2]), ambiguous: false } : null;
  }
  m = str.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+(?:day\s+of\s+)?([a-z]+)\.?,?\s+(\d{4})$/i);
  if (m) {
    const mi = monthIndex(m[2]);
    return mi >= 0 && valid(+m[3], mi, +m[1]) ? { date: iso(+m[3], mi, +m[1]), ambiguous: false } : null;
  }
  return null;
}

function parts(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return [y, m - 1, d];
}

export function addDays(isoDate, n) {
  const [y, m, d] = parts(isoDate);
  const t = new Date(Date.UTC(y, m, d + n));
  return iso(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
}

// Month arithmetic clamps to the end of the month: 31 Jan + 1 month is 28/29 Feb,
// which is how courts and billing systems both read it.
export function addMonths(isoDate, n) {
  const [y, m, d] = parts(isoDate);
  const target = new Date(Date.UTC(y, m + n, 1));
  const ty = target.getUTCFullYear(), tm = target.getUTCMonth();
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return iso(ty, tm, Math.min(d, last));
}

export function addBusinessDays(isoDate, n) {
  let cur = isoDate;
  const step = n < 0 ? -1 : 1;
  let left = Math.abs(n);
  while (left > 0) {
    cur = addDays(cur, step);
    const [y, m, d] = parts(cur);
    const dow = new Date(Date.UTC(y, m, d)).getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return cur;
}

export function addDuration(isoDate, dur, sign = 1) {
  if (!dur) return null;
  const n = dur.n * sign;
  switch (dur.unit) {
    case 'days': return dur.business ? addBusinessDays(isoDate, n) : addDays(isoDate, n);
    case 'weeks': return addDays(isoDate, n * 7);
    case 'months': return addMonths(isoDate, n);
    case 'years': return addMonths(isoDate, n * 12);
    default: return null;
  }
}

export function daysBetween(a, b) {
  const [y1, m1, d1] = parts(a), [y2, m2, d2] = parts(b);
  return Math.round((Date.UTC(y2, m2, d2) - Date.UTC(y1, m1, d1)) / 86400000);
}

export function today(now = new Date()) {
  return iso(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

export function formatDate(isoDate) {
  if (!isoDate) return '';
  const [y, m, d] = parts(isoDate);
  return `${d} ${MONTHS[m].slice(0, 1).toUpperCase()}${MONTHS[m].slice(1, 3)} ${y}`;
}
