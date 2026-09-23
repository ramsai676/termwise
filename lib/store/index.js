// One small key-value interface with conditional writes, so the same service
// code runs against Netlify Blobs in production, a folder on disk in local
// development, and memory in tests.
//
//   get(key)                      -> { value, etag } | null
//   put(key, value, { ifMatch, ifNew }) -> { ok, etag }
//   del(key)
//   list(prefix)                  -> [key]
//
// Conditional writes are the only concurrency primitive. The audit chain and
// the contract index both depend on them: a write that lost a race comes back
// ok:false and the caller re-reads and retries.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const etagOf = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

export class MemoryStore {
  constructor() { this.m = new Map(); }
  async get(key) {
    const s = this.m.get(key);
    return s == null ? null : { value: JSON.parse(s), etag: etagOf(s) };
  }
  async put(key, value, opts = {}) {
    const cur = this.m.get(key);
    if (opts.ifNew && cur != null) return { ok: false };
    if (opts.ifMatch && (cur == null || etagOf(cur) !== opts.ifMatch)) return { ok: false };
    const s = JSON.stringify(value);
    this.m.set(key, s);
    return { ok: true, etag: etagOf(s) };
  }
  async del(key) { this.m.delete(key); }
  async list(prefix) { return [...this.m.keys()].filter((k) => k.startsWith(prefix)).sort(); }
}

// Keys contain slashes; each key becomes a file under a mirrored folder tree.
// Writes go through a temp file and rename so a crash never leaves half a JSON.
// A process-wide lock makes the compare-and-set honest for one local server.
export class FileStore {
  constructor(dir) { this.dir = dir; this.lock = Promise.resolve(); }
  file(key) { return path.join(this.dir, ...key.split('/').map(encodeURIComponent)) + '.json'; }
  async get(key) {
    try {
      const s = await fs.readFile(this.file(key), 'utf8');
      return { value: JSON.parse(s), etag: etagOf(s) };
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }
  put(key, value, opts = {}) {
    const run = this.lock.then(async () => {
      const cur = await this.get(key);
      if (opts.ifNew && cur) return { ok: false };
      if (opts.ifMatch && (!cur || cur.etag !== opts.ifMatch)) return { ok: false };
      const s = JSON.stringify(value);
      const f = this.file(key);
      await fs.mkdir(path.dirname(f), { recursive: true });
      const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, s);
      await fs.rename(tmp, f);
      return { ok: true, etag: etagOf(s) };
    });
    this.lock = run.catch(() => {});
    return run;
  }
  async del(key) { await fs.rm(this.file(key), { force: true }); }
  async list(prefix) {
    const out = [];
    const walk = async (dir, parts) => {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isDirectory()) await walk(path.join(dir, e.name), [...parts, decodeURIComponent(e.name)]);
        else if (e.name.endsWith('.json')) out.push([...parts, decodeURIComponent(e.name.slice(0, -5))].join('/'));
      }
    };
    await walk(this.dir, []);
    return out.filter((k) => k.startsWith(prefix)).sort();
  }
}

export class BlobStore {
  constructor(store) { this.s = store; }
  async get(key) {
    const r = await this.s.getWithMetadata(key, { type: 'json', consistency: 'strong' });
    return r ? { value: r.data, etag: r.etag } : null;
  }
  async put(key, value, opts = {}) {
    const o = opts.ifNew ? { onlyIfNew: true } : opts.ifMatch ? { onlyIfMatch: opts.ifMatch } : {};
    const r = await this.s.setJSON(key, value, o);
    return { ok: r.modified, etag: r.etag };
  }
  async del(key) { await this.s.delete(key); }
  async list(prefix) {
    const keys = [];
    for await (const page of this.s.list({ prefix, paginate: true })) for (const b of page.blobs) keys.push(b.key);
    return keys.sort();
  }
}

// Read-modify-write with retry on a lost race. `fn` gets the current value (or
// undefined) and returns the new value, or undefined to abort without writing.
export async function update(store, key, fn, tries = 8) {
  for (let i = 0; i < tries; i++) {
    const cur = await store.get(key);
    const next = await fn(cur ? cur.value : undefined);
    if (next === undefined) return cur ? cur.value : undefined;
    const r = await store.put(key, next, cur ? { ifMatch: cur.etag } : { ifNew: true });
    if (r.ok) return next;
    await new Promise((res) => setTimeout(res, 10 + Math.random() * 40 * (i + 1)));
  }
  throw Object.assign(new Error('Too much contention on ' + key), { status: 503 });
}
