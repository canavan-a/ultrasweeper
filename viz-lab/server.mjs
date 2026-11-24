#!/usr/bin/env node
// Local-only viewer for hunt CSVs. Serves static/ and the hunt_*.csv files
// from ~/Downloads (or HUNT_DIR). Nothing leaves this machine except map tiles.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = +(process.env.PORT ?? 3766);
const HUNT_DIR = process.env.HUNT_DIR ?? path.join(os.homedir(), 'Downloads');
const STATIC = path.join(path.dirname(new URL(import.meta.url).pathname), 'static');
const TYPES = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.csv': 'text/csv'};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, body, type = 'text/plain') => { res.writeHead(code, {'content-type': type, 'cache-control': 'no-store'}); res.end(body); };
  if (url.pathname === '/hunts') {
    const files = fs.readdirSync(HUNT_DIR).filter(f => /^hunt_[\d_-]+\.csv$/.test(f))
      .map(f => ({name: f, size: fs.statSync(path.join(HUNT_DIR, f)).size})).sort((a, b) => b.name.localeCompare(a.name));
    return send(200, JSON.stringify(files), 'application/json');
  }
  if (url.pathname.startsWith('/hunts/')) {
    const f = path.basename(url.pathname);
    if (!/^hunt_[\d_-]+\.csv$/.test(f)) return send(404, 'no');
    return fs.readFile(path.join(HUNT_DIR, f), (e, b) => e ? send(404, 'no') : send(200, b, 'text/csv'));
  }
  const p = path.join(STATIC, path.normalize(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!p.startsWith(STATIC)) return send(403, 'no');
  fs.readFile(p, (e, b) => e ? send(404, 'not found') : send(200, b, TYPES[path.extname(p)] ?? 'application/octet-stream'));
}).listen(PORT, '127.0.0.1', () => console.log(`hunt viewer: http://localhost:${PORT}  (hunts from ${HUNT_DIR})`));
