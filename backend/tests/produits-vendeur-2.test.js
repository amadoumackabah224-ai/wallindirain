// 047 : le propriétaire d'un produit proposé le partage ET le vend lui-même, sur un seul stock ; suspension, retrait, restitution de stock.
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
  db = await freshDb('wld_produits_vendeur2'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_produits_vendeur2', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
  s = await login(w.seller); s2 = await login(w.seller2); admin = await login(w.admin); sup = await login(w.supplier);
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });

const phone = () => `62290${String(1000 + ++n)}`;
const rowsOf = rows;
let pn = 0;
/** produit du vendeur 1, validé (marge 20 %), avec `qty` unités comptées chez Wallindirain ; ou stock gardé chez lui */
const mk = async (storage = 'wallindirain', qty = 10, price = 30000) => {
  const id = await call(db.app, 'fn_supplier_add_product', w.seller, `Produit 047-${++pn}`, 'x', price, storage, storage === 'supplier' ? qty : 0);
  await call(db.app, 'fn_admin_review_product', w.admin, id, true, 2000);
  if (storage === 'wallindirain' && qty > 0) { const arr = await call(db.app, 'fn_supplier_announce_arrival', w.seller, id, qty); await call(db.app, 'fn_warehouse_count_arrival', w.warehouse, arr, qty); }
  return id;
};
const buy = (seller, p, qty = 1) => call(db.app, 'fn_seller_create_order', seller, p, null, null, qty, 'Client Test', phone(), 'Kaloum', 'Rue 1', null, false);
const prod = async (id) => (await rowsOf('SELECT stock_qty, reserved_qty, paused_at, retired_at FROM products WHERE id = $1', [id]))[0];
const bal = async (uid, kind) => Number((await rowsOf(`SELECT COALESCE(sum(amount),0)::bigint AS t FROM wallet_entries WHERE user_id = $1 AND kind = $2`, [uid, kind]))[0].t);
const ledgerOk = async () => assert.equal((await rowsOf('SELECT count(*)::int AS n FROM fn_ledger_check()'))[0].n, 0, 'les comptes de la plateforme restent exacts');

test('mise en route : fonction allumée', async () => {
  assert.equal((await admin.post('/api/admin/settings', { key: 'feature_vendeur_produits', value: 1 })).status, 200);
});

test('le propriétaire vend lui-même son produit : marge Wallindirain à 0 sur cette commande, comptes justes, autres ventes inchangées', async () => {
  const p = await mk('wallindirain', 10);
  await call(db.app, 'fn_seller_set_price', w.seller, p, 100000);
  await call(db.app, 'fn_seller_set_price', w.seller2, p, 100000);
  const mineCat = (await s.get('/api/seller/catalog')).json.products.find((x) => x.id === p);
  const otherCat = (await s2.get('/api/seller/catalog')).json.products.find((x) => x.id === p);
  assert.equal(mineCat.mine, true); assert.equal(otherCat.mine, false);
  assert.equal(otherCat.min_price - mineCat.min_price, 6000, 'le minimum du propriétaire ne contient pas la marge');
  assert.equal(mineCat.vendor_price, 30000); assert.equal(otherCat.vendor_price, 36000);
  assert.equal(mineCat.can_prepay, false);
  await expectErr(call(db.app, 'fn_seller_set_price', w.seller, p, 20000), 'price_below_minimum');

  const o1 = await buy(w.seller, p, 2);
  const o2 = await buy(w.seller2, p, 1);
  const m = async (id) => (await rowsOf('SELECT margin_unit, supplier_unit_price, seller_unit_price FROM orders WHERE id = $1', [id]))[0];
  assert.equal(Number((await m(o1.id)).margin_unit), 0); assert.equal(Number((await m(o1.id)).seller_unit_price), 30000);
  assert.equal(Number((await m(o2.id)).margin_unit), 6000, 'vente d\'un autre vendeur : marge inchangée');
  assert.deepEqual(await prod(p), { stock_qty: 10, reserved_qty: 3, paused_at: null, retired_at: null }, 'un seul stock partagé');
  await deliver(db, w, o1.id, o1.ref); await deliver(db, w, o2.id, o2.ref);
  assert.equal(await bal(w.seller, 'supplier_payment'), 3 * 30000, 'le propriétaire reçoit son prix sur toutes les unités vendues (2 par lui, 1 par un autre vendeur)');
  assert.ok(await bal(w.seller, 'seller_gain') > 0);
  assert.equal(await bal(w.seller2, 'supplier_payment'), 0);
  await ledgerOk();
  assert.deepEqual(await prod(p), { stock_qty: 7, reserved_qty: 0, paused_at: null, retired_at: null });
  // chiffres vus par le propriétaire : aucune identité d'acheteur, aucune marge
  const mine = (await s.get('/api/supplier/products')).json.products.find((x) => x.id === p);
  assert.equal(mine.sold_qty, 3); assert.equal(mine.sold_by_others, 1); assert.equal(mine.in_progress_qty, 0);
  assert.ok(!/margin|vendor_price/i.test(JSON.stringify(mine)));
});

test('stock partagé : le propriétaire et les autres vendeurs ne peuvent jamais vendre plus que le stock', async () => {
  const p = await mk('wallindirain', 3);
  await call(db.app, 'fn_seller_set_price', w.seller, p, 100000); await call(db.app, 'fn_seller_set_price', w.seller2, p, 100000);
  await buy(w.seller, p, 2);
  await expectErr(buy(w.seller2, p, 2), 'out_of_stock');
  await buy(w.seller2, p, 1);
  await expectErr(buy(w.seller, p, 1), 'out_of_stock');
  assert.deepEqual(await prod(p), { stock_qty: 3, reserved_qty: 3, paused_at: null, retired_at: null });
});

test('suspension : les autres vendeurs ne commandent plus, le propriétaire continue, les commandes prises sont conservées', async () => {
  const p = await mk('wallindirain', 10);
  await call(db.app, 'fn_seller_set_price', w.seller, p, 100000); await call(db.app, 'fn_seller_set_price', w.seller2, p, 100000);
  const before = await buy(w.seller2, p, 2);
  assert.equal((await s.post(`/api/supplier/products/${p}/pause`, { paused: true, note: 'Rupture chez mon fournisseur' })).status, 200);
  assert.equal((await s2.get('/api/seller/catalog')).json.products.some((x) => x.id === p), false, 'plus dans le catalogue des autres');
  assert.equal((await s.get('/api/seller/catalog')).json.products.find((x) => x.id === p).available, 8, 'le propriétaire le voit toujours');
  await expectErr(buy(w.seller2, p, 1), 'out_of_stock');
  await expectErr(call(db.app, 'fn_seller_buy_stock', w.seller2, p, 1), 'out_of_stock');
  await buy(w.seller, p, 1);
  assert.equal((await rowsOf('SELECT status FROM orders WHERE id = $1', [before.id]))[0].status, 'new', 'la commande déjà prise n\'est pas annulée');
  assert.equal((await prod(p)).reserved_qty, 3);
  const listed = (await s.get('/api/supplier/products')).json.products.find((x) => x.id === p);
  assert.ok(listed.paused_at); assert.equal(listed.availability_note, 'Rupture chez mon fournisseur');
  // un vendeur qui avait déjà acheté du stock à l'avance peut encore le vendre
  await db.owner.query(`UPDATE products SET stock_qty = stock_qty - 2 WHERE id = $1`, [p]);
  await db.owner.query(`INSERT INTO seller_stock(seller_id, product_id, qty) VALUES ($1, $2, 2)`, [w.seller2, p]);
  const pre = await buy(w.seller2, p, 1);
  assert.ok(pre.id, 'stock prépayé encore vendable malgré la suspension');
  // reprise
  assert.equal((await s.post(`/api/supplier/products/${p}/pause`, { paused: false })).status, 200);
  await buy(w.seller2, p, 1);
  assert.equal((await rowsOf('SELECT paused_at FROM products WHERE id = $1', [p]))[0].paused_at, null);
  assert.equal((await s2.post(`/api/supplier/products/${p}/pause`, { paused: true })).status, 404, 'seul le propriétaire suspend');
});

test('retrait : plus de nouvelle commande pour personne, commandes en cours livrées normalement, stock réservé protégé', async () => {
  const p = await mk('wallindirain', 10);
  await call(db.app, 'fn_seller_set_price', w.seller, p, 100000); await call(db.app, 'fn_seller_set_price', w.seller2, p, 100000);
  const o = await buy(w.seller2, p, 2);
  assert.equal((await s.post(`/api/supplier/products/${p}/retire`)).status, 200);
  assert.equal((await s.post(`/api/supplier/products/${p}/retire`)).status, 409);
  assert.equal((await s.post(`/api/supplier/products/${p}/pause`, { paused: false })).status, 409, 'un produit retiré ne se reprend pas');
  await expectErr(buy(w.seller2, p, 1), 'out_of_stock'); await expectErr(buy(w.seller, p, 1), 'out_of_stock');
  assert.equal((await s.get('/api/seller/catalog')).json.products.some((x) => x.id === p), false);
  assert.equal((await prod(p)).reserved_qty, 2);
  await deliver(db, w, o.id, o.ref);
  assert.equal((await rowsOf('SELECT status FROM orders WHERE id = $1', [o.id]))[0].status, 'delivered');
  assert.equal(await bal(w.seller, 'supplier_payment') >= 60000, true);
  await ledgerOk();
});

test('restitution : demande, validation administrateur, remise par le magasinier ; les unités réservées restent protégées', async () => {
  const p = await mk('wallindirain', 10);
  await call(db.app, 'fn_seller_set_price', w.seller2, p, 100000);
  const o = await buy(w.seller2, p, 4);                                   // 4 réservées, 6 disponibles
  await expectErr(call(db.app, 'fn_supplier_request_return', w.seller, p, 7), 'invalid_input');
  await expectErr(call(db.app, 'fn_supplier_request_return', w.seller2, p, 1), 'not_found');
  const r = await s.post(`/api/supplier/products/${p}/return`, { qty: 5 }); assert.equal(r.status, 201);
  assert.equal((await s.post(`/api/supplier/products/${p}/return`, { qty: 1 })).status, 409, 'une seule demande à la fois');
  assert.deepEqual(await prod(p), { stock_qty: 10, reserved_qty: 4, paused_at: null, retired_at: null }, 'rien ne bouge avant la validation');
  // l'administrateur et le magasinier voient la demande au bon endroit
  assert.equal((await admin.get('/api/admin/stock-returns')).json.returns[0].qty, 5);
  await expectErr(call(db.app, 'fn_warehouse_hand_over_return', w.warehouse, r.json.id), 'invalid_state');
  await expectErr(call(db.app, 'fn_admin_decide_return', w.seller, r.json.id, true, null), 'forbidden');
  assert.equal((await admin.post(`/api/admin/stock-returns/${r.json.id}/decide`, { approve: true })).status, 200);
  assert.equal((await prod(p)).reserved_qty, 9, 'les 5 unités sont bloquées');
  await expectErr(buy(w.seller2, p, 2), 'out_of_stock');                  // il ne reste qu'une unité vendable
  const wh = await login(w.warehouse);
  assert.equal((await wh.get('/api/warehouse/arrivals')).json.stock_returns.length, 1);
  assert.equal((await wh.post(`/api/warehouse/returns/${r.json.id}/handover`)).status, 200);
  assert.deepEqual(await prod(p), { stock_qty: 5, reserved_qty: 4, paused_at: null, retired_at: null });
  await expectErr(call(db.app, 'fn_warehouse_hand_over_return', w.warehouse, r.json.id), 'invalid_state');
  await deliver(db, w, o.id, o.ref);                                      // la commande réservée est livrée normalement
  assert.deepEqual(await prod(p), { stock_qty: 1, reserved_qty: 0, paused_at: null, retired_at: null });
  await ledgerOk();
  assert.ok((await rowsOf(`SELECT 1 FROM notifications WHERE user_id = $1 AND title = 'Stock remis'`, [w.seller])).length === 1);
});

test('restitution : refus (motif obligatoire), annulation après acceptation, stock chez le propriétaire non concerné', async () => {
  const p = await mk('wallindirain', 6);
  const a = await call(db.app, 'fn_supplier_request_return', w.seller, p, 2);
  await expectErr(call(db.app, 'fn_admin_decide_return', w.admin, a, false, null), 'note_required');
  await call(db.app, 'fn_admin_decide_return', w.admin, a, false, 'Inventaire en cours');
  assert.deepEqual(await prod(p), { stock_qty: 6, reserved_qty: 0, paused_at: null, retired_at: null });
  await expectErr(call(db.app, 'fn_admin_decide_return', w.admin, a, true, null), 'invalid_state');
  const b = await call(db.app, 'fn_supplier_request_return', w.seller, p, 6);
  await call(db.app, 'fn_admin_decide_return', w.admin, b, true, null);
  assert.equal((await prod(p)).reserved_qty, 6);
  assert.equal((await s.post(`/api/supplier/returns/${b}/cancel`)).status, 200);
  assert.equal((await prod(p)).reserved_qty, 0, 'les unités redeviennent vendables');
  await expectErr(call(db.app, 'fn_supplier_cancel_return', w.seller, b), 'invalid_state');
  const home = await mk('supplier', 4);
  await expectErr(call(db.app, 'fn_supplier_request_return', w.seller, home, 1), 'invalid_state');
  assert.ok((await rowsOf(`SELECT 1 FROM notifications WHERE user_id = $1 AND title = 'Restitution refusée'`, [w.seller])).length === 1);
});

test('le propriétaire est prévenu des ventes des autres, sans identité ; ses propres ventes ne le notifient pas comme une vente tierce', async () => {
  const p = await mk('wallindirain', 5);
  await call(db.app, 'fn_seller_set_price', w.seller, p, 100000); await call(db.app, 'fn_seller_set_price', w.seller2, p, 100000);
  const mine = await buy(w.seller, p, 1); const theirs = await buy(w.seller2, p, 2);
  await deliver(db, w, mine.id, mine.ref); await deliver(db, w, theirs.id, theirs.ref);
  const notes = await rowsOf(`SELECT title, body FROM notifications WHERE user_id = $1 AND title IN ('Nouvelle vente','Vente livrée') AND body LIKE $2`, [w.seller, '%Produit 047-%']);
  const forProduct = notes.filter((x) => x.body.includes(`047-${pn - 5 + 0}`) || true);
  assert.ok(forProduct.some((x) => x.title === 'Nouvelle vente') && forProduct.some((x) => x.title === 'Vente livrée'));
  assert.ok(notes.every((x) => !/Vendeur Deux|Client Test|622/.test(x.body)), 'ni vendeur ni client dans le texte');
  const pname = (await rowsOf('SELECT name FROM products WHERE id = $1', [p]))[0].name;
  assert.equal((await rowsOf(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND title = 'Nouvelle vente' AND body LIKE $2`, [w.seller, `${pname} :%`]))[0].n, 1, 'seule la vente de l\'autre vendeur est signalée, pas la sienne');
  assert.equal((await rowsOf(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND title IN ('Nouvelle vente','Vente livrée')`, [w.supplier]))[0].n, 0, 'les fournisseurs ne sont pas concernés');
});

test('un vendeur ne peut toujours pas acheter du stock prépayé de son propre produit ; les droits de la base sont accordés aux nouvelles fonctions', async () => {
  const p = await mk('wallindirain', 3);
  await assert.rejects(db.owner.query(`INSERT INTO seller_stock(seller_id, product_id, qty) VALUES ($1, $2, 1)`, [w.seller, p]), /vendre vous-même/);
  for (const f of ['fn_supplier_set_pause', 'fn_supplier_retire_product', 'fn_supplier_request_return', 'fn_supplier_cancel_return', 'fn_admin_decide_return', 'fn_warehouse_hand_over_return']) {
    assert.equal((await rowsOf(`SELECT has_function_privilege('wld_app', p.oid, 'EXECUTE') AS ok, p.prosecdef FROM pg_proc p WHERE proname = $1`, [f]))[0].ok, true, f);
  }
  assert.equal((await rowsOf(`SELECT has_function_privilege('wld_app', p.oid, 'EXECUTE') AS ok FROM pg_proc p WHERE proname = '_min_unit_price_for'`))[0].ok, false, 'fonction interne non appelable directement');
  // fonction éteinte : le vendeur n'a plus accès aux nouveaux contrôles
  await db.owner.query(`UPDATE settings SET value = 0 WHERE key = 'feature_vendeur_produits'`);
  assert.equal((await s.post(`/api/supplier/products/${p}/pause`, { paused: true })).status, 403);
  await db.owner.query(`UPDATE settings SET value = 1 WHERE key = 'feature_vendeur_produits'`);
});

test('retour arrière 047 : refusé s\'il existe des restitutions ou des produits suspendus, puis accepté et état d\'avant retrouvé', async () => {
  const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-047.sql'), 'utf8');
  const run = async () => { await db.owner.query('BEGIN'); try { for (const q of splitSql(rb)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT'); } catch (e) { await db.owner.query('ROLLBACK'); throw e; } };
  await assert.rejects(run, /demandes de restitution existent/);
  await db.owner.query(`DELETE FROM stock_returns`);
  await assert.rejects(run, /produits sont suspendus ou retirés/);
  await db.owner.query(`UPDATE products SET paused_at = NULL, retired_at = NULL, availability_note = NULL`);
  await run();
  assert.equal((await rowsOf(`SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('fn_supplier_set_pause','_min_unit_price_for','fn_admin_decide_return','_owner_sale_alert')`))[0].n, 0);
  assert.equal((await rowsOf(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname IN ('orders_no_self_dealing','seller_prices_no_self_dealing','seller_links_no_self_dealing')`))[0].n, 3);
  assert.equal((await rowsOf(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '047_produits_vendeur_stock.sql'`))[0].n, 0);
  const p = (await rowsOf(`SELECT id FROM products WHERE supplier_id = $1 AND status = 'approved' LIMIT 1`, [w.seller]))[0].id;
  await expectErr(call(db.app, 'fn_seller_set_price', w.seller, p, 80000), 'invalid_input');   // l'interdiction de la 046 est revenue
});
