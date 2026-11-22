// Dead Midway co-op server: static file host for dist/ + a tiny WebSocket room relay.
// Zero dependencies (Node 18+). Run:  node server/server.mjs   (PORT env, default 8787)
// v0.7.0 deploy settings (all optional env vars, see SERVER_SETUP.md / render.yaml):
//   PORT             listen port (Render sets this)            STATIC_DIR   folder to serve, or "none" for relay-only
//   ALLOWED_ORIGINS  comma list of web origins allowed to open a WebSocket, e.g.
//                    "https://localhost,https://your-site.netlify.app"  (https://localhost = the Android app). Empty = allow all.
//   MAX_CLIENTS      connection cap (default 400)              MAX_ROOMS    room cap (default 150)
// Rooms: 4-letter codes, 2-4 players. The room creator is the host and runs the simulation;
// the server only relays messages (guest -> host, host -> one guest or everyone).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = +(process.env.PORT || 8787);
const ROOT = path.resolve(process.env.STATIC_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'dist'));
const MAX_PLAYERS = 4, MAX_MSG = 512 * 1024, MAX_BUFFER = 1.5 * 1024 * 1024;
const STATIC_OFF = String(process.env.STATIC_DIR || '').toLowerCase() === 'none' || !fs.existsSync(ROOT);
const ORIGINS = String(process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
const MAX_CLIENTS = +(process.env.MAX_CLIENTS || 400), MAX_ROOMS = +(process.env.MAX_ROOMS || 150), MSG_PER_SEC = 120;
const VERSION = '0.7.1', started = Date.now();
function originOk(o) { return !ORIGINS.length || (o && ORIGINS.includes(String(o).replace(/\/$/, ''))); }
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

// ---------- static files ----------
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const cors = { 'Access-Control-Allow-Origin': ORIGINS.length ? (originOk(req.headers.origin) ? req.headers.origin : 'null') : '*', 'Vary': 'Origin' };
  if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors }); return res.end(JSON.stringify({ ok: true, version: VERSION, rooms: rooms.size, clients: clients.size, uptime: Math.round((Date.now() - started) / 1000) })); }
  if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, OPTIONS' }); return res.end(); }
  if (STATIC_OFF) { res.writeHead(url === '/' ? 200 : 404, { 'Content-Type': 'text/plain', ...cors }); return res.end(url === '/' ? 'Dead Midway co-op server ' + VERSION + ' is running. WebSocket endpoint: /ws' : 'not found'); }
  let p = path.join(ROOT, url);
  if (!p.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const type = TYPES[path.extname(p)] || 'application/octet-stream', m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) { const a = m[1] ? +m[1] : 0, b = m[2] ? Math.min(+m[2], data.length - 1) : data.length - 1; res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Accept-Ranges': 'bytes', 'Content-Length': b - a + 1 }); return res.end(data.subarray(a, b + 1)); }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': p.endsWith('.html') ? 'no-cache' : 'public, max-age=3600', 'Accept-Ranges': 'bytes' }); res.end(data);
  });
});

// ---------- minimal RFC 6455 WebSocket ----------
const clients = new Set(), rooms = new Map();
let nextId = 1;
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { sock.destroy(); return; }
  if (!originOk(req.headers.origin)) { sock.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); sock.destroy(); log('rejected origin ' + req.headers.origin); return; }
  if (clients.size >= MAX_CLIENTS) { sock.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  const c = { id: 'p' + (nextId++).toString(36), sock, buf: Buffer.alloc(0), frags: [], room: null, name: 'Survivor', alive: true, win: Date.now(), n: 0 };
  clients.add(c);
  sock.on('data', d => { c.buf = Buffer.concat([c.buf, d]); parse(c); });
  sock.on('close', () => drop(c)); sock.on('error', () => drop(c));
});
function parse(c) {
  for (;;) {
    const b = c.buf; if (b.length < 2) return;
    const fin = b[0] & 0x80, op = b[0] & 0x0f, masked = b[1] & 0x80; let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    if (len > MAX_MSG) { c.sock.destroy(); return; }
    const need = off + (masked ? 4 : 0) + len; if (b.length < need) return;
    let payload = b.subarray(off + (masked ? 4 : 0), need);
    if (masked) { const mk = b.subarray(off, off + 4); payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= mk[i & 3]; }
    c.buf = b.subarray(need);
    if (op === 0x8) { c.sock.end(); return; }
    if (op === 0x9) { frame(c, payload, 0xA); continue; }
    if (op === 0xA) { c.alive = true; continue; }
    if (op === 0x1 || op === 0x0) {
      c.frags.push(payload);
      if (fin) {
        const now = Date.now(); if (now - c.win > 1000) { c.win = now; c.n = 0; } if (++c.n > MSG_PER_SEC) continue; // flood guard
        const text = Buffer.concat(c.frags).toString('utf8'); c.frags = []; let m; try { m = JSON.parse(text); } catch (e) { continue; } handle(c, m, text);
      }
    }
  }
}
function frame(c, data, op = 0x1) {
  if (c.sock.destroyed) return;
  const len = data.length; let h;
  if (len < 126) { h = Buffer.alloc(2); h[1] = len; }
  else if (len < 65536) { h = Buffer.alloc(4); h[1] = 126; h.writeUInt16BE(len, 2); }
  else { h = Buffer.alloc(10); h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); }
  h[0] = 0x80 | op; c.sock.write(Buffer.concat([h, data]));
}
function send(c, obj, droppable) {
  if (!c || c.sock.destroyed) return;
  if (droppable && c.sock.writableLength > MAX_BUFFER) return; // slow client: skip snapshots instead of queueing forever
  frame(c, Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)));
}

// ---------- rooms ----------
function code() { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let s; do { s = ''; for (let i = 0; i < 4; i++) s += A[crypto.randomInt(A.length)]; } while (rooms.has(s)); return s; }
function roster(r) { return r.players.map(p => ({ id: p.id, name: p.name, host: p === r.host })); }
function broadcastRoster(r) { const list = roster(r); r.players.forEach(p => send(p, { t: 'roster', players: list })); }
function clean(n) { return String(n || 'Survivor').replace(/[<>]/g, '').trim().slice(0, 14) || 'Survivor'; }
function handle(c, m) {
  if (m.t === 'create') {
    if (rooms.size >= MAX_ROOMS) return send(c, { t: 'error', msg: 'Servers are busy right now. Please try again in a minute.' });
    leave(c); c.name = clean(m.name);
    const r = { code: code(), host: c, players: [c], locked: false, created: Date.now() }; rooms.set(r.code, r); c.room = r;
    send(c, { t: 'joined', code: r.code, id: c.id, host: true, players: roster(r) });
    log(`room ${r.code} created by ${c.name}`);
  } else if (m.t === 'join') {
    const r = rooms.get(String(m.code || '').toUpperCase());
    if (!r) return send(c, { t: 'error', msg: 'Room not found. Check the code.' });
    if (r.locked) return send(c, { t: 'error', msg: 'That game has already started.' });
    if (r.players.length >= MAX_PLAYERS) return send(c, { t: 'error', msg: 'Room is full (4 players).' });
    leave(c); c.name = clean(m.name); r.players.push(c); c.room = r;
    send(c, { t: 'joined', code: r.code, id: c.id, host: false, players: roster(r) });
    broadcastRoster(r); log(`${c.name} joined ${r.code} (${r.players.length})`);
  } else if (m.t === 'lock') {
    if (c.room && c.room.host === c) c.room.locked = true;
  } else if (m.t === 'msg') {
    const r = c.room; if (!r) return;
    const snap = m.d && m.d.k === 's';
    if (c === r.host) {
      const out = JSON.stringify({ t: 'msg', from: c.id, d: m.d });
      if (m.to === '*' || !m.to) r.players.forEach(p => { if (p !== c) send(p, out, snap); });
      else { const p = r.players.find(q => q.id === m.to); if (p) send(p, out, snap); }
    } else send(r.host, { t: 'msg', from: c.id, d: m.d });
  } else if (m.t === 'leave') leave(c);
}
function leave(c) {
  const r = c.room; if (!r) return; c.room = null;
  r.players = r.players.filter(p => p !== c);
  if (r.host === c) { r.players.forEach(p => { p.room = null; send(p, { t: 'hostleft' }); }); rooms.delete(r.code); log(`room ${r.code} closed`); return; }
  r.players.forEach(p => send(p, { t: 'left', id: c.id }));
  broadcastRoster(r);
}
function drop(c) { if (!clients.has(c)) return; clients.delete(c); leave(c); try { c.sock.destroy(); } catch (e) {} }
function log(s) { console.log(new Date().toISOString(), s); }
// heartbeat: drop dead sockets, expire empty/stale rooms
setInterval(() => {
  clients.forEach(c => { if (!c.alive) return drop(c); c.alive = false; frame(c, Buffer.alloc(0), 0x9); });
  rooms.forEach((r, k) => { if (!r.players.length || Date.now() - r.created > 6 * 3600e3) rooms.delete(k); });
}, 25000);

server.listen(PORT, '0.0.0.0', () => console.log(`Dead Midway co-op server ${VERSION} on port ${PORT}  (static: ${STATIC_OFF ? 'off' : ROOT}, origins: ${ORIGINS.join(' ') || 'any'}, websocket: /ws)`));
function shutdown() { log('shutting down'); clients.forEach(c => { try { c.sock.end(); } catch (e) {} }); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
