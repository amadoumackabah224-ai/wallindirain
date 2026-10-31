// 041 : modification des produits et des prix (fournisseur, administrateur, vendeur).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshDb, TEST_DB, APP_PW, world, approvedProduct, call, expectErr } from './helpers.js';
import { splitSql } from '../src/migrate.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';

const PW = 'Secret123';
const root = path.resolve(import.meta.dirname, '..', '..');
let db, w, product, srv, base, n = 0;
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
const order = (extra = {}) => ({ request_key: `d${String(++n).padStart(3, '0')}`.padEnd(20, 'x'), qty: 2, customer_name: 'Client Test', customer_phone: `62100${String(1000 + n)}`, commune: 'Ratoma', address: 'Rue 1, près du marché', unit_price: 100000, own_product_name: 'Sac', pickup_detail: 'Chez moi', ...extra });
const dep = async (qty = 10, name = 'Sacs en cuir') => { const id = await call(db.app, 'fn_seller_announce_deposit', w.seller, name, qty); return id; };
const row = async (id) => (await db.owner.query('SELECT * FROM seller_deposits WHERE id = $1', [id])).rows[0];
const gain = async (orderId) => Number((await db.owner.query(`SELECT COALESCE(sum(amount),0) AS g FROM wallet_entries WHERE order_id = $1 AND user_id = $2 AND kind = 'seller_gain'`, [orderId, w.seller])).rows[0].g);

before(async () => {
  db = await freshDb('wld_modif'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  product = await approvedProduct(db, w, { price: 60000, qty: 5 });
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_modif', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });

const prod = async (extra = {}) => { const id = await approvedProduct(db, w, { price: 60000, qty: 10, ...extra }); await call(db.app, 'fn_seller_set_price', w.seller, id, 200000); return id; };
const P = async (id) => (await db.owner.query('SELECT supplier_price, margin_unit, name, description FROM products WHERE id = $1', [id])).rows[0];

test('fournisseur : description immédiate, renommage d\'un produit validé soumis à l\'administrateur ; un autre compte ne peut pas', async () => {
  const id = await prod();
  assert.equal(await call(db.app, 'fn_supplier_edit_product', w.supplier, id, (await P(id)).name, 'Cuir véritable'), 'applied');   // même nom : tout de suite
  assert.equal((await P(id)).description, 'Cuir véritable');
  const old = (await P(id)).name;
  const s = await login(w.supplier);
  const r = await s.post(`/api/supplier/products/${id}/edit`, { name: 'Sac en cuir noir', description: 'Cuir noir' });
  assert.equal(r.status, 200); assert.equal(r.json.result, 'pending');
  assert.deepEqual([(await P(id)).name, (await P(id)).description], [old, 'Cuir noir']);              // l'ancien nom reste, la description est déjà à jour
  assert.equal((await s.get('/api/supplier/products')).json.products.find((x) => x.id === id).name_request, 'Sac en cuir noir');
  await expectErr(call(db.app, 'fn_supplier_edit_product', w.seller, id, 'Piraté', null), 'forbidden');
  await expectErr(call(db.app, 'fn_supplier_edit_product', w.supplier, id, 'x', null), 'invalid_input');
  const adm = await login(w.admin);
  const req = (await adm.get('/api/admin/name-requests')).json.name_requests.find((x) => x.new_name === 'Sac en cuir noir');
  await expectErr(call(db.app, 'fn_admin_review_name_change', w.supplier, req.id, true), 'forbidden');
  assert.equal((await adm.post(`/api/admin/name-requests/${req.id}/review`, { approve: true })).status, 200);
  assert.equal((await P(id)).name, 'Sac en cuir noir');
  await expectErr(call(db.app, 'fn_admin_review_name_change', w.admin, req.id, true), 'invalid_state');
  // refus : le nom reste ; demande remplacée par la suivante
  await call(db.app, 'fn_supplier_edit_product', w.supplier, id, 'Nom A', null);
  await call(db.app, 'fn_supplier_edit_product', w.supplier, id, 'Nom B', null);
  const pend = (await db.owner.query(`SELECT id, new_name FROM product_name_changes WHERE product_id = $1 AND status = 'pending'`, [id])).rows;
  assert.deepEqual(pend.map((x) => x.new_name), ['Nom B']);
  await call(db.app, 'fn_admin_review_name_change', w.admin, pend[0].id, false, 'Nom trompeur');
  assert.equal((await P(id)).name, 'Sac en cuir noir');
  // produit non validé : renommage immédiat ; administrateur : direct
  const nv = await call(db.app, 'fn_supplier_add_product', w.supplier, 'Brouillon', null, 50000, 'wallindirain', 0, null);
  assert.equal(await call(db.app, 'fn_supplier_edit_product', w.supplier, nv, 'Brouillon 2', null), 'applied');
  assert.equal((await P(nv)).name, 'Brouillon 2');
  await call(db.app, 'fn_admin_edit_product', w.admin, id, 'Sac cuir noir', null);
  assert.equal((await P(id)).name, 'Sac cuir noir');
});

test('prix : demande après validation, ancien prix actif, acceptation avec marge recalculée, commandes déjà créées inchangées', async () => {
  const id = await prod();
  const before = await P(id);
  const s = await login(w.supplier);
  const r = await s.post(`/api/supplier/products/${id}/price`, { price: 80000 });
  assert.equal(r.status, 200); assert.equal(r.json.result, 'pending');
  assert.equal(Number((await P(id)).supplier_price), Number(before.supplier_price));                  // l'ancien prix reste actif
  const list = (await s.get('/api/supplier/products')).json.products.find((x) => x.id === id);
  assert.equal(Number(list.price_request.new_price), 80000);
  // une commande créée avant le changement garde son prix ; on la termine pour lever le verrou
  const o = await call(db.app, 'fn_seller_create_order', w.seller, id, null, null, 1, 'Client', '621000555', 'Kaloum', 'Rue 1', null, false);
  await call(db.app, 'fn_staff_cancel_order', w.chief, o.id, 'Test');
  const adm = await login(w.admin);
  const reqs = (await adm.get('/api/admin/price-requests')).json.requests;
  const req = reqs.find((x) => x.product_id === id && x.status === 'pending');
  assert.equal(Number(req.new_price), 80000);
  await expectErr(call(db.app, 'fn_admin_review_price_change', w.supplier, req.id, true), 'forbidden');
  assert.equal((await adm.post(`/api/admin/price-requests/${req.id}/review`, { approve: true })).status, 200);
  const after = await P(id);
  assert.equal(Number(after.supplier_price), 80000);
  assert.equal(Number(after.margin_unit), Number((await db.owner.query('SELECT _margin_for(80000) AS m')).rows[0].m));   // marge recalculée comme à la validation
  const snap = (await db.owner.query('SELECT supplier_unit_price FROM orders WHERE id = $1', [o.id])).rows[0].supplier_unit_price;
  assert.equal(Number(snap), Number(before.supplier_price));                                                        // l'ancienne commande garde son prix
  await expectErr(call(db.app, 'fn_admin_review_price_change', w.admin, req.id, true), 'invalid_state');            // déjà traitée
});

test('prix : refus, demande remplacée, verrou si commande en cours, prix immédiat avant validation, admin direct', async () => {
  const id = await prod();
  const before = Number((await P(id)).supplier_price);
  await call(db.app, 'fn_supplier_set_price', w.supplier, id, 70000);
  await call(db.app, 'fn_supplier_set_price', w.supplier, id, 75000);                                             // remplace la précédente
  const rows = (await db.owner.query(`SELECT new_price, status FROM product_price_changes WHERE product_id = $1 ORDER BY created_at`, [id])).rows;
  assert.deepEqual(rows.map((x) => [Number(x.new_price), x.status]), [[70000, 'rejected'], [75000, 'pending']]);
  await expectErr(call(db.app, 'fn_supplier_set_price', w.supplier, id, before), 'invalid_input');                  // même prix
  const req = (await db.owner.query(`SELECT id FROM product_price_changes WHERE product_id = $1 AND status = 'pending'`, [id])).rows[0].id;
  // commande en cours : l'acceptation est verrouillée
  const o = await call(db.app, 'fn_seller_create_order', w.seller, id, null, null, 1, 'Client', '621000556', 'Kaloum', 'Rue 1', null, false);
  await expectErr(call(db.app, 'fn_admin_review_price_change', w.admin, req, true), 'price_locked');
  await expectErr(call(db.app, 'fn_admin_set_product_price', w.admin, id, 90000), 'price_locked');
  await call(db.app, 'fn_admin_review_price_change', w.admin, req, false, null, 'Trop haut');
  assert.equal(Number((await P(id)).supplier_price), before);
  await call(db.app, 'fn_staff_cancel_order', w.chief, o.id, 'Test');
  await call(db.app, 'fn_admin_set_product_price', w.admin, id, 65000, 1200);
  const p = await P(id); assert.equal(Number(p.supplier_price), 65000); assert.equal(Number(p.margin_unit), 7800);   // 65000 x 12 %
  // produit non validé : le prix change tout de suite
  const pend = (await call(db.app, 'fn_supplier_add_product', w.supplier, 'Nouveau', null, 50000, 'wallindirain', 0, null));
  assert.equal(await call(db.app, 'fn_supplier_set_price', w.supplier, pend, 45000), 'applied');
  assert.equal(Number((await P(pend)).supplier_price), 45000);
  assert.equal((await db.owner.query('SELECT count(*)::int AS n FROM fn_ledger_check()')).rows[0].n, 0);
});

test('vendeur : corrige son dépôt avant le comptage seulement', async () => {
  const id = await call(db.app, 'fn_seller_announce_deposit', w.seller, 'Sacs', 5);
  const s = await login(w.seller);
  assert.equal((await s.post(`/api/seller/deposits/${id}/edit`, { name: 'Sacs rouges', qty: 6 })).status, 200);
  const d = (await db.owner.query('SELECT name, announced_qty FROM seller_deposits WHERE id = $1', [id])).rows[0];
  assert.deepEqual([d.name, d.announced_qty], ['Sacs rouges', 6]);
  await call(db.app, 'fn_warehouse_count_deposit', w.warehouse, id, 6);
  assert.equal((await s.post(`/api/seller/deposits/${id}/edit`, { name: 'X', qty: 1 })).status, 400);
  await expectErr(call(db.app, 'fn_seller_edit_deposit', w.supplier, id, 'Pirate', 1), 'forbidden');
});

test('retour arrière 041 : refusé s\'il existe des demandes, accepté sinon', async () => {
  const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-042.sql'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'docs', 'retour-arriere-041.sql'), 'utf8');   // la 042 d\'abord
  const run = async () => { await db.owner.query('BEGIN'); try { for (const q of splitSql(rb)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT'); } catch (e) { await db.owner.query('ROLLBACK'); throw e; } };
  await assert.rejects(run, /demandes de changement de nom/);
  await db.owner.query('DELETE FROM product_price_changes'); await db.owner.query('DELETE FROM product_name_changes');
  await run();
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'product_price_changes'`)).rows[0].n, 0);
});
