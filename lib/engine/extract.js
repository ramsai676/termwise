// Finds contract terms that create deadlines or duties. Every rule is a locator:
// it can only report text that is already in the document, with the absolute
// offsets it was found at. Nothing here writes a clause, invents a number or
// fills a gap from general knowledge, so a finding is always checkable against
// the source by anyone who reads the quoted span.

import { segment, sentenceAround } from './segment.js';
import { DURATION, parseDuration, parseMoney, MONEY_RE } from './quantity.js';
import { DATE, parseDate } from './dates.js';

const COMPANY = /\b(?:ltd|limited|inc|incorporated|llc|llp|pvt|private|gmbh|ag|corp|corporation|company|co\.|plc|s\.a\.|b\.v\.|pte|pty)\b/i;
const ROLE_WORDS = ['Customer', 'Client', 'Provider', 'Supplier', 'Vendor', 'Licensor', 'Licensee', 'Contractor', 'Consultant', 'Company', 'Buyer', 'Seller', 'Service Provider', 'Subscriber', 'Reseller', 'Partner', 'Landlord', 'Tenant', 'Lessor', 'Lessee', 'Distributor', 'Agency', 'Processor', 'Controller'];
const NOT_PARTIES = /^(agreement|effective date|services?|term|fees?|order form|documentation|software|platform|confidential information|data|territory|products?|schedule|sow|statement of work)$/i;

// Pull "Northwind Analytics Pvt Ltd ... ("Provider")" pairs out of the preamble.
export function findParties(text) {
  const head = text.slice(0, 2500);
  const re = /(?:between|and|,)\s+(.{3,120}?)\s*(?:,[^()]{0,160}?)?\(\s*(?:hereinafter\s+(?:referred\s+to\s+as\s+|called\s+)?)?(?:the\s+)?["“']([^"”']{2,40})["”']\s*\)/gi;
  const out = [];
  for (const m of head.matchAll(re)) {
    // "Leave and Licence Agreement is made ... between X" can start the match at
    // the first "and"; the name is whatever follows the last "between".
    const name = m[1].replace(/^.*\bbetween\s+/i, '').replace(/^and\s+/i, '').trim();
    const role = m[2].trim();
    if (NOT_PARTIES.test(role)) continue;
    const known = ROLE_WORDS.some((r) => r.toLowerCase() === role.toLowerCase());
    if (!known && !COMPANY.test(name)) continue;
    if (out.some((p) => p.role.toLowerCase() === role.toLowerCase())) continue;
    const start = m.index + m[0].indexOf(m[1]);
    out.push({ name, role, span: { start, end: m.index + m[0].length } });
  }
  return out;
}

// The party doing the verb nearest before the matched term. "The Contractor
// shall invoice monthly and the Client shall pay within 15 days" puts the
// payment duty on the Client, not on whoever is named first.
function subjectOf(sentence, roles, at = sentence.length) {
  const names = [...new Set([...roles, ...ROLE_WORDS])].sort((a, b) => b.length - a.length).map((r) => r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(String.raw`\b(either\s+party|each\s+party|both\s+parties|the\s+parties|(?:the\s+)?(?:${names.join('|')}))(?:'s)?\s+(?:shall|must|will|may|agrees|undertakes|is\s+(?:required|entitled|obliged)|reserves|has\s+the\s+right)`, 'gi');
  let m = null;
  for (const x of sentence.matchAll(re)) {
    if (x.index <= at || !m) m = x;
    if (x.index > at) break;
  }
  if (!m) return null;
  const who = m[1].replace(/^the\s+/i, '');
  if (/either|each|both|parties/i.test(who)) return 'either';
  const hit = [...roles, ...ROLE_WORDS].find((r) => r.toLowerCase() === who.toLowerCase());
  return hit || who;
}

// Each rule scans clause by clause. `where` optionally restricts to sentences
// that mention a topic, which is what stops "30 days notice" in a termination
// clause from being read as the renewal notice period.
const RULES = [
  {
    type: 'effective_date', kind: 'fact', label: 'Effective date', once: true,
    patterns: [
      new RegExp(String.raw`\beffective\s+(?:as\s+(?:of|from)\s+|from\s+|on\s+)(?:the\s+date\s+of\s+)?(${DATE})`, 'gi'),
      new RegExp(String.raw`\bEffective\s+Date["”]?\)?\s*(?:means|shall\s+mean|is|:)\s*(${DATE})`, 'gi'),
      new RegExp(String.raw`\b(?:dated|made\s+on|entered\s+into\s+on|commenc\w+\s+on)\s+(?:as\s+of\s+)?(?:this\s+)?(${DATE})`, 'gi')
    ],
    value: (m) => { const d = parseDate(m[1]); return d && { date: d.date, ambiguous: d.ambiguous }; }
  },
  {
    type: 'initial_term', kind: 'fact', label: 'Initial term', once: true,
    patterns: [
      new RegExp(String.raw`\b(?:initial\s+term|initial\s+subscription\s+term|term\s+of\s+this\s+agreement|this\s+agreement\s+shall\s+(?:remain\s+in\s+(?:full\s+)?force|continue)|subscription\s+term)[^.;]{0,60}?(?:shall\s+be|is|of|for)\s+(?:a\s+(?:fixed\s+)?period\s+of\s+)?${DURATION}`, 'gi'),
      new RegExp(String.raw`\bfor\s+an?\s+(?:initial\s+|fixed\s+)?(?:term|period)\s+of\s+${DURATION}`, 'gi')
    ],
    value: (m) => { const d = parseDuration(m[1], m[2]); return d && d.unit !== 'hours' && { duration: d }; }
  },
  {
    type: 'end_date', kind: 'fact', label: 'Fixed end date', once: true,
    patterns: [
      new RegExp(String.raw`\b(?:expire[sd]?|terminate[sd]?|end|ending|continue|remain\s+in\s+(?:full\s+)?force)\s+(?:on|until|through)\s+(${DATE})`, 'gi')
    ],
    value: (m) => { const d = parseDate(m[1]); return d && { date: d.date, ambiguous: d.ambiguous }; }
  },
  {
    type: 'auto_renewal', kind: 'risk', label: 'Automatic renewal', once: true, severity: 'high',
    patterns: [
      /\b(?:shall|will)\s+(?:be\s+)?(?:automatically\s+)?renew(?:ed)?\s+(?:automatically\s+)?for\s+(?:successive|additional|further|consecutive)[^.;]*/gi,
      /\b(?:automatically\s+(?:be\s+)?renew\w*|auto-?renew\w*|renew\w*\s+automatically|evergreen)[^.;]*/gi
    ],
    value: (m, s) => {
      const r = new RegExp(String.raw`(?:successive|additional|further|consecutive|renewal)\s+(?:periods?|terms?)\s+of\s+${DURATION}|(?:successive|additional|further|consecutive)\s+${DURATION}\s+(?:periods?|terms?)|for\s+(?:a\s+)?(?:further|additional)\s+(?:period\s+of\s+)?${DURATION}`, 'i');
      const x = s.match(r);
      if (!x) return { renewal: null };
      const [n, u] = x[1] ? [x[1], x[2]] : x[3] ? [x[3], x[4]] : [x[5], x[6]];
      return { renewal: parseDuration(n, u) };
    }
  },
  {
    type: 'renewal_notice', kind: 'fact', label: 'Non-renewal notice period', once: true,
    where: /renew|expir|end\s+of\s+the\s+(?:then[-\s]current|initial|renewal)\s+term/i,
    patterns: [
      new RegExp(String.raw`\bnotice\s+(?:of\s+(?:its\s+intention\s+not\s+to\s+renew\s+|non-?renewal\s+)?)?(?:at\s+least\s+|not\s+less\s+than\s+|no\s+less\s+than\s+|a\s+minimum\s+of\s+)?${DURATION}`, 'gi'),
      new RegExp(String.raw`\b(?:at\s+least\s+|not\s+less\s+than\s+|no\s+less\s+than\s+)?${DURATION}(?:'|’)?\s*(?:prior\s+|advance\s+|written\s+)*(?:written\s+)?notice`, 'gi'),
      new RegExp(String.raw`\b(?:at\s+least\s+|not\s+less\s+than\s+|no\s+less\s+than\s+)${DURATION}\s+(?:prior\s+to|before)\s+(?:the\s+)?(?:end|expiry|expiration)`, 'gi')
    ],
    value: (m) => { const d = parseDuration(m[1], m[2]); return d && d.unit !== 'hours' && { duration: d }; }
  },
  {
    type: 'termination_convenience', kind: 'right', label: 'Termination for convenience',
    where: /convenience|without\s+cause|for\s+any\s+reason|at\s+any\s+time/i,
    patterns: [/\bterminat\w+[^.;]{0,120}?(?:for\s+convenience|without\s+cause|for\s+any\s+reason(?:\s+or\s+no\s+reason)?|at\s+any\s+time)[^.;]*/gi],
    value: (m, s) => {
      // "After the lock-in of 18 months, either party may terminate on 3 months
      // notice": the notice is the duration touching the word notice, not the
      // first duration in the sentence.
      const x = s.match(new RegExp(String.raw`${DURATION}(?:'|’)?\s+(?:prior\s+|advance\s+)?(?:written\s+)?notice|notice\s+(?:period\s+)?of\s+(?:at\s+least\s+)?${DURATION}`, 'i'))
        || s.match(new RegExp(DURATION, 'i'));
      if (!x) return { notice: null };
      return { notice: x[3] ? parseDuration(x[3], x[4]) : parseDuration(x[1], x[2]) };
    }
  },
  {
    type: 'lock_in', kind: 'fact', label: 'Lock-in period', once: true,
    patterns: [
      new RegExp(String.raw`\block-?\s?in\s+(?:period\s+)?(?:of\s+)?${DURATION}`, 'gi'),
      new RegExp(String.raw`\b${DURATION}\s+lock-?\s?in`, 'gi')
    ],
    value: (m) => { const d = parseDuration(m[1], m[2]); return d && d.unit !== 'hours' && { duration: d }; }
  },
  {
    type: 'cure_period', kind: 'fact', label: 'Cure period for breach', once: true,
    patterns: [
      new RegExp(String.raw`\b(?:uncured|not\s+(?:been\s+)?(?:cured|remedied)|fails?\s+to\s+(?:cure|remedy))[^.;]{0,60}?(?:within\s+|after\s+|for\s+)?${DURATION}`, 'gi'),
      new RegExp(String.raw`\b${DURATION}[^.;]{0,50}?(?:to\s+(?:cure|remedy)|cure\s+period)`, 'gi')
    ],
    value: (m) => ({ duration: parseDuration(m[1], m[2]) })
  },
  {
    type: 'payment_terms', kind: 'obligation', label: 'Payment deadline', once: true, payer: true,
    patterns: [
      new RegExp(String.raw`\b(?:payable|paid|due|pay\s+(?:each|all|any)\s+invoices?)\s+within\s+${DURATION}`, 'gi'),
      new RegExp(String.raw`\bwithin\s+${DURATION}\s+(?:of|after|from|following)\s+(?:the\s+)?(?:date\s+of\s+|receipt\s+of\s+)*(?:the\s+|an?\s+|each\s+)?(?:invoice|billing)`, 'gi'),
      /\bnet\s+(\d{1,3})\b()/gi
    ],
    value: (m) => { const d = m[2] ? parseDuration(m[1], m[2]) : { n: Number(m[1]), unit: 'days', business: false }; return d && { duration: d }; }
  },
  {
    type: 'fees', kind: 'fact', label: 'Fees', once: true, payer: true,
    where: /fee|price|charge|pay|subscription|consideration/i,
    patterns: [
      new RegExp(String.raw`(${MONEY_RE})\s*(?:\(\s*[^)]{0,60}\)\s*)?(?:per|a|each|every|\/)\s*(year|annum|month|quarter|annual\s+period)`, 'gi'),
      new RegExp(String.raw`\b(annual|monthly|quarterly|yearly)\s+(?:subscription\s+|licen[cs]e\s+|service\s+)?(?:fee|fees|charge|price)s?\s+(?:of|is|shall\s+be|will\s+be|:)\s*(${MONEY_RE})`, 'gi')
    ],
    value: (m) => {
      const [moneyText, per] = /\d/.test(m[1]) ? [m[1], m[2]] : [m[2], m[1]];
      const money = parseMoney(moneyText);
      if (!money) return null;
      const p = per.toLowerCase();
      const mult = /month/.test(p) ? 12 : /quarter/.test(p) ? 4 : 1;
      return { ...money, period: /month/.test(p) ? 'month' : /quarter/.test(p) ? 'quarter' : 'year', annual: money.amount * mult };
    }
  },
  {
    type: 'late_interest', kind: 'risk', label: 'Late payment interest', once: true,
    patterns: [/\binterest[^.;]{0,80}?(\d+(?:\.\d+)?)\s*%\s*(?:per\s+|a\s+|each\s+)?(month|annum|year|monthly|annually)?/gi],
    value: (m) => {
      const rate = Number(m[1]);
      const monthly = /month/i.test(m[2] || '');
      return { rate, per: monthly ? 'month' : 'year', annualised: monthly ? rate * 12 : rate };
    },
    severity: (v) => (v.annualised >= 18 ? 'high' : 'medium')
  },
  {
    type: 'price_increase', kind: 'risk', label: 'Price increase right', once: true,
    patterns: [
      /\b(?:increase|adjust|revise|change|raise)\w*\s+(?:the\s+|its\s+|any\s+)?(?:fees|prices|pricing|charges|rates|rent|subscription\s+fees?)[^.;]*/gi,
      /\b(?:fees?|charges|prices?|rent|rates|licen[cs]e\s+fee)\s+(?:shall|will)\s+(?:be\s+)?(?:increase|escalat|revis)\w*[^.;]*/gi
    ],
    value: (m, s) => {
      const cap = s.match(/(?:not\s+(?:to\s+)?exceed|no\s+more\s+than|up\s+to|capped\s+at|maximum\s+of)\s+(\d+(?:\.\d+)?)\s*%/i);
      // "shall increase by 5% every twelve months" is a fixed escalation, not a
      // right to raise prices: certain, but bounded.
      const fixed = !cap && s.match(/\b(?:increase|escalat)\w*\s+(?:by|at)\s+(\d+(?:\.\d+)?)\s*%/i);
      return {
        capPercent: cap ? Number(cap[1]) : null,
        fixedPercent: fixed ? Number(fixed[1]) : null,
        discretionary: /sole\s+discretion|unilateral|at\s+any\s+time/i.test(s)
      };
    },
    severity: (v) => {
      const pct = v.capPercent ?? v.fixedPercent;
      return pct == null ? 'high' : pct > 7 ? 'medium' : 'low';
    }
  },
  {
    type: 'liability_cap', kind: 'fact', label: 'Liability cap', once: true,
    patterns: [/\b(?:aggregate\s+|total\s+|maximum\s+|cumulative\s+)?liabilit\w+[^.;]{0,220}?(?:shall\s+not\s+(?:in\s+aggregate\s+)?exceed|(?:is|be|are)\s+limited\s+to|(?:is|be)\s+capped\s+at|not\s+exceed)[^.;]*/gi],
    value: (m, s) => {
      const money = s.match(new RegExp(MONEY_RE, 'i'));
      const months = s.match(new RegExp(String.raw`(?:preceding|previous|prior|last)\s+${DURATION}|${DURATION}\s+(?:preceding|prior|before)`, 'i'));
      const x = money ? parseMoney(money[0]) : null;
      return {
        amount: x ? x.amount : null, currency: x ? x.currency : null,
        feesLookback: months ? parseDuration(months[1] || months[3], months[2] || months[4]) : null,
        multiple: (s.match(/\b(one|two|three|1|2|3)\s*(?:\(\d\)\s*)?times\b/i) || [])[1] || null
      };
    }
  },
  {
    type: 'breach_notification', kind: 'obligation', label: 'Security incident notification', trigger: 'Security incident or personal data breach',
    where: /breach|incident|unauthori[sz]ed/i,
    patterns: [
      new RegExp(String.raw`\b(?:notify|inform|notice\s+to|report)[^.;]{0,160}?(?:security\s+incident|data\s+breach|personal\s+data\s+breach|breach\s+of\s+security|unauthori[sz]ed\s+(?:access|disclosure))[^.;]{0,120}?(?:within|no\s+later\s+than|not\s+later\s+than)\s+${DURATION}`, 'gi'),
      new RegExp(String.raw`\b(?:security\s+incident|data\s+breach|personal\s+data\s+breach|breach\s+of\s+security|unauthori[sz]ed\s+(?:access|disclosure))[^.;]{0,160}?(?:within|no\s+later\s+than|not\s+later\s+than)\s+${DURATION}`, 'gi')
    ],
    value: (m) => ({ window: parseDuration(m[1], m[2]) }),
    severity: () => 'high'
  },
  {
    type: 'sla_credit_claim', kind: 'right', label: 'Service credit claim window', trigger: 'Service level missed',
    where: /credit/i,
    patterns: [new RegExp(String.raw`\b(?:request|claim|apply\s+for)\w*[^.;]{0,120}?within\s+${DURATION}|\bcredits?[^.;]{0,120}?(?:request|claim)\w*[^.;]{0,60}?within\s+${DURATION}`, 'gi')],
    value: (m) => ({ window: parseDuration(m[1] || m[3], m[2] || m[4]) })
  },
  {
    type: 'insurance', kind: 'obligation', label: 'Maintain insurance', once: true,
    patterns: [/\b(?:maintain|carry|procure|obtain|keep\s+in\s+(?:full\s+)?force)[^.;]{0,100}?insurance[^.;]*/gi],
    value: (m, s) => { const x = s.match(new RegExp(MONEY_RE, 'i')); return { cover: x ? parseMoney(x[0]) : null }; }
  },
  {
    type: 'audit_rights', kind: 'fact', label: 'Audit rights', once: true,
    patterns: [/\b(?:audit|inspect)\w*[^.;]{0,120}?(?:records|books|accounts|premises|systems|facilities|compliance)[^.;]*/gi],
    value: (m, s) => { const x = s.match(new RegExp(DURATION, 'i')); return { notice: x ? parseDuration(x[1], x[2]) : null }; }
  },
  {
    type: 'data_return', kind: 'obligation', label: 'Return or delete data after exit', once: true,
    patterns: [new RegExp(String.raw`\b(?:return|delete|destroy|erase)[^.;]{0,140}?(?:data|confidential\s+information|materials)[^.;]{0,140}?within\s+${DURATION}`, 'gi')],
    value: (m) => ({ window: parseDuration(m[1], m[2]) })
  },
  {
    type: 'confidentiality_survival', kind: 'obligation', label: 'Confidentiality continues after exit', once: true,
    where: /confidential/i,
    patterns: [new RegExp(String.raw`\b(?:surviv\w+|continue\s+(?:to\s+apply|in\s+(?:full\s+)?force))[^.;]{0,100}?(?:for\s+(?:a\s+period\s+of\s+)?)?${DURATION}`, 'gi')],
    value: (m) => ({ duration: parseDuration(m[1], m[2]) })
  },
  {
    type: 'non_solicit', kind: 'obligation', label: 'Non-solicitation', once: true,
    where: /solicit|hire|employ|engage/i,
    patterns: [new RegExp(String.raw`\b(?:solicit|hire|employ|engage)\w*[^.;]{0,200}?(?:during|for)[^.;]{0,80}?${DURATION}\s+(?:after|following|from|thereafter)`, 'gi')],
    value: (m) => ({ duration: parseDuration(m[1], m[2]) })
  },
  {
    type: 'governing_law', kind: 'fact', label: 'Governing law', once: true,
    patterns: [/\bgoverned\s+by[^.;]{0,40}?laws?\s+of\s+(?:the\s+)?((?:State\s+of\s+|Republic\s+of\s+)?[A-Z][A-Za-z]+(?:[ ,]+(?:and\s+)?[A-Z][A-Za-z]+){0,4})/g],
    value: (m) => ({ law: m[1].replace(/,\s*$/, '') })
  }
];

export function extract(raw, opts = {}) {
  const { text, clauses } = segment(raw);
  const parties = findParties(text);
  const roles = parties.map((p) => p.role);
  const perspective = opts.perspective || null;
  const findings = [];
  const seen = new Set();

  for (const rule of RULES) {
    let found = 0;
    for (const clause of clauses) {
      if (rule.once && found) break;
      for (const re of rule.patterns) {
        re.lastIndex = 0;
        for (const m of clause.text.matchAll(re)) {
          const abs = clause.start + m.index;
          const span = sentenceAround(text, abs, abs + m[0].length, clause);
          const sentence = text.slice(span.start, span.end);
          if (rule.where && !rule.where.test(sentence)) continue;
          // Rules see the whole sentence as well as the match, because a match
          // stops at the first full stop and "Rs. 50,00,000" has one in it.
          const value = rule.value(m, sentence);
          if (!value) continue;
          const key = `${rule.type}:${span.start}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const subject = subjectOf(sentence, roles, abs - span.start);
          findings.push({
            id: `f${findings.length + 1}`,
            type: rule.type,
            kind: rule.kind,
            label: rule.label,
            severity: typeof rule.severity === 'function' ? rule.severity(value) : rule.severity || (rule.kind === 'risk' ? 'medium' : 'low'),
            trigger: rule.trigger || null,
            clause: { id: clause.id, number: clause.number, label: clause.label },
            span,
            match: { start: abs, end: abs + m[0].length },
            quote: sentence.replace(/\s+/g, ' ').trim(),
            subject,
            payerRule: !!rule.payer,
            value
          });
          found++;
          if (rule.once) break;
        }
        if (rule.once && found) break;
      }
    }
  }

  return { text, clauses, parties, perspective, findings: applyPerspective(findings, perspective, roles) };
}

// Whether a finding binds "us" depends on which side of the contract the
// workspace is on. A subject we could not identify stays null: the UI asks a
// person rather than assuming.
export function applyPerspective(findings, perspective, roles = []) {
  const payer = findings.find((f) => f.type === 'fees' && f.subject && f.subject !== 'either')?.subject
    || roles.find((r) => /customer|client|buyer|licensee|subscriber|tenant|lessee/i.test(r)) || null;
  return findings.map((f) => {
    let subject = f.subject;
    if (!subject && f.payerRule) subject = payer;
    let appliesToUs = null;
    if (perspective && subject) appliesToUs = subject === 'either' || subject.toLowerCase() === perspective.toLowerCase();
    return { ...f, subject, appliesToUs };
  });
}

export const RULE_TYPES = RULES.map((r) => ({ type: r.type, label: r.label, kind: r.kind }));
