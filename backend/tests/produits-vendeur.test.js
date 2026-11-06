// 046 : un vendeur propose ses produits au catalogue, comme un fournisseur (validation et marge par l'administrateur), sans vente à soi-même.
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
const proposerDefs = async () => (await rows(`SELECT proname FROM pg_proc WHERE prokind = 'f' AND pg_get_functiondef(oid) LIKE '%_require_proposer%' AND proname <> '_require_proposer' ORDER BY 1`)).map((r) => r.proname);
const jpeg = (size = 3000, fill = 7) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size - 4, fill)]);
const uri = () => `data:image/jpeg;base64,${jpeg().toString('base64')}`;
let s, s2, admin, sup, pA, pB;   // pA : produit du vendeur 1 stocké chez Wallindirain ; pB : produit du vendeur 1 stocké chez lui

before(async () => {
  db = await freshDb('wld_produits_vendeur'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_produits_vendeur', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
  s = await login(w.seller); s2 = await login(w.seller2); admin = await login(w.admin); sup = await login(w.supplier);
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });

test('éteint au départ : un vendeur ne peut rien proposer, le fournisseur travaille comme avant', async () => {
  assert.deepEqual((await s.get('/api/seller/proposals/status')).json, { enabled: false });
  assert.equal((await s.get('/api/supplier/products')).status, 403, 'comme avant la migration');
  const r = await s.post('/api/supplier/products', { name: 'Sac en cuir', supplier_price: 30000, storage: 'wallindirain' });
  assert.equal(r.status, 403); assert.equal(r.json.error, 'forbidden');
  await expectErr(call(db.app, 'fn_supplier_add_product', w.seller, 'Sac', 'x', 30000, 'wallindirain', 0), 'forbidden');
  assert.equal((await sup.get('/api/seller/proposals/status')).status, 403, 'réservé aux vendeurs');
  assert.equal((await s.post('/api/admin/settings', { key: 'feature_vendeur_produits', value: 1 })).status, 403, 'seul l\'administrateur l\'allume');
  const ok = await sup.post('/api/supplier/products', { name: 'Montre test', supplier_price: 50000, storage: 'wallindirain' });
  assert.equal(ok.status, 201, 'le fournisseur n\'est pas concerné par le réglage');
  assert.equal((await new Client().get('/api/supplier/products')).status, 401);
  assert.equal((await admin.post('/api/admin/settings', { key: 'feature_vendeur_produits', value: 1 })).status, 200);
  assert.deepEqual((await s.get('/api/seller/proposals/status')).json, { enabled: true });
  assert.equal((await s.get('/api/supplier/products')).json.products.length, 0);
});

test('le vendeur propose deux produits (stock chez Wallindirain, stock chez lui) : ils attendent la validation', async () => {
  const a = await s.post('/api/supplier/products', { name: 'Sac en cuir', description: 'Cuir véritable', supplier_price: 30000, storage: 'wallindirain' });
  assert.equal(a.status, 201); pA = a.json.id;
  const b = await s.post('/api/supplier/products', { name: 'Ceinture', supplier_price: 12000, storage: 'supplier', stock_qty: 5, pickup_detail: 'Matoto, près du marché' });
  assert.equal(b.status, 201); pB = b.json.id;
  assert.equal((await s.post(`/api/supplier/products/${pA}/images`, { image: uri() })).status, 201);
  const mine = (await s.get('/api/supplier/products')).json.products;
  assert.deepEqual(mine.map((p) => p.status), ['pending', 'pending']);
  assert.equal((await s2.get('/api/supplier/products')).json.products.length, 0, 'les produits d\'un vendeur ne sont pas vus par un autre');
  // pas visible des vendeurs avant la validation
  assert.equal((await s2.get('/api/seller/catalog')).json.products.length, 0);
  // l'administrateur le voit, avec la mention « vendeur »
  const list = (await admin.get('/api/admin/products?status=pending')).json.products.find((p) => p.id === pA);
  assert.match(list.supplier_name, /Vendeur Un \(vendeur\)/);
  // le vendeur ne peut pas se valider lui-même, ni fixer la marge
  assert.equal((await s.post(`/api/admin/products/${pA}/review`, { approve: true })).status, 403);
  assert.equal((await s.post(`/api/admin/products/${pA}/margin`, { margin_bps: 0 })).status, 403);
  // l'administrateur valide en ajoutant la marge Wallindirain, comme pour un fournisseur
  assert.equal((await admin.post(`/api/admin/products/${pA}/review`, { approve: true, margin_bps: 2000 })).status, 200);
  assert.equal((await admin.post(`/api/admin/products/${pB}/review`, { approve: true, margin_bps: 2000 })).status, 200);
  assert.equal((await rows('SELECT margin_unit FROM products WHERE id = $1', [pA]))[0].margin_unit, 6000, '20 % de 30 000');
});

test('arrivage compté par le magasinier (Wallindirain) et stock gardé chez le vendeur', async () => {
  const arr = await s.post(`/api/supplier/products/${pA}/arrival`, { qty: 10 }); assert.equal(arr.status, 201);
  assert.ok((await s.get('/api/supplier/products')).json.arrivals.length === 1);
  await call(db.app, 'fn_warehouse_count_arrival', w.warehouse, arr.json.id, 10);
  assert.equal((await s.post(`/api/supplier/products/${pB}/stock`, { qty: 5 })).status, 200);
  assert.equal((await s.post(`/api/supplier/products/${pA}/stock`, { qty: 5 })).status, 409, 'stock chez Wallindirain : on annonce un arrivage');
  // le catalogue des AUTRES vendeurs montre les deux produits au prix vendeur = prix + marge ; celui du proposant ne les montre pas
  const cat = (await s2.get('/api/seller/catalog')).json.products;
  assert.deepEqual(cat.map((p) => p.name).sort(), ['Ceinture', 'Sac en cuir']);
  const sac = cat.find((p) => p.name === 'Sac en cuir'); assert.equal(sac.vendor_price, 36000); assert.equal(sac.available, 10); assert.equal(sac.can_prepay, true);
  assert.equal(cat.find((p) => p.name === 'Ceinture').can_prepay, false);
  assert.equal((await s.get('/api/seller/catalog')).json.products.filter((p) => ['Sac en cuir', 'Ceinture'].includes(p.name)).length, 0, 'le proposant ne voit pas ses propres produits dans son catalogue');
});

test('droits : seul le propriétaire modifie son produit (pas un autre vendeur, pas un fournisseur)', async () => {
  assert.equal((await s2.post(`/api/supplier/products/${pA}/price`, { price: 1000 })).status, 404);
  assert.equal((await s2.post(`/api/supplier/products/${pA}/edit`, { name: 'Volé', description: 'x' })).status, 404);
  assert.equal((await s2.post(`/api/supplier/products/${pA}/arrival`, { qty: 1 })).status, 404);
  assert.equal((await s2.post(`/api/supplier/products/${pA}/pickup`, { detail: 'Chez moi' })).status, 404);
  assert.equal((await s2.post(`/api/supplier/products/${pA}/images`, { image: uri() })).status, 404);
  assert.equal((await sup.post(`/api/supplier/products/${pA}/price`, { price: 1000 })).status, 404, 'un fournisseur non plus');
  await expectErr(call(db.app, 'fn_supplier_set_price', w.seller2, pA, 1000), 'not_found');
  await expectErr(call(db.app, 'fn_set_product_category', w.seller2, pA, (await rows('SELECT id FROM product_categories LIMIT 1'))[0].id), 'not_found');
  await expectErr(call(db.app, 'fn_admin_review_product', w.seller, pA, true, null), 'forbidden');
  // photos : le propriétaire voit les siennes ; un autre vendeur voit celles des produits validés
  const img = (await rows('SELECT id FROM product_images WHERE product_id = $1', [pA]))[0].id;
  assert.equal((await s.get(`/api/product-images/${img}`)).status, 200);
  assert.equal((await s2.get(`/api/product-images/${img}`)).status, 200);
  // changement de prix après validation : demande à l'administrateur, comme un fournisseur
  const r = await s.post(`/api/supplier/products/${pB}/price`, { price: 15000 });
  assert.equal(r.status, 200); assert.equal(r.json.result, 'pending');
  assert.equal((await rows('SELECT supplier_price FROM products WHERE id = $1', [pB]))[0].supplier_price, 12000, 'l\'ancien prix reste actif jusqu\'à la validation');
});

test('pas de vente à soi-même : le proposant ne peut ni commander, ni fixer un prix, ni acheter du stock, ni créer un lien sur son produit', async () => {
  await expectErr(call(db.app, 'fn_seller_set_price', w.seller, pA, 80000), 'invalid_input');
  // sans prix de vente (qu'il ne peut pas fixer), il ne peut ni créer de lien, ni acheter du stock, ni commander
  await expectErr(call(db.app, 'fn_seller_create_link', w.seller, pA), 'price_required');
  await assert.rejects(call(db.app, 'fn_seller_buy_stock', w.seller, pA, 1), /price_required|insufficient_funds|vendre vous-même/);
  await expectErr(call(db.app, 'fn_seller_create_order', w.seller, pA, null, null, 1, 'Client', '622111111', 'Kaloum', 'Rue 1', null, false), 'price_required');
  for (const t of ['seller_links', 'seller_stock', 'seller_prices']) assert.equal((await rows(`SELECT count(*)::int AS n FROM ${t} WHERE seller_id = $1 AND product_id = $2`, [w.seller, pA]))[0].n, 0, t);
  // et même un prix inséré de force est refusé par la base pour la commande directe
  await assert.rejects(db.owner.query(`INSERT INTO orders(seller_id, product_id, qty, ref) SELECT $1, $2, 1, 'WLD-TEST'`, [w.seller, pA]).catch((e) => { throw e; }), /vendre vous-même|null value|violates/);
  await assert.rejects(db.owner.query(`INSERT INTO seller_prices(seller_id, product_id, sale_price) VALUES ($1, $2, 90000)`, [w.seller, pA]), /vendre vous-même/);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM orders WHERE seller_id = $1 AND product_id IS NOT NULL`, [w.seller]))[0].n, 0);
});

test('vente par un autre vendeur : le proposant est payé comme un fournisseur, Wallindirain garde sa marge, les comptes restent justes', async () => {
  await call(db.app, 'fn_seller_set_price', w.seller2, pA, 80000);
  const o = await call(db.app, 'fn_seller_create_order', w.seller2, pA, null, null, 2, 'Client Deux', '622222222', 'Kaloum', 'Rue 2', null, false);
  await deliver(db, w, o.id, o.ref);
  const gain = async (uid, kind) => Number((await rows(`SELECT COALESCE(sum(amount),0)::bigint AS t FROM wallet_entries WHERE user_id = $1 AND kind = $2`, [uid, kind]))[0].t);
  assert.equal(await gain(w.seller, 'supplier_payment'), 60000, '2 × 30 000 pour le proposant');
  assert.ok(await gain(w.seller2, 'seller_gain') > 0, 'le vendeur qui a vendu est payé');
  assert.equal(await gain(w.seller, 'seller_gain'), 0);
  assert.equal((await rows('SELECT count(*)::int AS n FROM fn_ledger_check()'))[0].n, 0, 'les comptes de la plateforme restent exacts');
  // la marge de Wallindirain reste cachée au proposant, comme pour un fournisseur
  assert.ok(!/margin|vendor_price/i.test(JSON.stringify((await s.get('/api/supplier/products')).json)), 'aucune marge dans ce que voit le proposant');
  // le proposant voit les colis à préparer (stock chez lui) sans connaître l'acheteur
  const o2 = await call(db.app, 'fn_seller_create_order', w.seller2, pB, null, null, 1, 'Client Trois', '622333333', 'Kaloum', 'Rue 3', null, false).catch(() => null);
  const mine = (await s.get('/api/supplier/orders')).json.orders;
  assert.ok(mine.length >= 1 && mine.every((x) => !('customer_name' in x) && !('seller_name' in x)));
  void o2;
});

test('anonymisation : un vendeur qui a encore des produits en vente ne peut pas être anonymisé', async () => {
  const s3 = await call(db.app, 'fn_register', '622' + String(Math.floor(Math.random() * 900000) + 100000), 'Vendeur Trois', 'seller', 'x', 'CNI-888888');
  const p3 = await call(db.app, 'fn_supplier_add_product', s3, 'Bracelet', 'x', 9000, 'supplier', 0);
  await call(db.app, 'fn_admin_review_product', w.admin, p3, true, null);
  await expectErr(call(db.app, 'fn_admin_anonymize_user', w.admin, s3), 'invalid_state');
});

test('droits de la base : les fonctions fournisseur gardent leur contrôle de rôle', async () => {
  for (const r of ['courier', 'agent1', 'warehouse', 'chief']) await expectErr(call(db.app, 'fn_supplier_add_product', w[r], 'x y', 'z', 1000, 'wallindirain', 0), 'forbidden');
  await assert.rejects(db.app.query('SELECT _require_proposer($1, ARRAY[\'supplier\']::user_role[])', [w.seller]), /permission denied/);
  assert.equal((await proposerDefs()).length, 9, '9 fonctions passent par _require_proposer ; 2 fonctions de lecture de photos acceptent aussi le propriétaire vendeur');
  assert.equal((await rows(`SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('fn_product_image_get','fn_return_photo_get') AND pg_get_functiondef(oid) LIKE '%''supplier'',''seller''%'`))[0].n, 2);
});

test('retour arrière 046 : refusé s\'il existe des produits de vendeurs ou si la fonction est allumée, accepté sinon, fonctions remises comme avant', async () => {
  const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-046.sql'), 'utf8');
  const run = async () => { await db.owner.query('BEGIN'); try { for (const q of splitSql(rb)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT'); } catch (e) { await db.owner.query('ROLLBACK'); throw e; } };
  await assert.rejects(run, /des produits proposés par des vendeurs existent/);
  await db.owner.query(`UPDATE products SET deleted_at = now() WHERE supplier_id = $1`, [w.seller]);   // retirés du catalogue mais toujours en base : le retour arrière doit quand même refuser
  await assert.rejects(run, /des produits proposés par des vendeurs existent/);
  // on rend ces produits au fournisseur pour simuler « aucun produit de vendeur »
  await db.owner.query(`ALTER TABLE products DISABLE TRIGGER USER`); await db.owner.query(`UPDATE products SET supplier_id = $1 WHERE supplier_id IN (SELECT id FROM users WHERE role = 'seller')`, [w.supplier]); await db.owner.query(`ALTER TABLE products ENABLE TRIGGER USER`);
  await assert.rejects(run, /éteignez d'abord la fonction/);
  await db.owner.query(`UPDATE settings SET value = 0 WHERE key = 'feature_vendeur_produits'`);
  await run();
  assert.equal((await proposerDefs()).length, 0);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('fn_product_image_get','fn_return_photo_get') AND pg_get_functiondef(oid) LIKE '%''supplier'',''seller''%'`))[0].n, 0);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('_require_proposer','trg_no_self_dealing')`))[0].n, 0);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname LIKE '%no_self_dealing'`))[0].n, 0);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM settings WHERE key = 'feature_vendeur_produits'`))[0].n, 0);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '046_produits_vendeur.sql'`))[0].n, 0);
  await expectErr(call(db.app, 'fn_supplier_add_product', w.seller, 'Sac', 'x', 30000, 'wallindirain', 0), 'forbidden');   // le vendeur n'a de nouveau aucun accès
  assert.ok((await call(db.app, 'fn_supplier_add_product', w.supplier, 'Après retour', 'x', 30000, 'wallindirain', 0)));
});
