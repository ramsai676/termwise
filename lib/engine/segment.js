// Splits a contract into clauses so every extracted term can be cited by clause
// number and by exact character offsets into the stored text. Offsets are into
// the normalised text (CRLF folded to LF), which is also what gets hashed and
// stored, so a citation always points into the same bytes it was taken from.

const NUMBERED = /^(\s*)((?:\d{1,3})(?:\.\d{1,3}){0,4})\.?\s+(\S.*)$/;
const LABELLED = /^(\s*)(?:section|clause|article)\s+([\dIVXLC]+(?:\.\d+)*)\.?[\s:.-]*(.*)$/i;
const CAPS = /^[A-Z][A-Z0-9 &,'()\/-]{3,}$/;
const NBSP = new RegExp(String.fromCharCode(0xa0), 'g');

export function normalise(text) {
  return String(text || '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').replace(NBSP, ' ');
}

function heading(line) {
  const t = line.trim();
  if (!t) return null;
  let m = line.match(NUMBERED);
  if (m) {
    // "2024 was a good year" is not clause 2024. Clause numbers above 200 with
    // no dot are almost always years or amounts starting a wrapped line.
    if (!m[2].includes('.') && Number(m[2]) > 200) return null;
    return { number: m[2], title: titleOf(m[3]) };
  }
  m = line.match(LABELLED);
  if (m && t.length < 160) return { number: m[2], title: titleOf(m[3]) };
  if (CAPS.test(t) && t.split(/\s+/).length <= 8 && t.length <= 70) return { number: null, title: t };
  return null;
}

// Drafting often puts the whole paragraph on the numbered line, so the title is
// only the heading if it reads like one, otherwise the first few words.
function titleOf(rest) {
  const r = rest.trim();
  if (!r) return '';
  if (r.length <= 60 && !/[.;:]$/.test(r)) return r;
  const lead = r.match(/^([A-Z][A-Za-z ]{2,40})\.\s/);
  if (lead) return lead[1];
  const words = r.split(/\s+/).slice(0, 8).join(' ');
  return words.length < r.length ? words.replace(/[,;:.]$/, '') + '...' : words;
}

export function segment(raw) {
  const text = normalise(raw);
  const clauses = [];
  let cur = null;
  let offset = 0;

  const close = (endOffset) => {
    if (!cur) return;
    cur.text = text.slice(cur.start, endOffset).replace(/\s+$/, '');
    cur.end = cur.start + cur.text.length;
    if (cur.text.trim()) clauses.push(cur);
    cur = null;
  };

  for (const line of text.split('\n')) {
    const h = heading(line);
    if (h) {
      close(offset);
      cur = { number: h.number, title: h.title, start: offset };
    } else if (!cur && line.trim()) {
      cur = { number: null, title: 'Preamble', start: offset };
    }
    offset += line.length + 1;
  }
  close(text.length);

  return {
    text,
    clauses: clauses.map((c, i) => ({
      id: `c${i + 1}`,
      index: i,
      number: c.number,
      title: c.title,
      label: c.number ? `${c.number}${c.title ? ' ' + c.title : ''}` : c.title,
      start: c.start,
      end: c.end,
      text: c.text
    }))
  };
}

export function clauseAt(clauses, offset) {
  let lo = 0, hi = clauses.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = clauses[mid];
    if (offset < c.start) hi = mid - 1;
    else if (offset >= c.end) lo = mid + 1;
    else return c;
  }
  return null;
}

// Abbreviations that end in a full stop but do not end a sentence.
const ABBREV = /\b(?:rs|no|pvt|ltd|inc|co|corp|vs|viz|approx|e\.g|i\.e|etc|cl|sec|art|para)$/i;

function isStop(text, i) {
  const ch = text[i];
  if (ch === '\n') return true;
  if (ch !== '.' && ch !== ';') return false;
  const next = text[i + 1];
  if (next !== undefined && !/\s/.test(next)) return false;
  return !(ch === '.' && ABBREV.test(text.slice(Math.max(0, i - 8), i)));
}

// The sentence around a match, as absolute offsets. Used both as the quote shown
// to the user and as the span highlighted in the source view.
export function sentenceAround(text, from, to, clause) {
  const lo = clause ? clause.start : 0;
  const hi = clause ? clause.end : text.length;
  let s = from;
  while (s > lo && !isStop(text, s - 1)) s--;
  let e = to;
  while (e < hi && !isStop(text, e)) e++;
  if (e < hi && text[e] !== '\n') e++;
  while (s < e && /\s/.test(text[s])) s++;
  // A quote reads better without the clause number it starts with; the number
  // is shown separately as the citation.
  const lead = text.slice(s, from).match(/^(?:\d{1,3}(?:\.\d{1,3})*\.?|\([a-z]{1,4}\))\s+/i);
  if (lead) s += lead[0].length;
  // Keep quotes short enough to read; long sentences are windowed on the match.
  if (e - s > 360) {
    s = Math.max(s, from - 140);
    e = Math.min(e, to + 180);
  }
  return { start: s, end: e };
}
