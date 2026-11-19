// Session longue (migration 076) : prolongée à l usage, révoquée à la déconnexion, plus courte pour l administration.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { splitSql } from '../src/migrate.js';
import { freshDb, TEST_DB, APP_PW, world, approvedProduct, call, deliver } from './helpers.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';

const root = path.resolve(import.meta.dirname, '..', '..');
const PW = 'Secret123';
let db, w, product, srv, base, n = 0, k = 0;
const phone = () => `6${String(++n).padStart(8, '0')}`;
class Client {
  constructor() { this.cookie = ''; }
  async req(method, p, body) {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}), ...(method !== 'GET' ? { 'x-wld': '1' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    for (const c of res.headers.getSetCookie?.() ?? []) { const kv = c.split(';')[0]; this.cookie = kv.endsWith('=') ? '' : kv; }
    let json = null; try { json = await res.json(); } catch { /* vide */ }
    return { status: res.status, json };
  }
  get(p) { return this.req('GET', p); }
  post(p, b = {}) { return this.req('POST', p, b); }
}
const login = async (id) => { const c = new Client(); const ph = (await db.owner.query('SELECT phone FROM users WHERE id = $1', [id])).rows[0].phone; assert.equal((await c.post('/api/auth/login', { identifier: ph, password: PW })).status, 200); return c; };

before(async () => {
  db = await freshDb('wld_sesslong'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_sesslong', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });

const days = async (id) => Number((await db.owner.query(`SELECT extract(epoch FROM (expires_at - now()))/86400 AS d FROM sessions WHERE user_id = $1 ORDER BY expires_at DESC LIMIT 1`, [id])).rows[0].d);

test('connexion : 30 jours pour un vendeur, 7 jours pour l\'administration', async () => {
  await login(w.seller); await login(w.admin);
  const s = await days(w.seller), a = await days(w.admin);
  assert.ok(s > 29.9 && s <= 30, `vendeur ${s}`); assert.ok(a > 6.9 && a <= 7, `admin ${a}`);
});

test('une session qui s\'use est prolongée à l\'usage (et le cookie suit) ; une session toute neuve n\'est pas réécrite', async () => {
  const c = await login(w.seller);
  await db.owner.query(`UPDATE sessions SET expires_at = now() + interval '2 days' WHERE user_id = $1`, [w.seller]);
  assert.ok(await days(w.seller) < 2.1);
  const before = c.cookie;
  assert.equal((await c.get('/api/auth/me')).status, 200);
  assert.ok(await days(w.seller) > 29.9);
  assert.equal(c.cookie, before);                                                      // même jeton, seule l'échéance avance
  const fresh = await days(w.seller);
  await c.get('/api/auth/me'); assert.ok(Math.abs((await days(w.seller)) - fresh) < 0.01);
});

test('une session expirée reste refusée ; la déconnexion la révoque', async () => {
  const c = await login(w.seller);
  await db.owner.query(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [w.seller]);
  assert.equal((await c.get('/api/auth/me')).status, 401);
  const c2 = await login(w.seller);
  assert.equal((await c2.get('/api/auth/me')).status, 200);
  await c2.post('/api/auth/logout');
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND expires_at > now()`, [w.seller])).rows[0].n, 0);
});

test('retour arrière 076 : sessions fixes de 12 h', async () => {
  await login(w.courier);
  const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-076.sql'), 'utf8');
  await db.owner.query('BEGIN'); for (const q of splitSql(rb)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT');
  assert.ok(await days(w.courier) <= 0.51);
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('fn_session_touch','_session_ttl')`)).rows[0].n, 0);
});
