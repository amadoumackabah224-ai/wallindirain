// Migration 032 : inventaire physique. Écart = explication + décision de l'administrateur ; aucun argent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { splitSql } from '../src/migrate.js';
import { freshDb, world, approvedProduct, call, expectErr } from './helpers.js';

let db, w, product, n = 0;
const root = path.resolve(import.meta.dirname, '..', '..');
const ph = () => `63${String(++n + 6000000).padStart(7, '0')}`;
const money = async () => (await db.owner.query(`SELECT count(*)::int AS c, COALESCE(sum(amount),0)::text AS s, md5(string_agg(w::text, ',' ORDER BY id)) AS h FROM wallet_entries w`)).rows[0];
const stock = async () => (await db.owner.query('SELECT stock_qty, reserved_qty FROM products WHERE id = $1', [product])).rows[0];
const expected = async () => (await db.app.query('SELECT * FROM fn_warehouse_expected($1)', [w.warehouse])).rows.find((r) => r.product_id === product);
const notes = async (user, like) => (await db.owner.query(`SELECT title, body FROM notifications WHERE user_id = $1 AND title LIKE $2`, [user, like])).rows;
const mk = (qty = 1) => call(db.app, 'fn_seller_create_order', w.seller, product, null, null, qty, 'Client', ph(), 'Kaloum', 'Rue 1', null, false);

before(async () => { db = await freshDb('wld_inventaire'); w = await world(db); product = await approvedProduct(db, w, { price: 60000, qty: 20 }); await call(db.app, 'fn_seller_set_price', w.seller, product, 120000); });
after(async () => { await db.owner.end(); await db.app.end(); });

test('attendu en rayon = stock - colis sortis (chez le livreur) ; un colis réservé mais encore à l\'entrepôt compte', async () => {
  assert.equal((await expected()).expected, 20);
  const o = await mk(3);                                            // réservé, toujours en rayon
  assert.equal((await expected()).expected, 20);
  await call(db.app, 'fn_agent_take_order', w.agent1, o.id); await call(db.app, 'fn_agent_log_call', w.agent1, o.id, 'confirmed', 'OK');
  await call(db.app, 'fn_chief_assign', w.chief, o.id, w.courier);
  assert.equal((await expected()).expected, 20);                    // affecté mais pas récupéré
  await call(db.app, 'fn_courier_pickup', w.courier, o.id);
  assert.equal((await expected()).expected, 17);                    // sorti de l'entrepôt
  await call(db.app, 'fn_courier_fail', w.courier, o.id, 'customer_refusal');
  assert.equal((await expected()).expected, 17);                    // échec : le colis est encore chez le livreur
  await call(db.app, 'fn_chief_return_to_warehouse', w.chief, o.id);
  assert.equal((await expected()).expected, 17);                    // en route de retour
  await call(db.app, 'fn_warehouse_receive_return', w.warehouse, o.id, 'customer_refusal');
  assert.equal((await expected()).expected, 20);                    // revenu en rayon (refus du client : remis en stock)
});

test('comptage conforme : enregistré sans décision ; stock et argent intacts', async () => {
  const s0 = await stock(), m0 = await money();
  const id = await call(db.app, 'fn_warehouse_count_stock', w.warehouse, product, 20);
  const c = (await db.owner.query('SELECT status, delta FROM stock_counts WHERE id = $1', [id])).rows[0];
  assert.deepEqual(c, { status: 'matched', delta: 0 });
  assert.deepEqual(await stock(), s0); assert.deepEqual(await money(), m0);
});

test('écart : explication obligatoire, administrateur prévenu, stock inchangé tant que non décidé, un seul inventaire en attente', async () => {
  const s0 = await stock();
  await expectErr(call(db.app, 'fn_warehouse_count_stock', w.warehouse, product, 18), 'note_required');
  await expectErr(call(db.app, 'fn_warehouse_count_stock', w.seller, product, 18, 'Interdit'), 'forbidden');
  await expectErr(call(db.app, 'fn_warehouse_count_stock', w.warehouse, product, -1, 'Négatif'), 'invalid_input');
  const id = await call(db.app, 'fn_warehouse_count_stock', w.warehouse, product, 18, '2 unités introuvables');
  assert.deepEqual(await stock(), s0);
  assert.equal((await notes(w.admin, 'Inventaire à valider')).length, 1);
  await expectErr(call(db.app, 'fn_warehouse_count_stock', w.warehouse, product, 19, 'Autre'), 'invalid_state');          // déjà un inventaire en attente
  await expectErr(call(db.app, 'fn_admin_review_stock_count', w.warehouse, id, true), 'forbidden');                      // seul l'administrateur décide
  await expectErr(call(db.app, 'fn_admin_review_stock_count', w.admin, id, false), 'note_required');                     // un refus s'explique
  const m0 = await money();
  await call(db.app, 'fn_admin_review_stock_count', w.admin, id, true, 'Recompté avec le chef');
  assert.equal((await stock()).stock_qty, s0.stock_qty - 2);
  assert.equal((await db.owner.query('SELECT status FROM stock_counts WHERE id = $1', [id])).rows[0].status, 'approved');
  assert.equal((await notes(w.warehouse, 'Inventaire validé')).length, 1); assert.equal((await notes(w.supplier, 'Stock corrigé%')).length, 1);
  await expectErr(call(db.app, 'fn_admin_review_stock_count', w.admin, id, true), 'invalid_state');                      // déjà traité
  assert.deepEqual(await money(), { ...m0 });                                                                            // aucun argent
  assert.equal((await db.owner.query('SELECT count(*)::int AS n FROM fn_ledger_check()')).rows[0].n, 0);
});

test('refus : stock inchangé, le magasinier est prévenu et peut recompter', async () => {
  const s0 = await stock();
  const id = await call(db.app, 'fn_warehouse_count_stock', w.warehouse, product, 5, 'Beaucoup manquent');
  await call(db.app, 'fn_admin_review_stock_count', w.admin, id, false, 'Recomptez demain');
  assert.deepEqual(await stock(), s0);
  assert.equal((await notes(w.warehouse, 'Inventaire refusé')).length, 1);
  await call(db.app, 'fn_warehouse_count_stock', w.warehouse, product, s0.stock_qty);                                     // nouveau comptage possible
});

test('correction impossible sous le réservé : refusée avec un message clair, rien ne change', async () => {
  const o = await mk(4);                                                                                                  // 4 unités réservées
  const s0 = await stock();
  const id = await call(db.app, 'fn_warehouse_count_stock', w.warehouse, product, 2, 'Il n\'en reste presque plus');
  await expectErr(call(db.app, 'fn_admin_review_stock_count', w.admin, id, true), 'invalid_input');
  assert.deepEqual(await stock(), s0);
  assert.equal((await db.owner.query('SELECT status FROM stock_counts WHERE id = $1', [id])).rows[0].status, 'pending');
  await call(db.app, 'fn_admin_review_stock_count', w.admin, id, false, 'Recomptez : 4 sont réservées');
  void o;
});

test('retour arrière 032 : refusé après une correction appliquée', async () => {
  const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-032.sql'), 'utf8');
  await db.owner.query('BEGIN');
  try { for (const s of splitSql(rb)) { if (/^(begin|commit)$/i.test(s.trim())) continue; await db.owner.query(s); } await db.owner.query('COMMIT'); assert.fail('aurait dû refuser'); }
  catch (e) { await db.owner.query('ROLLBACK'); assert.match(e.message, /Retour arrière refusé/); }
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'fn_warehouse_count_stock'`)).rows[0].n, 1);
});
