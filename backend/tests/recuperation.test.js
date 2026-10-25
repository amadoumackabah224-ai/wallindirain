// Étape 5 : lieu de récupération du colis (migration 022) — information seulement, l'adresse du fournisseur reste cachée au vendeur.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshDb, TEST_DB, APP_PW, world, approvedProduct, call, expectErr } from './helpers.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';
import { splitSql, migrate } from '../src/migrate.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PW = 'Secret123';
let db, w, wh, sup, srv, base, n = 0, k = 0;
const count = async (sql, p = []) => Number((await db.owner.query(sql, p)).rows[0].n);
const phone = () => `6${String(++n).padStart(8, '0')}`;
const mk = (product, own = null) => call(db.app, 'fn_seller_create_order_once', w.seller, `pickup-test-key-${String(++k).padStart(8, '0')}`, own ? null : product, own, own ? 40000 : null, 1, 'Client Test', phone(), 'Kaloum', 'Rue 1 Kaloum', null, true);
const pick = async (id) => (await db.owner.query('SELECT pickup_detail FROM orders WHERE id = $1', [id])).rows[0].pickup_detail;

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
  db = await freshDb('wld_recup'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  wh = await approvedProduct(db, w, { price: 60000, qty: 50 });                                         // stock chez Wallindirain
  sup = await approvedProduct(db, w, { price: 60000, qty: 50, storage: 'supplier' });                   // stock chez le fournisseur
  for (const p of [wh, sup]) await call(db.app, 'fn_seller_set_price', w.seller, p, 120000);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_recup', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });

test('fournisseur : adresse de récupération (produit gardé chez lui), modifiable, effaçable, réservée au propriétaire', async () => {
  await call(db.app, 'fn_supplier_set_pickup', w.supplier, sup, '  Matoto, derrière le marché, tél 622000000 ');
  assert.equal((await db.owner.query('SELECT pickup_detail FROM products WHERE id = $1', [sup])).rows[0].pickup_detail, 'Matoto, derrière le marché, tél 622000000');
  await expectErr(call(db.app, 'fn_supplier_set_pickup', w.supplier, sup, 'ab'), 'invalid_input');
  await expectErr(call(db.app, 'fn_supplier_set_pickup', w.supplier, sup, 'x'.repeat(201)), 'invalid_input');
  await expectErr(call(db.app, 'fn_supplier_set_pickup', w.supplier, wh, 'Quelque part'), 'not_found');            // produit chez Wallindirain : pas d'adresse à saisir
  await expectErr(call(db.app, 'fn_supplier_set_pickup', w.supplier, '00000000-0000-0000-0000-000000000009', 'Quelque part'), 'not_found');
  for (const actor of [w.seller, w.chief, w.courier, w.admin]) await expectErr(call(db.app, 'fn_supplier_set_pickup', actor, sup, 'Quelque part'), 'forbidden');
  await call(db.app, 'fn_supplier_set_pickup', w.supplier, sup, null);
  assert.equal((await db.owner.query('SELECT pickup_detail FROM products WHERE id = $1', [sup])).rows[0].pickup_detail, null);
  await call(db.app, 'fn_supplier_set_pickup', w.supplier, sup, 'Matoto, derrière le marché');
});

test('vendeur : lieu de récupération de son propre produit, seulement avant le départ du colis, seulement pour ses commandes', async () => {
  const own = await mk(null, 'Crème maison'); const cat = await mk(wh);
  await call(db.app, 'fn_seller_set_pickup', w.seller, own.id, ' Kaloum, près de la poste ');
  assert.equal(await pick(own.id), 'Kaloum, près de la poste');
  await expectErr(call(db.app, 'fn_seller_set_pickup', w.seller, own.id, ''), 'invalid_input');
  await expectErr(call(db.app, 'fn_seller_set_pickup', w.seller, own.id, 'ab'), 'invalid_input');
  await expectErr(call(db.app, 'fn_seller_set_pickup', w.seller, cat.id, 'Chez moi'), 'invalid_state');            // produit du catalogue : lieu imposé par le stock
  await expectErr(call(db.app, 'fn_seller_set_pickup', w.seller2, own.id, 'Chez moi'), 'not_found');               // pas sa commande
  for (const actor of [w.supplier, w.chief, w.courier]) await expectErr(call(db.app, 'fn_seller_set_pickup', actor, own.id, 'Chez moi'), 'forbidden');
  await call(db.app, 'fn_chief_assign', w.chief, own.id, w.courier); await call(db.app, 'fn_courier_pickup', w.courier, own.id);
  await expectErr(call(db.app, 'fn_seller_set_pickup', w.seller, own.id, 'Ailleurs'), 'invalid_state');            // le colis est parti
  assert.equal(await pick(own.id), 'Kaloum, près de la poste');
});

test('HTTP : produit propre = lieu obligatoire ; le livreur et le chef voient l\'adresse du fournisseur, le vendeur ne la voit jamais', async () => {
  const seller = await login(w.seller), supplier = await login(w.supplier), chief = await login(w.chief), cou = await login(w.courier);
  const base0 = { request_key: 'cle-recup-http-0001', qty: 1, customer_name: 'Client', customer_phone: phone(), commune: 'Kaloum', address: 'Rue 2 Kaloum', already_confirmed: true };
  const sans = await seller.post('/api/seller/orders', { ...base0, own_product_name: 'Savon maison', unit_price: 40000 });
  assert.equal(sans.status, 400); assert.equal(await count(`SELECT count(*)::int AS n FROM orders WHERE own_product_name = 'Savon maison'`), 0);   // refusé avant toute création
  const ownOrder = await seller.post('/api/seller/orders', { ...base0, own_product_name: 'Savon maison', unit_price: 40000, pickup_detail: 'Dixinn, face à la pharmacie' });
  assert.equal(ownOrder.status, 201); assert.equal(await pick(ownOrder.json.id), 'Dixinn, face à la pharmacie');
  const rejeu = await seller.post('/api/seller/orders', { ...base0, own_product_name: 'Savon maison', unit_price: 40000, pickup_detail: 'Dixinn, face à la pharmacie' });
  assert.equal(rejeu.status, 200); assert.equal(await count(`SELECT count(*)::int AS n FROM orders WHERE own_product_name = 'Savon maison'`), 1);
  assert.equal((await seller.post(`/api/seller/orders/${ownOrder.json.id}/pickup`, { detail: 'Dixinn, rue 5' })).status, 200);
  assert.equal((await seller.post(`/api/seller/orders/${ownOrder.json.id}/pickup`, { detail: '' })).status, 400);
  assert.equal((await cou.post(`/api/seller/orders/${ownOrder.json.id}/pickup`, { detail: 'Dixinn, rue 5' })).status, 403);
  // produit du fournisseur : adresse saisie par le fournisseur (HTTP)
  assert.equal((await supplier.post(`/api/supplier/products/${sup}/pickup`, { detail: 'Matoto, derrière le marché' })).status, 200);
  assert.equal((await seller.post(`/api/supplier/products/${sup}/pickup`, { detail: 'x y z' })).status, 403);
  assert.equal((await supplier.get('/api/supplier/products')).json.products.find((p) => p.id === sup).pickup_detail, 'Matoto, derrière le marché');
  const supOrder = await mk(sup); const whOrder = await mk(wh);
  for (const o of [supOrder, whOrder, ownOrder.json]) await call(db.app, 'fn_chief_assign', w.chief, o.id, w.courier);
  const find = (list, id) => list.find((o) => o.id === id);
  const c = (await cou.get('/api/courier/orders')).json.orders;
  assert.deepEqual([find(c, supOrder.id).pickup_place, find(c, supOrder.id).pickup_detail], ['supplier', 'Matoto, derrière le marché']);
  assert.deepEqual([find(c, whOrder.id).pickup_place, find(c, whOrder.id).pickup_detail], ['warehouse', null]);
  assert.equal(find(c, whOrder.id).pickup_missing, false);
  assert.deepEqual([find(c, ownOrder.json.id).pickup_place, find(c, ownOrder.json.id).pickup_detail], ['seller', 'Dixinn, rue 5']);
  const ch = (await chief.get('/api/chief/orders')).json.orders;
  assert.equal(find(ch, supOrder.id).pickup_detail, 'Matoto, derrière le marché');
  const so = (await seller.get('/api/seller/orders')).json.orders;                                                  // le vendeur ne voit jamais l'adresse du fournisseur
  assert.equal(find(so, supOrder.id).pickup_place, 'supplier'); assert.equal(find(so, supOrder.id).pickup_detail, null);
  assert.equal(find(so, ownOrder.json.id).pickup_detail, 'Dixinn, rue 5');
  assert.doesNotMatch(JSON.stringify(so), /Matoto/);
  await call(db.app, 'fn_supplier_set_pickup', w.supplier, sup, null);                                              // adresse effacée : signalée comme manquante au livreur
  assert.equal(find((await cou.get('/api/courier/orders')).json.orders, supOrder.id).pickup_missing, true);
});

test('aucun effet sur l\'argent : mêmes écritures, aucun réglage modifié ; droits SQL corrects', async () => {
  assert.equal(await count('SELECT count(*)::int AS n FROM fn_ledger_check()'), 0);
  for (const f of ['fn_seller_set_pickup', 'fn_supplier_set_pickup']) {
    const r = (await db.owner.query(`SELECT prosecdef, proconfig::text AS c, has_function_privilege('wld_app', oid, 'EXECUTE') AS e FROM pg_proc WHERE proname = $1`, [f])).rows[0];
    assert.equal(r.prosecdef, true); assert.match(r.c, /search_path=public, pg_temp/); assert.equal(r.e, true);
  }
  await assert.rejects(db.app.query(`UPDATE orders SET pickup_detail = 'x'`), /permission denied/);
  await assert.rejects(db.app.query(`UPDATE products SET pickup_detail = 'x'`), /permission denied/);
});

test('retour arrière 022 : retire les colonnes et fonctions, rien d\'autre ; migration rejouable', async () => {
  const snap = async () => (await db.owner.query(`SELECT (SELECT count(*) FROM wallet_entries)::text AS ecr, (SELECT count(*) FROM orders)::text AS cmd,
     (SELECT md5(string_agg(key || value::text, ',' ORDER BY key)) FROM settings) AS s,
     (SELECT string_agg(p.proname || ':' || md5(pg_get_functiondef(p.oid)) || ':' || COALESCE(p.proacl::text, ''), E'\\n' ORDER BY p.proname, p.oid::text) FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND p.proname NOT IN ('fn_seller_set_pickup','fn_supplier_set_pickup')) AS fonctions`)).rows[0];
  const before = await snap();
  const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-022.sql'), 'utf8');
  await db.owner.query('BEGIN');
  for (const s of splitSql(rb)) { if (/^(begin|commit)$/i.test(s.trim())) continue; await db.owner.query(s); }
  await db.owner.query('COMMIT');
  assert.deepEqual(await snap(), before);
  assert.equal(await count(`SELECT (SELECT count(*) FROM information_schema.columns WHERE column_name = 'pickup_detail')
     + (SELECT count(*) FROM schema_migrations WHERE name = '022_lieu_recuperation.sql') AS n`), 0);
  await migrate({ ...TEST_DB, database: 'wld_recup' }, APP_PW, () => {});
  assert.equal(await count(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '022_lieu_recuperation.sql'`), 1);
});
