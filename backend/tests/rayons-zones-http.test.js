// 035 : routes des rayons et des zones classées.
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
  db = await freshDb('wld_rayhttp'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  product = await approvedProduct(db, w, { price: 60000, qty: 50 });
  await call(db.app, 'fn_seller_set_price', w.seller, product, 120000);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_rayhttp', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });



test('rayons : le fournisseur range son produit, le vendeur voit le rayon, l\'admin gère les rayons', async () => {
  const sup = await login(w.supplier), sel = await login(w.seller), adm = await login(w.admin);
  const cats = (await sup.get('/api/supplier/products')).json.categories;
  assert.equal(cats.length, 6);
  const bebe = cats.find((c) => c.name === 'Bébé et enfant').id;
  const r = await sup.post('/api/supplier/products', { name: 'Lit bébé', supplier_price: 80000, storage: 'supplier', stock_qty: 2, category_id: bebe });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal((await sup.post('/api/supplier/products', { name: 'Lit bébé 2', supplier_price: 80000, storage: 'supplier', stock_qty: 2, category_id: 'pas-un-id' })).status, 400);
  assert.equal((await sel.post('/api/admin/categories', { name: 'Jouets' })).status, 403);
  const c = await adm.post('/api/admin/categories', { name: 'Jouets', position: 20 });
  assert.equal(c.status, 200); assert.ok(c.json.id);
  const list = (await adm.get('/api/admin/settings')).json;
  assert.ok(list.categories.some((x) => x.name === 'Jouets'));
  assert.equal(list.categories.find((x) => x.name === 'Bébé et enfant').products, 1);
  const cat = (await sel.get('/api/seller/catalog')).json;
  assert.ok(cat.categories.some((x) => x.name === 'Bébé et enfant'));
  assert.ok(cat.products.every((p) => 'category_id' in p));
  assert.equal((await sup.post(`/api/supplier/products/${r.json.id}/category`, { category_id: c.json.id })).status, 200);
});

test('zones : la liste publique donne nature, commune et gare ; l\'admin classe et applique le tarif de la commune', async () => {
  const adm = await login(w.admin), sel = await login(w.seller);
  const info = (await new Client().get('/api/public/info')).json;
  assert.ok(info.communes.every((z) => 'kind' in z && 'parent' in z));
  assert.ok(!info.communes.some((z) => z.commune === 'Kipé'));                                   // pas encore de tarif : non proposé
  assert.equal((await sel.post('/api/admin/zones/use-commune-fee', { commune: 'Ratoma' })).status, 403);
  const u = await adm.post('/api/admin/zones/use-commune-fee', { commune: 'Ratoma' });
  assert.equal(u.status, 200); assert.ok(u.json.activated >= 10);
  const info2 = (await new Client().get('/api/public/info')).json;
  const kipe = info2.communes.find((z) => z.commune === 'Kipé');
  assert.equal(kipe.parent, 'Ratoma'); assert.equal(Number(kipe.fee), 30000);
  assert.equal((await adm.post('/api/admin/zones/classify', { zone: 'Labé', kind: 'ville', pickup_point: 'Gare voiture de Labé' })).status, 200);
  assert.equal((await adm.post('/api/admin/zones/classify', { zone: 'Labé', kind: 'nimporte' })).status, 400);
  assert.equal((await adm.post('/api/admin/zones/classify', { zone: 'Km 36', kind: 'quartier', parent: 'Labé' })).status, 400);
  const rates = (await adm.get('/api/admin/settings')).json.rates;
  assert.equal(rates.find((z) => z.commune === 'Labé').pickup_point, 'Gare voiture de Labé');
});
