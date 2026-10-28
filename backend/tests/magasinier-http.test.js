// Espace magasinier (migration 031) : routes, droits, contenu des écrans, photos.
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
  db = await freshDb('wld_maghttp'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  product = await approvedProduct(db, w, { price: 60000, qty: 50 });
  await call(db.app, 'fn_seller_set_price', w.seller, product, 120000);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_maghttp', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });


const asB64 = (buf) => `data:image/png;base64,${buf.toString('base64')}`;
test('droits : seuls le magasinier et l\'administrateur accèdent aux routes de l\'entrepôt', async () => {
  const seller = await login(w.seller), courier = await login(w.courier);
  for (const p of ['/api/warehouse/arrivals', '/api/warehouse/stock', '/api/warehouse/history']) {
    assert.equal((await seller.get(p)).status, 403); assert.equal((await courier.get(p)).status, 403);
  }
  assert.equal((await seller.post('/api/warehouse/losses', { product_id: product, qty: 1, reason: 'lost', note: 'non' })).status, 403);
  assert.equal((await new Client().get('/api/warehouse/stock')).status, 401);
});

test('écrans : « à faire », stock et historique, sans donnée client ni donnée d\'argent', async () => {
  const wh = await login(w.warehouse);
  await call(db.app, 'fn_supplier_announce_arrival', w.supplier, product, 6);
  const o = await call(db.app, 'fn_seller_create_order', w.seller, product, null, null, 2, 'Cliente Secrète', '699000111', 'Kaloum', 'Rue Privée 9', null, false);
  await call(db.app, 'fn_agent_take_order', w.agent1, o.id); await call(db.app, 'fn_agent_log_call', w.agent1, o.id, 'confirmed', 'OK');
  await call(db.app, 'fn_chief_assign', w.chief, o.id, w.courier);
  const todo = await wh.get('/api/warehouse/arrivals');
  assert.equal(todo.status, 200);
  assert.equal(todo.json.arrivals.length, 1); assert.equal(todo.json.arrivals[0].supplier_name, 'Fournisseur Un');
  assert.equal(todo.json.handovers.length, 1); assert.equal(todo.json.handovers[0].qty, 2);
  const txt = JSON.stringify(todo.json) + JSON.stringify((await wh.get('/api/warehouse/history')).json) + JSON.stringify((await wh.get('/api/warehouse/stock')).json);
  assert.doesNotMatch(txt, /Cliente Secrète|699000111|Rue Privée|delivery_fee|seller_price|supplier_price|margin/);
  const p = (await wh.get('/api/warehouse/stock')).json.products.find((x) => x.id === product);
  assert.equal(p.reserved_qty, 2); assert.equal(p.free_qty, p.stock_qty - 2);
  assert.equal((await wh.post(`/api/warehouse/handovers/${o.id}`)).status, 200);
  assert.equal((await wh.post(`/api/warehouse/handovers/${o.id}`)).status, 409);
  assert.ok((await wh.get('/api/warehouse/arrivals')).json.handovers[0].handed_at);
  assert.equal((await wh.get('/api/warehouse/history')).json.handovers.length, 1);
});

test('comptage par l\'API : écart sans explication refusé (400), avec explication accepté', async () => {
  const wh = await login(w.warehouse);
  const a = (await wh.get('/api/warehouse/arrivals')).json.arrivals[0];
  const bad = await wh.post(`/api/warehouse/arrivals/${a.id}/count`, { counted: a.announced_qty - 1 });
  assert.equal(bad.status, 400); assert.equal(bad.json.error, 'note_required');
  assert.equal((await wh.post(`/api/warehouse/arrivals/${a.id}/count`, { counted: a.announced_qty - 1, note: 'Un colis manquant' })).status, 200);
  const h = (await wh.get('/api/warehouse/history')).json.arrivals[0];
  assert.equal(h.counted_qty, a.announced_qty - 1); assert.equal(h.count_note, 'Un colis manquant');
});

test('casse par l\'API puis retour avec note et photo : lecture de la photo selon le rôle', async () => {
  const wh = await login(w.warehouse);
  assert.equal((await wh.post('/api/warehouse/losses', { product_id: product, qty: 1, reason: 'expired', note: 'Date dépassée' })).status, 201);
  assert.equal((await wh.post('/api/warehouse/losses', { product_id: product, qty: 1, reason: 'bof', note: 'Motif faux' })).status, 400);
  assert.equal((await wh.get('/api/warehouse/history')).json.losses.length, 1);
  const o = await call(db.app, 'fn_seller_create_order', w.seller, product, null, null, 1, 'Client', '699000222', 'Kaloum', 'Rue 2', null, false);
  await call(db.app, 'fn_agent_take_order', w.agent1, o.id); await call(db.app, 'fn_agent_log_call', w.agent1, o.id, 'confirmed', 'OK');
  await call(db.app, 'fn_chief_assign', w.chief, o.id, w.courier); await call(db.app, 'fn_courier_pickup', w.courier, o.id);
  await call(db.app, 'fn_courier_fail', w.courier, o.id, 'customer_refusal'); await call(db.app, 'fn_chief_return_to_warehouse', w.chief, o.id);
  const ph = await wh.post(`/api/warehouse/returns/${o.id}/photos`, { image: asB64(Buffer.concat([PNG, Buffer.alloc(2000)])) });
  assert.equal(ph.status, 201);
  assert.equal((await wh.get('/api/warehouse/arrivals')).json.returns.find((x) => x.id === o.id).photo_ids.length, 1);
  assert.equal((await wh.post(`/api/warehouse/returns/${o.id}`, { cause: 'customer_refusal', note: 'Emballage déchiré' })).status, 200);
  const hist = (await wh.get('/api/warehouse/history')).json.returns.find((x) => x.id === o.id);
  assert.equal(hist.note, 'Emballage déchiré'); assert.equal(hist.photo_ids.length, 1);
  const sup = await login(w.supplier), sel = await login(w.seller);
  const url = `/api/return-photos/${ph.json.id}`;
  assert.equal((await wh.get(url)).status, 200); assert.equal((await sup.get(url)).status, 200); assert.equal((await sel.get(url)).status, 403);
});
