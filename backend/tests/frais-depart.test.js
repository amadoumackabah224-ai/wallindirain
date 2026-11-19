// Migration 080 : frais de livraison selon le point de départ. Éteint par défaut ; entrepôt Wallindirain inchangé ; paliers plafonnés à la grille.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { splitSql } from '../src/migrate.js';
import { freshDb, world, approvedProduct, call, expectErr } from './helpers.js';

const root = path.resolve(import.meta.dirname, '..', '..');
let db, w, pRatoma, pKaloum, prodSup, prodWh, n = 0;
const phone = () => `6${String(++n + 8000).padStart(8, '0')}`;
const order = async (product, commune) => {
  const r = await call(db.app, 'fn_seller_create_order_once', w.seller, `fd-test-key-${String(++n).padStart(8, "0")}`, product, null, 400000, 1, 'Client Test', phone(), commune, 'Rue 1', null, false);
  return (await db.owner.query('SELECT delivery_fee, courier_pay FROM orders WHERE id = $1', [r.id])).rows[0];
};
const set = (k, v) => call(db.app, 'fn_admin_set_setting', w.admin, k, v);
const run = async () => { const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-080.sql'), 'utf8'); await db.owner.query('BEGIN'); try { for (const q of splitSql(rb)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT'); } catch (e) { await db.owner.query('ROLLBACK'); throw e; } };

before(async () => {
  db = await freshDb('wld_fraisdepart'); w = await world(db);
  await db.owner.query(`UPDATE users SET identity_verified = true WHERE id = $1`, [w.seller]);
  await db.owner.query(`UPDATE delivery_rates SET active = true, fee = 30000 WHERE commune = 'Kipé'`);
  await set('feature_pickup_points', 1);
  prodSup = await approvedProduct(db, w, { price: 60000, storage: 'supplier', qty: 50 });
  prodWh = await approvedProduct(db, w, { price: 60000, qty: 50 });
  for (const p of [prodSup, prodWh]) await call(db.app, 'fn_seller_set_price', w.seller, p, 400000);
  pRatoma = (await call(db.app, 'fn_pickup_point_save', w.supplier, null, 'Dépôt Ratoma', 'Ratoma', 'Route 1', null)).id;
  pKaloum = (await call(db.app, 'fn_pickup_point_save', w.supplier, null, 'Dépôt Kaloum', 'Kaloum', 'Rue 2', null)).id;
  await call(db.app, 'fn_product_use_pickup_point', w.supplier, prodSup, pRatoma);
});
after(async () => { await db.owner.end(); await db.app.end(); });

test('zone d\'un point : doit être une zone de livraison connue', async () => {
  await expectErr(call(db.app, 'fn_pickup_point_save', w.supplier, null, 'Dépôt X', 'Planète Mars', 'Route 3', null), 'invalid_input');
});

test('éteint par défaut : le frais reste la grille', async () => {
  assert.equal((await order(prodSup, 'Ratoma')).delivery_fee, 30000);
  assert.equal((await call(db.app, 'fn_delivery_fee_preview', w.seller, prodSup, 'Ratoma')).reduced, false);
});

test('allumé : même zone, même commune, autre commune, minimum, entrepôt inchangé', async () => {
  await set('feature_depart_fees', 1);
  assert.equal((await order(prodSup, 'Ratoma')).delivery_fee, 15000);                // même zone
  assert.equal((await order(prodSup, 'Kipé')).delivery_fee, 20000);                  // même commune (Kipé est dans Ratoma)
  assert.equal((await order(prodSup, 'Kaloum')).delivery_fee, 25000);                // autre commune : grille
  assert.equal((await order(prodWh, 'Ratoma')).delivery_fee, 30000);                 // entrepôt Wallindirain : jamais modifié
  const pv = await call(db.app, 'fn_delivery_fee_preview', w.seller, prodSup, 'Ratoma');
  assert.equal(pv.fee, 15000); assert.equal(pv.grid, 30000); assert.equal(pv.reduced, true);
  await set('fee_depart_same_zone', 1000);                                              // en dessous du minimum : relevé au minimum
  assert.equal((await order(prodSup, 'Ratoma')).delivery_fee, 10000);
  await set('fee_depart_same_zone', 99999999);                                          // au-dessus de la grille : plafonné à la grille
  assert.equal((await order(prodSup, 'Ratoma')).delivery_fee, 30000);
  await set('fee_depart_far_extra', 5000);
  assert.equal((await order(prodSup, 'Kaloum')).delivery_fee, 30000);                // grille + supplément
  await set('fee_depart_same_zone', 15000); await set('fee_depart_far_extra', 0);
});

test('part du livreur recalculée sur le frais réduit ; argent cohérent', async () => {
  await set('courier_share_bps', 8000);
  assert.equal((await order(prodSup, 'Ratoma')).courier_pay, 12000);                 // 80 % de 15 000
  assert.equal((await order(prodWh, 'Ratoma')).courier_pay, 24000);                  // 80 % de 30 000
  await set('courier_share_bps', 0);
  assert.equal((await db.owner.query('SELECT count(*)::int AS n FROM fn_ledger_check()')).rows[0].n, 0);
});

test('adresse saisie à la main : le point est détaché, retour à la grille', async () => {
  await call(db.app, 'fn_supplier_set_pickup', w.supplier, prodSup, 'Chez moi, Kipé');
  assert.equal((await order(prodSup, 'Ratoma')).delivery_fee, 30000);
  await call(db.app, 'fn_product_use_pickup_point', w.supplier, prodSup, pRatoma);
  assert.equal((await order(prodSup, 'Ratoma')).delivery_fee, 15000);
  await call(db.app, 'fn_pickup_point_remove', w.supplier, pRatoma);                    // point retiré : grille
  assert.equal((await order(prodSup, 'Ratoma')).delivery_fee, 30000);
});

test('retour arrière 080 : refusé si des produits sont rattachés, puis propre', async () => {
  await assert.rejects(run, /refusé/);
  await db.owner.query('UPDATE products SET pickup_point_id = NULL');
  await run();
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'products' AND column_name = 'pickup_point_id'`)).rows[0].n, 0);
  assert.equal((await db.owner.query(`SELECT to_regprocedure('_delivery_fee_from(uuid,text,bigint)') AS f`)).rows[0].f, null);
});
