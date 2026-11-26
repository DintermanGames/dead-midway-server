// api.mjs — v0.8.0 HTTP JSON API (all under /api/v1, CORS-checked like the WebSocket):
//   POST /api/v1/account   {}                       -> new guest account {id, token, rec}
//                          {id, token, rec?}        -> check / self-heal an existing account (re-created if the store lost it)
//   DELETE /api/v1/account (auth)                 -> deletes the account, its cloud save and its leaderboard rows
//   POST /api/v1/admin/delete {code} + X-Admin-Key -> same, for deletion requests sent by email with the recovery code
//   POST /api/v1/recover   {code}                   -> {id, token, rec}  (moves an account to this device with its recovery code)
//   GET  /api/v1/save      (auth)                   -> {save|null, savedAt, progress, rev}
//   PUT  /api/v1/save      (auth) {save, savedAt, progress, baseRev, force?} -> {rev} | 409 {conflict, server:{savedAt, progress, rev}}
//   POST /api/v1/score     (auth) {board, score, name, meta} -> {best, rank, total}
//   GET  /api/v1/board?b=d:2026-11-26&n=50 (auth optional) -> {top:[{name,score,meta,me}], total, me}
//   POST /api/v1/a         {iid, sid, plat, ver, ev:[{n,k,v}]} -> anonymous analytics batch (no account id, no IP stored)
//   GET  /api/v1/analytics/summary?days=7  header X-Admin-Key: $ADMIN_KEY -> aggregated counts (disabled when ADMIN_KEY is unset)
// auth = header  Authorization: Bearer <id>.<token>   (only SHA-256 hashes of tokens and recovery codes are stored)
import crypto from 'node:crypto';

const DAY = 86400000, MAX_BODY = 400 * 1024, MAX_SAVE = 300 * 1024, API_RATE = +(process.env.API_RATE_PER_MIN || 600);
const ALPHA = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const rid = n => { let s = ''; for (let i = 0; i < n; i++) s += ALPHA[crypto.randomInt(ALPHA.length)]; return s; };
export const newRecovery = () => rid(4) + '-' + rid(4) + '-' + rid(4);
export const normRecovery = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const cleanName = n => String(n || 'Survivor').replace(/[<>&"]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14) || 'Survivor';
const ID_RE = /^u_[a-z0-9]{12}$/, TOKEN_RE = /^[a-f0-9]{48}$/;

// boards: "d:YYYY-MM-DD" (daily) or "w:YYYY-Www" (weekly). Only the current period (±1 for time zones) accepts scores.
export function isoWeek(t) { const x0 = new Date(t), x = new Date(Date.UTC(x0.getUTCFullYear(), x0.getUTCMonth(), x0.getUTCDate())); const dn = x.getUTCDay() || 7; x.setUTCDate(x.getUTCDate() + 4 - dn); const y0 = Date.UTC(x.getUTCFullYear(), 0, 1); return x.getUTCFullYear() + '-W' + ('0' + Math.ceil(((x - y0) / DAY + 1) / 7)).slice(-2); }
export function boardOpen(b, now = Date.now()) {
  if (/^d:\d{4}-\d{2}-\d{2}$/.test(b)) return [-1, 0, 1].some(o => 'd:' + new Date(now + o * DAY).toISOString().slice(0, 10) === b);
  if (/^w:\d{4}-W\d{2}$/.test(b)) return [-1, 0, 1].some(o => 'w:' + isoWeek(now + o * DAY) === b);
  return false;
}
const BOARD_RE = /^(d:\d{4}-\d{2}-\d{2}|w:\d{4}-W\d{2})$/;

export function createApi({ store, version, originOk, ORIGINS, adminKey, log }) {
  const buckets = new Map();
  function limited(req, kind, max, winMs) {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const k = kind + '|' + ip, now = Date.now(); let b = buckets.get(k);
    if (!b || now - b.t > winMs) { b = { t: now, n: 0 }; buckets.set(k, b); }
    return ++b.n > max;
  }
  setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now - b.t > 3600e3) buckets.delete(k); }, 600e3).unref();

  function out(res, cors, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors }); res.end(JSON.stringify(obj)); }
  function body(req) {
    return new Promise((ok, bad) => {
      let n = 0; const parts = [];
      req.on('data', d => { n += d.length; if (n > MAX_BODY) { bad(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } else parts.push(d); });
      req.on('end', () => { try { ok(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch (e) { bad(Object.assign(new Error('bad json'), { code: 400 })); } });
      req.on('error', bad);
    });
  }
  async function auth(req) {
    const m = /^Bearer (u_[a-z0-9]{12})\.([a-f0-9]{48})$/.exec(req.headers.authorization || ''); if (!m) return null;
    const a = await store.getAccount(m[1]); if (!a) return { missing: true, id: m[1] };
    return a.tokens.includes(sha(m[2])) ? a : null;
  }

  return async function api(req, res, url, cors) {
    const send = (code, obj) => out(res, cors, code, obj);
    try {
      if (ORIGINS.length && req.headers.origin && !originOk(req.headers.origin)) return send(403, { error: 'origin' });
      if (limited(req, 'api', API_RATE, 60e3)) return send(429, { error: 'slow down' });
      const q = new URL(req.url, 'http://x').searchParams, M = req.method;
      if (url === '/api/v1/ping') return send(200, { ok: true, version, store: store.kind, time: Date.now() });

      if (url === '/api/v1/account' && M === 'POST') {
        const b = await body(req);
        if (b.id) { // check / self-heal
          if (!ID_RE.test(b.id) || !TOKEN_RE.test(String(b.token || ''))) return send(400, { error: 'bad account' });
          const a = await store.getAccount(b.id);
          if (a) {
            if (a.tokens.includes(sha(b.token))) return send(200, { id: a.id, ok: true });
            // a second device of the same account after the store was rebuilt: its recovery code proves ownership
            if (b.rec && a.rec && a.rec === sha(normRecovery(b.rec))) { if (limited(req, 'rec', 10, 60e3)) return send(429, { error: 'slow down' }); a.tokens = [...a.tokens, sha(b.token)].slice(-4); await store.putAccount(a); return send(200, { id: a.id, ok: true, restored: true }); }
            return send(403, { error: 'token', moved: true });
          }
          if (limited(req, 'acct', 30, 3600e3)) return send(429, { error: 'slow down' });
          let rec = b.rec ? sha(normRecovery(b.rec)) : null; if (rec && await store.findRecovery(rec)) rec = null;
          await store.putAccount({ id: b.id, tokens: [sha(b.token)], rec, name: cleanName(b.name), created: Date.now() });
          return send(200, { id: b.id, ok: true, restored: true });
        }
        if (limited(req, 'acct', 30, 3600e3)) return send(429, { error: 'slow down' });
        const id = 'u_' + crypto.randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(12, '0').slice(0, 12);
        const token = crypto.randomBytes(24).toString('hex'), rec = newRecovery();
        await store.putAccount({ id, tokens: [sha(token)], rec: sha(normRecovery(rec)), name: cleanName(b.name), created: Date.now() });
        return send(200, { id, token, rec });
      }
      if (url === '/api/v1/account' && M === 'DELETE') { // in-app "Delete cloud save" (Play account-deletion requirement)
        const a = await auth(req); if (!a) return send(401, { error: 'auth' }); if (a.missing) return send(200, { ok: true, deleted: false });
        await store.deleteAccount(a.id); log('account deleted ' + a.id); return send(200, { ok: true, deleted: true });
      }
      if (url === '/api/v1/admin/delete' && M === 'POST') { // deletion requests by email: admin key + the player's recovery code
        if (!adminKey || String(req.headers['x-admin-key'] || '') !== adminKey) return send(401, { error: 'admin key' });
        const b = await body(req), id = await store.findRecovery(sha(normRecovery(b.code))); if (!id) return send(404, { error: 'no account for that code' });
        await store.deleteAccount(id); log('account deleted by admin ' + id); return send(200, { ok: true, id });
      }
      if (url === '/api/v1/recover' && M === 'POST') {
        if (limited(req, 'rec', 10, 60e3)) return send(429, { error: 'Too many tries. Wait a minute.' });
        const b = await body(req), code = normRecovery(b.code);
        if (code.length !== 12) return send(400, { error: 'That code should be 12 letters and numbers.' });
        const id = await store.findRecovery(sha(code)); if (!id) return send(404, { error: 'No save found for that code.' });
        const a = await store.getAccount(id), token = crypto.randomBytes(24).toString('hex');
        a.tokens = [...a.tokens, sha(token)].slice(-4); await store.putAccount(a);
        log('account recovered ' + id);
        return send(200, { id, token, rec: code.slice(0, 4) + '-' + code.slice(4, 8) + '-' + code.slice(8) });
      }
      if (url === '/api/v1/save') {
        const a = await auth(req); if (!a) return send(401, { error: 'auth' }); if (a.missing) return send(404, { error: 'no account', missing: true });
        if (M === 'GET') { const s = await store.getSave(a.id); return send(200, s ? { save: JSON.parse(s.data), savedAt: s.savedAt, progress: s.progress, rev: s.rev } : { save: null, rev: 0 }); }
        if (M === 'PUT') {
          const b = await body(req);
          if (!b.save || typeof b.save !== 'object' || !b.save.heroes) return send(400, { error: 'bad save' });
          const data = JSON.stringify(b.save); if (data.length > MAX_SAVE) return send(413, { error: 'save too large' });
          const cur = await store.getSave(a.id), curRev = cur ? cur.rev : 0;
          if (cur && !b.force && (+b.baseRev || 0) !== curRev) return send(409, { conflict: true, server: { savedAt: cur.savedAt, progress: cur.progress, rev: cur.rev } });
          const rec = { data, savedAt: Math.min(+b.savedAt || Date.now(), Date.now() + 60e3), progress: Math.max(0, Math.floor(+b.progress || 0)), rev: curRev + 1, updated: Date.now() };
          await store.putSave(a.id, rec);
          return send(200, { ok: true, rev: rec.rev, savedAt: rec.savedAt });
        }
      }
      if (url === '/api/v1/score' && M === 'POST') {
        const a = await auth(req); if (!a) return send(401, { error: 'auth' }); if (a.missing) return send(404, { error: 'no account', missing: true });
        const b = await body(req), board = String(b.board || ''), score = Math.floor(+b.score);
        if (!BOARD_RE.test(board)) return send(400, { error: 'bad board' });
        if (!boardOpen(board)) return send(409, { error: 'This event has ended.' });
        if (!(score >= 0 && score <= 5e6)) return send(400, { error: 'bad score' });
        if (limited(req, 'score', 30, 60e3)) return send(429, { error: 'slow down' });
        const name = cleanName(b.name); if (name !== a.name) { a.name = name; await store.putAccount(a); }
        await store.putScore(board, a.id, { name, score, meta: String(b.meta || '').slice(0, 40), at: Date.now() });
        const bd = await store.board(board, 0, a.id);
        return send(200, { ok: true, best: bd.me ? bd.me.score : score, rank: bd.me ? bd.me.rank : null, total: bd.total });
      }
      if (url === '/api/v1/board' && M === 'GET') {
        const board = String(q.get('b') || ''); if (!BOARD_RE.test(board)) return send(400, { error: 'bad board' });
        const a = await auth(req), me = a && !a.missing ? a.id : null, n = Math.max(1, Math.min(100, +q.get('n') || 50));
        const bd = await store.board(board, n, me);
        const strip = e => ({ name: e.name, score: e.score, meta: e.meta, me: !!me && e.id === me });
        return send(200, { board, top: bd.top.map(strip), total: bd.total, me: bd.me ? { rank: bd.me.rank, score: bd.me.score } : null });
      }
      if (url === '/api/v1/a' && M === 'POST') {
        if (limited(req, 'an', 60, 60e3)) return send(429, { error: 'slow down' });
        const b = await body(req), iid = String(b.iid || ''), sid = String(b.sid || '');
        if (!/^[a-z0-9]{8,32}$/i.test(iid) || !/^[a-z0-9]{4,32}$/i.test(sid) || !Array.isArray(b.ev)) return send(400, { error: 'bad batch' });
        const now = Date.now(), day = new Date(now).toISOString().slice(0, 10), plat = String(b.plat || '').slice(0, 12), ver = String(b.ver || '').slice(0, 12);
        const rows = b.ev.slice(0, 60).filter(e => e && /^[a-z_]{2,24}$/.test(e.n)).map(e => ({ day, n: e.n, k: e.k == null ? '' : String(e.k).slice(0, 32), v: Number.isFinite(+e.v) ? +e.v : null, iid, sid, plat, ver, at: now }));
        await store.addEvents(rows);
        return send(200, { ok: true, n: rows.length });
      }
      if (url === '/api/v1/analytics/summary' && M === 'GET') {
        if (!adminKey) return send(404, { error: 'analytics summary disabled (set ADMIN_KEY)' });
        const k = String(req.headers['x-admin-key'] || '');
        if (k.length !== adminKey.length || !crypto.timingSafeEqual(Buffer.from(k), Buffer.from(adminKey))) { limited(req, 'adm', 0, 60e3); return send(401, { error: 'admin key' }); }
        const days = Math.max(1, Math.min(90, +q.get('days') || 7)), since = new Date(Date.now() - (days - 1) * DAY).toISOString().slice(0, 10);
        return send(200, { since, days, store: store.kind, totals: await store.stats(), ...(await store.summary(since)) });
      }
      return send(404, { error: 'not found' });
    } catch (e) {
      if (e && e.code === 413) return send(413, { error: 'too large' });
      if (e && e.code === 400) return send(400, { error: 'bad json' });
      log('api error ' + url + ': ' + (e && e.message)); return send(503, { error: 'Cloud service is busy. Your progress is safe on this device.' });
    }
  };
}
