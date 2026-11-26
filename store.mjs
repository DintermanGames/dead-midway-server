// store.mjs — v0.8.0 persistence for accounts, cloud saves, leaderboards and analytics.
// Picks a backend at startup:
//   DATABASE_URL set  -> Postgres (via the `pg` package, vendored in node_modules so Render needs no build step)
//   otherwise         -> in-memory, optionally snapshotted to DATA_DIR/store.json (NOT durable on Render Free:
//                        the disk is wiped on every deploy/restart/spin-down; clients re-upload their save, see SERVER_SETUP.md)
// If Postgres becomes unreachable (e.g. the Free database expired) the server keeps running on the memory store
// so co-op and the game keep working; cloud saves self-heal from clients when a database is back.
import fs from 'node:fs';
import path from 'node:path';

const DAY = 86400000;
export const RETAIN = { eventsDays: 90, dailyBoardDays: 14, weeklyBoardWeeks: 10 };

// ---------------- memory / file store ----------------
export class MemStore {
  constructor(dir) {
    this.kind = dir ? 'file' : 'memory'; this.file = dir ? path.join(dir, 'store.json') : null; this.dirty = false;
    this.acc = new Map(); this.rec = new Map(); this.saves = new Map(); this.boards = new Map(); this.events = [];
    if (this.file && fs.existsSync(this.file)) {
      try {
        const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        for (const a of j.acc || []) { this.acc.set(a.id, a); if (a.rec) this.rec.set(a.rec, a.id); }
        for (const [k, v] of j.saves || []) this.saves.set(k, v);
        for (const [b, rows] of j.boards || []) this.boards.set(b, new Map(rows));
        this.events = j.events || [];
      } catch (e) { console.log('store.json unreadable, starting empty:', e.message); }
    }
    if (this.file) { fs.mkdirSync(dir, { recursive: true }); this.timer = setInterval(() => this.flush(), 10000); this.timer.unref(); }
  }
  async init() { return this; }
  flush() {
    if (!this.file || !this.dirty) return; this.dirty = false;
    const j = { acc: [...this.acc.values()], saves: [...this.saves], boards: [...this.boards].map(([b, m]) => [b, [...m]]), events: this.events };
    try { fs.writeFileSync(this.file + '.tmp', JSON.stringify(j)); fs.renameSync(this.file + '.tmp', this.file); } catch (e) { console.log('store flush failed', e.message); }
  }
  touch() { this.dirty = true; }
  async getAccount(id) { return this.acc.get(id) || null; }
  async putAccount(a) { const old = this.acc.get(a.id); if (old && old.rec && old.rec !== a.rec) this.rec.delete(old.rec); this.acc.set(a.id, a); if (a.rec) this.rec.set(a.rec, a.id); this.touch(); }
  async findRecovery(h) { return this.rec.get(h) || null; }
  async deleteAccount(id) { const a = this.acc.get(id); if (a && a.rec) this.rec.delete(a.rec); this.acc.delete(id); this.saves.delete(id); for (const m of this.boards.values()) m.delete(id); this.touch(); }
  async getSave(id) { return this.saves.get(id) || null; }
  async putSave(id, s) { this.saves.set(id, s); this.touch(); }
  async putScore(board, id, e) {
    let m = this.boards.get(board); if (!m) this.boards.set(board, m = new Map());
    const old = m.get(id); if (old && old.score >= e.score) { if (old.name !== e.name) { old.name = e.name; this.touch(); } return false; }
    m.set(id, e); this.touch(); return true;
  }
  async board(board, n, me) {
    const m = this.boards.get(board); if (!m) return { top: [], total: 0, me: null };
    const all = [...m].map(([id, e]) => ({ id, ...e })).sort((a, b) => b.score - a.score || a.at - b.at);
    const i = me ? all.findIndex(x => x.id === me) : -1;
    return { top: all.slice(0, n), total: all.length, me: i >= 0 ? { rank: i + 1, ...all[i] } : null };
  }
  async addEvents(rows) { this.events.push(...rows); if (this.events.length > 200000) this.events.splice(0, this.events.length - 200000); this.touch(); }
  async summary(sinceDay) {
    const ev = this.events.filter(e => e.day >= sinceDay);
    return summarize(ev);
  }
  async prune(now = Date.now()) {
    const cut = new Date(now - RETAIN.eventsDays * DAY).toISOString().slice(0, 10);
    this.events = this.events.filter(e => e.day >= cut);
    for (const b of [...this.boards.keys()]) if (boardExpired(b, now)) this.boards.delete(b);
    this.touch();
  }
  async stats() { return { accounts: this.acc.size, saves: this.saves.size, boards: this.boards.size, events: this.events.length }; }
  async close() { this.flush(); clearInterval(this.timer); }
}

export function boardExpired(b, now = Date.now()) {
  let m = /^d:(\d{4}-\d{2}-\d{2})/.exec(b);
  if (m) return now - Date.parse(m[1] + 'T00:00:00Z') > RETAIN.dailyBoardDays * DAY;
  m = /^w:(\d{4})-W(\d{2})/.exec(b);
  if (m) { const approx = Date.UTC(+m[1], 0, 1) + (+m[2] - 1) * 7 * DAY; return now - approx > RETAIN.weeklyBoardWeeks * 7 * DAY; }
  return false;
}

// shared aggregation used by the memory store (the Postgres store does the same in SQL)
export function summarize(ev) {
  const days = {}, names = {}, stages = {}, quits = {}, buys = {};
  for (const e of ev) {
    const d = days[e.day] || (days[e.day] = { installs: new Set(), sessions: new Set(), newInstalls: 0, events: 0 });
    d.installs.add(e.iid); d.sessions.add(e.sid); d.events++; if (e.n === 'first_open') d.newInstalls++;
    names[e.n] = (names[e.n] || 0) + 1;
    if (/^stage_(start|fail|clear|quit)$/.test(e.n)) { const s = stages[e.k] || (stages[e.k] = { start: 0, fail: 0, clear: 0, quit: 0, tSum: 0, tN: 0 }); s[e.n.slice(6)]++; if (e.n !== 'stage_start' && e.v) { s.tSum += e.v; s.tN++; } }
    if (e.n === 'stage_quit' || e.n === 'app_quit') { const q = e.k || '(menu)'; quits[q] = (quits[q] || 0) + 1; }
    if (/^(shop_open|purchase_start|purchase_ok|purchase_fail|purchase_cancel)$/.test(e.n)) { const b = buys[e.k || '-'] || (buys[e.k || '-'] = {}); b[e.n] = (b[e.n] || 0) + 1; }
  }
  const out = { days: {}, events: names, stages: {}, quitPoints: quits, purchases: buys };
  for (const k of Object.keys(days).sort()) out.days[k] = { installs: days[k].installs.size, sessions: days[k].sessions.size, newInstalls: days[k].newInstalls, events: days[k].events };
  for (const k of Object.keys(stages)) { const s = stages[k]; out.stages[k] = { start: s.start, clear: s.clear, fail: s.fail, quit: s.quit, clearRate: s.start ? +(s.clear / s.start).toFixed(3) : null, avgEndSec: s.tN ? Math.round(s.tSum / s.tN) : null }; }
  return out;
}

// ---------------- Postgres store ----------------
export class PgStore {
  constructor(url) { this.kind = 'postgres'; this.url = url; }
  async init() {
    const { default: pg } = await import('pg');
    const ssl = /sslmode=disable/.test(this.url) || /@(localhost|127\.0\.0\.1|dpg-[a-z0-9]+-a)(:|\/)/.test(this.url) ? false : { rejectUnauthorized: false };
    this.pool = new pg.Pool({ connectionString: this.url.replace(/[?&]sslmode=disable/, ''), ssl, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 8000 });
    this.pool.on('error', e => console.log('pg pool error', e.message));
    await this.q(`CREATE TABLE IF NOT EXISTS dm_accounts (id text PRIMARY KEY, tokens text NOT NULL, rec text UNIQUE, name text, created bigint);
      CREATE TABLE IF NOT EXISTS dm_saves (id text PRIMARY KEY, data text NOT NULL, saved_at bigint, progress integer, rev integer, updated bigint);
      CREATE TABLE IF NOT EXISTS dm_scores (board text, id text, name text, score integer, meta text, at bigint, PRIMARY KEY (board, id));
      CREATE INDEX IF NOT EXISTS dm_scores_rank ON dm_scores (board, score DESC);
      CREATE TABLE IF NOT EXISTS dm_events (day text, n text, k text, v double precision, iid text, sid text, plat text, ver text, at bigint);
      CREATE INDEX IF NOT EXISTS dm_events_day ON dm_events (day);`);
    return this;
  }
  q(sql, args) { return this.pool.query(sql, args); }
  async getAccount(id) { const r = await this.q('SELECT * FROM dm_accounts WHERE id=$1', [id]); const a = r.rows[0]; return a ? { id: a.id, tokens: JSON.parse(a.tokens), rec: a.rec, name: a.name, created: +a.created } : null; }
  async putAccount(a) { await this.q('INSERT INTO dm_accounts (id,tokens,rec,name,created) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET tokens=EXCLUDED.tokens, rec=EXCLUDED.rec, name=EXCLUDED.name', [a.id, JSON.stringify(a.tokens), a.rec || null, a.name || '', a.created]); }
  async deleteAccount(id) { await this.q('DELETE FROM dm_scores WHERE id=$1', [id]); await this.q('DELETE FROM dm_saves WHERE id=$1', [id]); await this.q('DELETE FROM dm_accounts WHERE id=$1', [id]); }
  async findRecovery(h) { const r = await this.q('SELECT id FROM dm_accounts WHERE rec=$1', [h]); return r.rows[0] ? r.rows[0].id : null; }
  async getSave(id) { const r = await this.q('SELECT * FROM dm_saves WHERE id=$1', [id]); const s = r.rows[0]; return s ? { data: s.data, savedAt: +s.saved_at, progress: s.progress, rev: s.rev, updated: +s.updated } : null; }
  async putSave(id, s) { await this.q('INSERT INTO dm_saves (id,data,saved_at,progress,rev,updated) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, saved_at=EXCLUDED.saved_at, progress=EXCLUDED.progress, rev=EXCLUDED.rev, updated=EXCLUDED.updated', [id, s.data, s.savedAt, s.progress, s.rev, s.updated]); }
  async putScore(board, id, e) {
    const r = await this.q(`INSERT INTO dm_scores (board,id,name,score,meta,at) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (board,id) DO UPDATE SET name=EXCLUDED.name,
        score=GREATEST(dm_scores.score, EXCLUDED.score),
        meta=CASE WHEN EXCLUDED.score > dm_scores.score THEN EXCLUDED.meta ELSE dm_scores.meta END,
        at=CASE WHEN EXCLUDED.score > dm_scores.score THEN EXCLUDED.at ELSE dm_scores.at END
      RETURNING score`, [board, id, e.name, e.score, e.meta || '', e.at]);
    return r.rows[0] && r.rows[0].score === e.score;
  }
  async board(board, n, me) {
    const top = (await this.q('SELECT id,name,score,meta,at FROM dm_scores WHERE board=$1 ORDER BY score DESC, at ASC LIMIT $2', [board, n])).rows.map(r => ({ id: r.id, name: r.name, score: r.score, meta: r.meta, at: +r.at }));
    const total = +(await this.q('SELECT count(*) c FROM dm_scores WHERE board=$1', [board])).rows[0].c;
    let mine = null;
    if (me) { const r = (await this.q('SELECT s.*, (SELECT count(*) FROM dm_scores o WHERE o.board=s.board AND (o.score > s.score OR (o.score = s.score AND o.at < s.at))) + 1 AS rank FROM dm_scores s WHERE board=$1 AND id=$2', [board, me])).rows[0]; if (r) mine = { rank: +r.rank, id: r.id, name: r.name, score: r.score, meta: r.meta, at: +r.at }; }
    return { top, total, me: mine };
  }
  async addEvents(rows) {
    if (!rows.length) return;
    const vals = [], args = [];
    rows.forEach((e, i) => { const b = i * 9; vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`); args.push(e.day, e.n, e.k, e.v, e.iid, e.sid, e.plat, e.ver, e.at); });
    await this.q('INSERT INTO dm_events (day,n,k,v,iid,sid,plat,ver,at) VALUES ' + vals.join(','), args);
  }
  async summary(sinceDay) {
    const r = await this.q('SELECT day,n,k,v,iid,sid FROM dm_events WHERE day >= $1 LIMIT 500000', [sinceDay]);
    return summarize(r.rows.map(x => ({ ...x, v: x.v == null ? 0 : +x.v })));
  }
  async prune(now = Date.now()) {
    const cut = new Date(now - RETAIN.eventsDays * DAY).toISOString().slice(0, 10);
    await this.q('DELETE FROM dm_events WHERE day < $1', [cut]);
    const boards = (await this.q('SELECT DISTINCT board FROM dm_scores')).rows.map(r => r.board).filter(b => boardExpired(b, now));
    if (boards.length) await this.q('DELETE FROM dm_scores WHERE board = ANY($1)', [boards]);
  }
  async stats() { const r = await this.q('SELECT (SELECT count(*) FROM dm_accounts) a, (SELECT count(*) FROM dm_saves) s, (SELECT count(DISTINCT board) FROM dm_scores) b, (SELECT count(*) FROM dm_events) e'); const x = r.rows[0]; return { accounts: +x.a, saves: +x.s, boards: +x.b, events: +x.e }; }
  async close() { try { await this.pool.end(); } catch (e) {} }
}

export async function openStore(env = process.env) {
  if (env.DATABASE_URL) {
    try { const s = await new PgStore(env.DATABASE_URL).init(); console.log('store: postgres'); return s; }
    catch (e) { console.log('store: postgres unavailable (' + e.message + '), falling back to memory. Cloud saves will self-heal from clients when the database is back.'); const m = new MemStore(env.DATA_DIR || null); m.degraded = 'postgres unavailable'; return m; }
  }
  const m = new MemStore(env.DATA_DIR || null); console.log('store: ' + m.kind + (m.file ? ' (' + m.file + ')' : '')); return m;
}
