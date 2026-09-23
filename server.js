// Local development server: static files from public/, the API from lib/api.js,
// state in .data/ on disk. Production runs the same handler as a Netlify
// Function with Netlify Blobs instead of the folder.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHandler } from './lib/api.js';
import { FileStore } from './lib/store/index.js';

const PORT = Number(process.env.PORT || 8787);
const ROOT = path.resolve('public');
const handler = createHandler(new FileStore(path.resolve('.data')));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const r = await handler(new Request(url, {
      method: req.method,
      headers: Object.entries(req.headers).filter(([, v]) => typeof v === 'string'),
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks)
    }));
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
    return;
  }
  let p = url.pathname === '/' ? '/index.html' : url.pathname.startsWith('/app') ? '/app.html' : url.pathname;
  const file = path.join(ROOT, path.normalize(p));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}).listen(PORT, () => console.log(`termwise on http://localhost:${PORT}`));
