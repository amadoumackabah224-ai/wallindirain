// Inventaire physique (migration 032) : routes du magasinier et de l'administrateur.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, TEST_DB, APP_PW, world, approvedProduct, call, PNG } from './helpers.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';

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
  db = await freshDb('wld_invhttp'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  product = await approvedProduct(db, w, { price: 60000, qty: 50 });
  await call(db.app, 'fn_seller_set_price', w.seller, product, 120000);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_invhttp', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });


test('droits : routes d\'inventaire réservées (magasinier pour compter, administrateur pour décider)', async () => {
  const seller = await login(w.seller), wh = await login(w.warehouse), adm = await login(w.admin);
  assert.equal((await seller.post(`/api/warehouse/stock/${product}/count`, { counted: 5, note: 'non' })).status, 403);
  assert.equal((await seller.get('/api/admin/stock-counts')).status, 403);
  assert.equal((await wh.get('/api/admin/stock-counts')).status, 403);
  assert.equal((await wh.post('/api/admin/stock-counts/00000000-0000-0000-0000-0000000000aa/review', { approve: true })).status, 403);
  assert.equal((await adm.get('/api/admin/stock-counts')).status, 200);
});

test('parcours : le stock affiche l\'attendu, l\'écart sans explication est refusé, la décision corrige le stock', async () => {
  const wh = await login(w.warehouse), adm = await login(w.admin);
  const p = (await wh.get('/api/warehouse/stock')).json.products.find((x) => x.id === product);
  const base = p.stock_qty; assert.equal(p.expected_shelf, base); assert.equal(p.count_pending, false);
  const bad = await wh.post(`/api/warehouse/stock/${product}/count`, { counted: base - 3 });
  assert.equal(bad.status, 400); assert.equal(bad.json.error, 'note_required');
  assert.equal((await wh.post(`/api/warehouse/stock/${product}/count`, { counted: base - 3, note: '3 unités introuvables' })).status, 201);
  assert.equal((await wh.get('/api/warehouse/stock')).json.products.find((x) => x.id === product).count_pending, true);
  const list = (await adm.get('/api/admin/stock-counts')).json.counts;
  assert.equal(list.length, 1); assert.equal(list[0].status, 'pending'); assert.equal(list[0].delta, -3);
  assert.equal((await adm.post(`/api/admin/stock-counts/${list[0].id}/review`, { approve: true })).status, 200);
  assert.equal((await wh.get('/api/warehouse/stock')).json.products.find((x) => x.id === product).stock_qty, base - 3);
  const hist = (await wh.get('/api/warehouse/history')).json.counts;
  assert.equal(hist[0].status, 'approved'); assert.equal(hist[0].delta, -3);
});
