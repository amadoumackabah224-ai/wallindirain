// Migration 079 : points de retrait multiples. Aucun effet sur le stock ni l'argent ; droits et réglage vérifiés en base.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { splitSql } from '../src/migrate.js';
import { freshDb, world, approvedProduct, call, expectErr } from './helpers.js';

const root = path.resolve(import.meta.dirname, '..', '..');
let db, w, product;
const snap = async () => (await db.owner.query(`SELECT (SELECT count(*) FROM orders)::text AS o, (SELECT count(*) FROM wallet_entries)::text AS we, (SELECT COALESCE(sum(stock_qty+reserved_qty),0) FROM products)::text AS s`)).rows[0];
const save = (who, id, name, zone) => call(db.app, 'fn_pickup_point_save', who, id, name, zone, 'Route du Niger, dépôt 2', '622000111');

before(async () => { db = await freshDb('wld_points'); w = await world(db); product = await approvedProduct(db, w, { price: 60000, qty: 50 }); });
after(async () => { await db.owner.end(); await db.app.end(); });

test('éteint par défaut ; seuls fournisseur et vendeur déclarent', async () => {
  await expectErr(save(w.supplier, null, 'Dépôt Kaloum', 'Kaloum'), 'feature_off');
  assert.equal((await call(db.app, 'fn_pickup_points_mine', w.supplier)).enabled, false);
  await call(db.app, 'fn_admin_set_setting', w.admin, 'feature_pickup_points', 1);
  await expectErr(save(w.courier, null, 'Dépôt X', 'Kaloum'), 'forbidden');
  await expectErr(save(w.supplier, null, 'A', 'Kaloum'), 'invalid_input');
});

test('créer, modifier, retirer ; chacun ne voit que les siens', async () => {
  const a = await save(w.supplier, null, 'Dépôt Kaloum', 'Kaloum');
  const b = await save(w.supplier, null, 'Dépôt Ratoma', 'Ratoma');
  await call(db.app, 'fn_pickup_point_save', w.supplier, a.id, 'Dépôt Kaloum 2', 'Kaloum', 'Rue 7', null);
  assert.equal((await call(db.app, 'fn_pickup_points_mine', w.supplier)).points.length, 2);
  assert.equal((await call(db.app, 'fn_pickup_points_mine', w.seller)).points.length, 0);
  await expectErr(call(db.app, 'fn_pickup_point_remove', w.seller, b.id), 'not_found');
  await call(db.app, 'fn_pickup_point_remove', w.supplier, b.id);
  assert.equal((await call(db.app, 'fn_pickup_points_mine', w.supplier)).points.length, 1);
});

test('appliquer un point à un produit et suggestion : stock et argent inchangés', async () => {
  const before = await snap();
  const pts = (await call(db.app, 'fn_pickup_points_mine', w.supplier)).points;
  await db.owner.query(`UPDATE products SET storage = 'supplier' WHERE id = $1`, [product]);
  await call(db.app, 'fn_product_use_pickup_point', w.supplier, product, pts[0].id);
  const d = (await db.owner.query('SELECT pickup_detail FROM products WHERE id = $1', [product])).rows[0].pickup_detail;
  assert.match(d, /Dépôt Kaloum 2/);
  const s = await call(db.app, 'fn_pickup_suggest', w.admin, product, 'Kaloum');
  assert.equal(s.point.id, pts[0].id); assert.equal(s.same_zone, true);
  await expectErr(call(db.app, 'fn_pickup_suggest', w.courier, product, 'Kaloum'), 'forbidden');
  assert.deepEqual(await snap(), before);
  assert.equal((await db.owner.query('SELECT count(*)::int AS n FROM fn_ledger_check()')).rows[0].n, 0);
});

test('retour arrière 079 : refusé s\'il existe des points, puis propre', async () => {
  const run = async () => { const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-079.sql'), 'utf8'); await db.owner.query('BEGIN'); try { for (const q of splitSql(rb)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT'); } catch (e) { await db.owner.query('ROLLBACK'); throw e; } };
  await assert.rejects(run, /refusé/);
  await db.owner.query('DELETE FROM pickup_points');
  await run();
  assert.equal((await db.owner.query(`SELECT to_regclass('pickup_points') AS t`)).rows[0].t, null);
});
