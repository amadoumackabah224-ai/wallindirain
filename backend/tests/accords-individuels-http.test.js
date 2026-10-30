// 036 : routes des accords individuels.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, TEST_DB, APP_PW, world, approvedProduct, call, deliver } from './helpers.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';

const PW = 'Secret123';
let db, w, product, srv, base;
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
  db = await freshDb('wld_accordhttp'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  product = await approvedProduct(db, w, { price: 60000, qty: 50 });
  await call(db.app, 'fn_seller_set_price', w.seller, product, 120000);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_accordhttp', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });



test('accords : lecture et écriture réservées à l\'administrateur ; accord livreur puis agent ; fin d\'accord', async () => {
  const adm = await login(w.admin), sel = await login(w.seller);
  assert.equal((await sel.get(`/api/admin/agreements/${w.agent1}`)).status, 403);
  assert.equal((await adm.get(`/api/admin/agreements/${w.seller}`)).status, 400);
  const g0 = (await adm.get(`/api/admin/agreements/${w.agent1}`)).json;
  assert.equal(g0.kind, 'agent'); assert.equal(g0.in_force, null); assert.equal(g0.common_pay, 1000);
  assert.equal((await adm.post(`/api/admin/agreements/${w.agent1}/agent`, { pay: 2500, note: 'Accord' })).status, 201);
  const g1 = (await adm.get(`/api/admin/agreements/${w.agent1}`)).json;
  assert.equal(Number(g1.in_force.pay_per_order), 2500); assert.equal(g1.terms.length, 1);
  assert.equal((await adm.post(`/api/admin/agreements/${w.agent1}/agent/end`, {})).status, 200);
  assert.equal((await adm.get(`/api/admin/agreements/${w.agent1}`)).json.in_force, null);
  // livreur indépendant : accord possible
  assert.equal((await adm.post(`/api/admin/agreements/${w.courier}/courier`, { per_delivery: 12000, tour_extra: 1000 })).status, 201);
  const gc = (await adm.get(`/api/admin/agreements/${w.courier}`)).json;
  assert.equal(gc.kind, 'courier'); assert.equal(Number(gc.in_force.per_delivery), 12000); assert.equal(gc.courier_kind, 'independent');
  assert.equal((await adm.get('/api/admin/courier-scales')).json.scales.length, 0);                // le barème commun reste vide
});
