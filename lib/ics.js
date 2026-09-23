// iCalendar feed of open deadlines, so they land in Google Calendar or Outlook
// next to everything else a person already checks. All-day events, because a
// contractual deadline is a date, not a time.

const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// RFC 5545 wants lines folded at 75 octets.
function fold(line) {
  const out = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = ' ' + rest.slice(cut);
  }
  out.push(rest);
  return out.join('\r\n');
}

const day = (iso) => iso.replace(/-/g, '');
const nextDay = (iso) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
};

export function toIcs(ws, items, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Termwise//Contract deadlines//EN',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${esc(`Contract deadlines: ${ws.name}`)}`
  ];
  for (const it of items) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${it.contract.id}-${it.key.replace(/[^\w-]/g, '_')}@termwise`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${day(it.due)}`,
      `DTEND;VALUE=DATE:${nextDay(it.due)}`,
      `SUMMARY:${esc(`${it.title} (${it.contract.title})`)}`,
      `DESCRIPTION:${esc([it.consequence, it.owner ? `Owner: ${it.owner.name}` : 'No owner assigned'].filter(Boolean).join('\n'))}`,
      ...(it.severity === 'high' ? ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(it.title)}`, 'TRIGGER:-P14D', 'END:VALARM'] : []),
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(it.title)}`, 'TRIGGER:-P3D', 'END:VALARM',
      'END:VEVENT'
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
