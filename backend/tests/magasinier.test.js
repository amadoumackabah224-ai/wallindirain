// Migration 031 : espace du magasinier complet (remises, casse, écarts de comptage, notes et photos de retour, alertes). Aucun argent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { splitSql } from '../src/migrate.js';
import { freshDb, world, approvedProduct, call, expectErr, PNG } from './helpers.js';

let db, w, product, n = 0;
const root = path.resolve(import.meta.dirname, '..', '..');
const ph = () => `62${String(++n + 5000000).padStart(7, '0')}`;
const money = async () => (await db.owner.query(`SELECT count(*)::int AS c, COALESCE(sum(amount),0)::text AS s, md5(string_agg(w::text, ',' ORDER BY id)) AS h FROM wallet_entries w`)).rows[0];
const notes = async (user, like) => (await db.owner.query(`SELECT title, body, link FROM notifications WHERE user_id = $1 AND title LIKE $2 ORDER BY id`, [user, like])).rows;
const order = async (qty = 1) => (await call(db.app, 'fn_seller_create_order', w.seller, product, null, null, qty, 'Client', ph(), 'Kaloum', 'Rue 1', null, false));
const assign = async (o, courier = w.courier) => {
  await call(db.app, 'fn_agent_take_order', w.agent1, o.id); await call(db.app, 'fn_agent_log_call', w.agent1, o.id, 'confirmed', 'OK');
  await call(db.app, 'fn_chief_assign', w.chief, o.id, courier);
};

before(async () => { db = await freshDb('wld_magasinier'); w = await world(db); product = await approvedProduct(db, w, { price: 60000, qty: 20 }); await call(db.app, 'fn_seller_set_price', w.seller, product, 120000); });
after(async () => { await db.owner.end(); await db.app.end(); });

test('arrivage annoncé : le magasinier est prévenu dans la cloche', async () => {
  const n0 = (await notes(w.warehouse, 'Arrivage annoncé')).length;
  await call(db.app, 'fn_supplier_announce_arrival', w.supplier, product, 5);
  const r = await notes(w.warehouse, 'Arrivage annoncé');
  assert.equal(r.length, n0 + 1); assert.equal(r.at(-1).link, 'todo'); assert.match(r.at(-1).body, /5 unité/);
});

test('comptage : l\'écart doit être expliqué ; fournisseur et administration sont prévenus ; le stock suit le nombre compté', async () => {
  const before = await money();
  const a = (await db.owner.query(`SELECT id FROM arrivals WHERE counted_qty IS NULL`)).rows[0].id;
  const stock0 = (await db.owner.query('SELECT stock_qty FROM products WHERE id = $1', [product])).rows[0].stock_qty;
  await expectErr(call(db.app, 'fn_warehouse_count_arrival', w.warehouse, a, 4), 'note_required');
  await expectErr(call(db.app, 'fn_warehouse_count_arrival', w.warehouse, a, 4, 'x'), 'invalid_input');
  assert.equal((await db.owner.query('SELECT counted_qty FROM arrivals WHERE id = $1', [a])).rows[0].counted_qty, null);   // rien n'a été compté
  await call(db.app, 'fn_warehouse_count_arrival', w.warehouse, a, 4, '1 carton ouvert, 1 produit manquant');
  assert.equal((await db.owner.query('SELECT stock_qty FROM products WHERE id = $1', [product])).rows[0].stock_qty, stock0 + 4);
  assert.equal((await db.owner.query('SELECT count_note FROM arrivals WHERE id = $1', [a])).rows[0].count_note, '1 carton ouvert, 1 produit manquant');
  assert.equal((await notes(w.supplier, 'Écart sur votre arrivage')).length, 1);
  assert.equal((await notes(w.admin, 'Écart de comptage')).length, 1);
  await expectErr(call(db.app, 'fn_warehouse_count_arrival', w.warehouse, a, 4, 'encore'), 'invalid_state');
  // compte exact : aucune explication demandée, appel à 3 arguments toujours accepté
  await call(db.app, 'fn_supplier_announce_arrival', w.supplier, product, 3);
  const b = (await db.owner.query(`SELECT id FROM arrivals WHERE counted_qty IS NULL`)).rows[0].id;
  await call(db.app, 'fn_warehouse_count_arrival', w.warehouse, b, 3);
  assert.equal((await notes(w.supplier, 'Arrivage compté')).length >= 1, true);
  assert.deepEqual(await money(), before);
});

test('remise d\'un colis : seulement affecté + stocké à l\'entrepôt ; une seule fois par livreur ; le livreur est prévenu', async () => {
  const o = await order();
  await expectErr(call(db.app, 'fn_warehouse_handover', w.warehouse, o.id), 'invalid_state');                       // pas encore affecté
  await assign(o);
  assert.equal((await notes(w.warehouse, 'Colis à préparer')).length >= 1, true);
  await expectErr(call(db.app, 'fn_warehouse_handover', w.seller, o.id), 'forbidden');
  await call(db.app, 'fn_warehouse_handover', w.warehouse, o.id);
  await expectErr(call(db.app, 'fn_warehouse_handover', w.warehouse, o.id), 'invalid_state');                       // déjà remis
  assert.equal((await notes(w.courier, 'Colis remis')).length, 1);
  assert.equal((await db.owner.query(`SELECT status FROM orders WHERE id = $1`, [o.id])).rows[0].status, 'assigned');   // la récupération reste l'acte du livreur
  await call(db.app, 'fn_courier_pickup', w.courier, o.id);
  await expectErr(call(db.app, 'fn_warehouse_handover', w.warehouse, o.id), 'invalid_state');                       // plus « affecté »
  // produit stocké chez le fournisseur : pas de remise par l'entrepôt
  const p2 = await approvedProduct(db, w, { price: 50000, storage: 'supplier', qty: 5 });
  await call(db.app, 'fn_seller_set_price', w.seller, p2, 150000);
  const o2 = await call(db.app, 'fn_seller_create_order', w.seller, p2, null, null, 1, 'Client', ph(), 'Kaloum', 'Rue 1', null, false);
  await assign(o2);
  await expectErr(call(db.app, 'fn_warehouse_handover', w.warehouse, o2.id), 'invalid_state');
});

test('réaffectation à un autre livreur : la remise précédente ne compte plus', async () => {
  const o = await order();
  await assign(o);
  await call(db.app, 'fn_warehouse_handover', w.warehouse, o.id);
  await call(db.app, 'fn_chief_assign', w.chief, o.id, w.courier2);
  await call(db.app, 'fn_warehouse_handover', w.warehouse, o.id);
  assert.equal((await db.owner.query(`SELECT courier_id FROM order_handovers WHERE order_id = $1`, [o.id])).rows[0].courier_id, w.courier2);
});

test('casse / perte : retire du stock libre seulement, journal, alertes, aucun argent', async () => {
  const before = await money();
  const p = (await db.owner.query('SELECT stock_qty, reserved_qty FROM products WHERE id = $1', [product])).rows[0];
  const free = p.stock_qty - p.reserved_qty;
  await expectErr(call(db.app, 'fn_warehouse_declare_loss', w.warehouse, product, free + 1, 'damaged', 'Trop'), 'invalid_input');   // pas plus que le libre
  await expectErr(call(db.app, 'fn_warehouse_declare_loss', w.warehouse, product, 1, 'damaged', ' '), 'invalid_input');             // explication obligatoire
  await expectErr(call(db.app, 'fn_warehouse_declare_loss', w.warehouse, product, 1, 'inconnu', 'Motif faux'), 'invalid_input');
  await expectErr(call(db.app, 'fn_warehouse_declare_loss', w.seller, product, 1, 'damaged', 'Interdit'), 'forbidden');
  await call(db.app, 'fn_warehouse_declare_loss', w.warehouse, product, 2, 'damaged', 'Tombés du rayon');
  const after = (await db.owner.query('SELECT stock_qty, reserved_qty FROM products WHERE id = $1', [product])).rows[0];
  assert.equal(after.stock_qty, p.stock_qty - 2); assert.equal(after.reserved_qty, p.reserved_qty);
  assert.equal((await db.owner.query('SELECT count(*)::int AS n FROM stock_losses')).rows[0].n, 1);
  assert.equal((await notes(w.supplier, 'Stock retiré%')).length, 1); assert.equal((await notes(w.admin, 'Casse ou perte%')).length, 1);
  await assert.rejects(db.owner.query(`UPDATE stock_losses SET qty = 9`));                                           // journal non modifiable
  assert.deepEqual(await money(), before);
  assert.equal((await db.owner.query('SELECT count(*)::int AS n FROM fn_ledger_check()')).rows[0].n, 0);
});

test('retour : note et photos avant la réception ; lecture réservée ; la réception financière reste inchangée', async () => {
  const o = await order();
  await assign(o); await call(db.app, 'fn_courier_pickup', w.courier, o.id);
  await call(db.app, 'fn_courier_fail', w.courier, o.id, 'customer_refusal');
  await call(db.app, 'fn_chief_return_to_warehouse', w.chief, o.id);
  await expectErr(call(db.app, 'fn_warehouse_return_note', w.warehouse, o.id, 'x'), 'invalid_input');
  await call(db.app, 'fn_warehouse_return_note', w.warehouse, o.id, 'Colis intact, scellé ouvert');
  await call(db.app, 'fn_warehouse_return_note', w.warehouse, o.id, 'Colis intact, scellé ouvert (corrigé)');   // une seule note, remplacée
  assert.equal((await db.owner.query('SELECT count(*)::int AS n FROM return_notes WHERE order_id = $1', [o.id])).rows[0].n, 1);
  const big = Buffer.concat([PNG, Buffer.alloc(1500)]);
  const ids = [];
  await expectErr(call(db.app, 'fn_warehouse_add_return_photo', w.warehouse, o.id, 'image/gif', big), 'invalid_input');
  for (let i = 0; i < 3; i++) ids.push(await call(db.app, 'fn_warehouse_add_return_photo', w.warehouse, o.id, 'image/png', big));
  await expectErr(call(db.app, 'fn_warehouse_add_return_photo', w.warehouse, o.id, 'image/png', big), 'invalid_state');   // 3 maximum
  const get = (u) => db.app.query('SELECT * FROM fn_return_photo_get($1, $2)', [u, ids[0]]);
  assert.equal((await get(w.warehouse)).rows.length, 1); assert.equal((await get(w.admin)).rows.length, 1); assert.equal((await get(w.supplier)).rows.length, 1);
  await assert.rejects(get(w.seller), /forbidden|non autoris/i);
  await assert.rejects(get(w.courier), /forbidden|non autoris/i);
  await assert.rejects(db.app.query('SELECT data FROM return_photos'), /permission denied/);                       // octets jamais lisibles en direct
  // réception : mêmes écritures d'argent qu'avant la 031 (refus du client : frais retenus au vendeur, produit remis en stock)
  const m0 = await money(); const maxId = (await db.owner.query('SELECT COALESCE(max(id),0) AS m FROM wallet_entries')).rows[0].m;
  await call(db.app, 'fn_warehouse_receive_return', w.warehouse, o.id, 'customer_refusal');
  const m1 = await money();
  const kinds = (await db.owner.query(`SELECT kind FROM wallet_entries WHERE id > $1`, [maxId])).rows.map((r) => r.kind);
  assert.equal(kinds.length, m1.c - m0.c);
  assert.ok(kinds.every((k) => k === 'return_fees'));                                                              // seules les écritures « frais de retour » de la règle existante
  assert.equal((await db.owner.query(`SELECT status FROM orders WHERE id = $1`, [o.id])).rows[0].status, 'returned');
  await expectErr(call(db.app, 'fn_warehouse_return_note', w.warehouse, o.id, 'trop tard'), 'invalid_state');          // retour clos : plus de note
  assert.equal((await db.owner.query('SELECT count(*)::int AS n FROM fn_ledger_check()')).rows[0].n, 0);
});

test('retour arrière 031 : refusé tant qu\'une casse est déclarée ; sinon restaure le comptage d\'avant', async () => {
  const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-031.sql'), 'utf8');
  const run = async () => { await db.owner.query('BEGIN'); try { for (const s of splitSql(rb)) { if (/^(begin|commit)$/i.test(s.trim())) continue; await db.owner.query(s); } await db.owner.query('COMMIT'); } catch (e) { await db.owner.query('ROLLBACK'); throw e; } };
  await assert.rejects(run(), /Retour arrière refusé/);
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'fn_warehouse_handover'`)).rows[0].n, 1);   // rien n'a changé
});
