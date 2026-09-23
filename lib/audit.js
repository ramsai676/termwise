// Append-only, hash-chained audit log, one chain per workspace.
//
// Each event stores the hash of the one before it, and its own hash covers its
// content plus that link. Changing, deleting or reordering any past event breaks
// every hash after it, which `verify` reports with the first sequence number
// that no longer checks out.
//
// Appends are race-safe without a database: event N is written with a
// create-only condition, so two requests that both try to write N cannot both
// win. The loser re-reads and takes N+1. The head pointer is only a hint to
// skip the probe; the events themselves are the truth.
//
// Events never hold contract text, only its SHA-256. Deleting a contract to
// honour an erasure request removes the text but leaves the chain intact.

import crypto from 'node:crypto';

export const GENESIS = '0'.repeat(64);
const pad = (n) => String(n).padStart(9, '0');
const eventKey = (ws, seq) => `ws/${ws}/audit/${pad(seq)}`;
const headKey = (ws) => `ws/${ws}/audit-head`;

// Stable key order so the same event always hashes the same, whatever order
// the fields were assembled in.
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

export function hashEvent(prev, body) {
  return crypto.createHash('sha256').update(prev).update('\n').update(canonical(body)).digest('hex');
}

export async function append(store, ws, { actor, action, target = null, detail = {} }, now = new Date()) {
  const hint = await store.get(headKey(ws));
  let seq = hint ? hint.value.seq : 0;
  let prev = hint ? hint.value.hash : GENESIS;

  for (let attempt = 0; attempt < 20; attempt++) {
    // Walk forward past anything written after the hint was last updated.
    for (;;) {
      const next = await store.get(eventKey(ws, seq + 1));
      if (!next) break;
      seq = next.value.seq;
      prev = next.value.hash;
    }
    const body = {
      seq: seq + 1,
      at: now.toISOString(),
      actor: actor ? { id: actor.id, email: actor.email } : { id: 'system', email: null },
      action,
      target,
      detail
    };
    const event = { ...body, prev, hash: hashEvent(prev, body) };
    const w = await store.put(eventKey(ws, event.seq), event, { ifNew: true });
    if (w.ok) {
      // Best effort. A stale head only costs the next writer one extra read.
      const h = await store.get(headKey(ws));
      if (!h || h.value.seq < event.seq) {
        await store.put(headKey(ws), { seq: event.seq, hash: event.hash }, h ? { ifMatch: h.etag } : { ifNew: true });
      }
      return event;
    }
  }
  throw Object.assign(new Error('Audit log is busy, try again'), { status: 503 });
}

export async function list(store, ws, { after = 0, limit = 200 } = {}) {
  const keys = await store.list(`ws/${ws}/audit/`);
  const wanted = keys.filter((k) => Number(k.split('/').pop()) > after).slice(0, limit);
  const out = [];
  for (const k of wanted) {
    const e = await store.get(k);
    if (e) out.push(e.value);
  }
  return out;
}

export async function verify(store, ws) {
  const keys = await store.list(`ws/${ws}/audit/`);
  let prev = GENESIS;
  let expected = 1;
  for (const k of keys) {
    const got = await store.get(k);
    if (!got) continue;
    const e = got.value;
    const { hash, prev: link, ...body } = e;
    const problem =
      e.seq !== expected ? `event ${expected} is missing` :
      Number(k.split('/').pop()) !== e.seq ? `event ${e.seq} is stored under the wrong position` :
      link !== prev ? `event ${e.seq} does not link to event ${e.seq - 1}` :
      hashEvent(prev, body) !== hash ? `event ${e.seq} was altered after it was written` : null;
    if (problem) return { ok: false, count: expected - 1, brokenAt: expected, problem, head: prev };
    prev = hash;
    expected++;
  }
  return { ok: true, count: expected - 1, head: prev };
}
