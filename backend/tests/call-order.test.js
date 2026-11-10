// Call center : les nouvelles commandes sont en haut, les plus anciennes en bas.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshDb, TEST_DB, APP_PW, world, call, expectErr, deliver } from './helpers.js';
import { splitSql } from '../src/migrate.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';

const PW = 'Secret123';
const root = path.resolve(import.meta.dirname, '..', '..');
let db, w, srv, base, n = 0;
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
const order = (extra = {}) => ({ request_key: `r${String(++n).padStart(3, '0')}`.padEnd(20, 'x'), qty: 2, customer_name: 'Client Test', customer_phone: `62200${String(1000 + n)}`, commune: 'Ratoma', address: 'Rue 1, près du marché', unit_price: 100000, own_product_name: 'Sac', pickup_detail: 'Chez moi', ...extra });
const place = async (s, extra = {}) => { const r = await s.post('/api/seller/orders', order(extra)); assert.equal(r.status, 201); return r.json; };
const rows = async (sql, p) => (await db.owner.query(sql, p)).rows;
const dayStr = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const walletTotals = async () => (await rows('SELECT count(*)::int AS n, COALESCE(sum(amount),0)::text AS t FROM wallet_entries'))[0];
let s, s2, courier, agent, chief;

before(async () => {
  db = await freshDb('wld_cco'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_cco', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
  s = await login(w.seller); s2 = await login(w.seller2); courier = await login(w.courier); agent = await login(w.agent1); chief = await login(w.chief);
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });


test('file d\'appel : la plus récente toujours en haut, même pour les escaladées', async () => {
  const a = await place(s), b = await place(s), c = await place(s);
  await new Promise((r) => setTimeout(r, 20));
  const refs = (await agent.get('/api/calls/queue')).json.orders.map((o) => o.id);
  assert.deepEqual(refs.slice(0, 3), [c.id, b.id, a.id]);
  await db.owner.query(`UPDATE orders SET escalated = true WHERE id = $1`, [a.id]);
  const chiefRefs = (await chief.get('/api/calls/queue')).json.orders.map((o) => o.id);
  assert.equal(chiefRefs[0], c.id, 'la plus récente reste en haut');
  assert.ok(chiefRefs.indexOf(a.id) > chiefRefs.indexOf(b.id), 'l\'escaladée garde son badge mais ne passe plus devant');
});

test('affectation : les nouvelles à affecter sont en haut', async () => {
  const x = await place(s), y = await place(s);
  await db.owner.query(`UPDATE orders SET status = 'confirmed', confirmed_at = now() - interval '2 hours' WHERE id = $1`, [x.id]);
  await db.owner.query(`UPDATE orders SET status = 'confirmed', confirmed_at = now() WHERE id = $1`, [y.id]);
  const ids = (await chief.get('/api/chief/orders')).json.orders.filter((o) => o.status === 'confirmed').map((o) => o.id);
  assert.ok(ids.indexOf(y.id) < ids.indexOf(x.id), 'la plus récente d\'abord');
});
