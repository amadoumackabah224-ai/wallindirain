// Migration 075 : pilotage (alertes comptables, « Aujourd'hui », historique produit, rapports, dettes et créances, performances, dossiers).
// Tout est en lecture : on vérifie surtout que RIEN d'économique ne bouge et que chaque rôle ne voit que ce qui le concerne.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { splitSql } from '../src/migrate.js';
import { freshDb, world, approvedProduct, deliver, codeOf, call, expectErr } from './helpers.js';

const root = path.resolve(import.meta.dirname, '..', '..');
let db, w, product, n = 0, k = 0;
const phone = () => `6${String(++n + 5000).padStart(8, '0')}`;
const mk = () => call(db.app, 'fn_seller_create_order_once', w.seller, `pilot-test-key-${String(++k).padStart(8, '0')}`, product, null, null, 1, 'Client Test', phone(), 'Kaloum', 'Rue 1 Kaloum', null, false);
const money = async () => (await db.owner.query(`SELECT (SELECT COALESCE(sum(amount),0) FROM wallet_entries)::text AS a, (SELECT count(*) FROM wallet_entries)::text AS n, (SELECT count(*) FROM courier_cash_entries)::text AS c,
  (SELECT COALESCE(sum(stock_qty+reserved_qty),0) FROM products)::text AS s, (SELECT count(*) FROM orders)::text AS o`)).rows[0];
const today = () => new Date().toISOString().slice(0, 10);
const run = async (file) => { const rb = fs.readFileSync(path.join(root, 'docs', file), 'utf8'); await db.owner.query('BEGIN'); try { for (const q of splitSql(rb)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT'); } catch (e) { await db.owner.query('ROLLBACK'); throw e; } };

before(async () => {
  db = await freshDb('wld_pilotage'); w = await world(db);
  product = await approvedProduct(db, w, { price: 60000, qty: 50 });
  await call(db.app, 'fn_seller_set_price', w.seller, product, 120000);
  await call(db.app, 'fn_seller_set_price', w.seller2, product, 120000);
  await db.owner.query('UPDATE users SET identity_verified = true WHERE id = $1', [w.seller]);
});
after(async () => { await db.owner.end(); await db.app.end(); });

test('anomalies : base saine = aucune ; un solde négatif et un retrait en retard sont détectés ; réservé à l\'administrateur ; rien ne bouge', async () => {
  assert.deepEqual(await call(db.app, 'fn_accounting_anomalies', w.admin), []);
  const before = await money();
  await db.owner.query(`INSERT INTO wallet_entries(user_id, kind, amount, description) VALUES ($1, 'adjustment', -5000, 'test anomalie')`, [w.seller2]);
  const list = await call(db.app, 'fn_accounting_anomalies', w.admin);
  assert.equal(list.length, 1); assert.equal(list[0].code, 'negative_balance'); assert.equal(list[0].severity, 'bad');
  await expectErr(call(db.app, 'fn_accounting_anomalies', w.seller), 'forbidden');
  await expectErr(call(db.app, 'fn_accounting_anomalies', w.courier), 'forbidden');
  const m = await money(); assert.equal(m.n, String(Number(before.n) + 1)); assert.equal(m.s, before.s);   // seule mon écriture de test a été ajoutée
  await db.owner.query(`DELETE FROM wallet_entries WHERE description = 'test anomalie'`).catch(() => {});   // table en ajout seul possible : on neutralise sinon
  if ((await call(db.app, 'fn_accounting_anomalies', w.admin)).length) await db.owner.query(`INSERT INTO wallet_entries(user_id, kind, amount, description) VALUES ($1, 'adjustment', 5000, 'neutralisation test')`, [w.seller2]);
  assert.deepEqual(await call(db.app, 'fn_accounting_anomalies', w.admin), []);
});

test('alerte périodique : une alerte par type et par demi-heure, aux administrateurs seulement, réglage ops_alerts = 0 la coupe', async () => {
  await db.owner.query(`INSERT INTO wallet_entries(user_id, kind, amount, description) VALUES ($1, 'adjustment', -7000, 'dette test')`, [w.seller2]);
  const r1 = await call(db.app, 'fn_run_anomaly_checks'); assert.equal(r1.alerts, 1);
  const r2 = await call(db.app, 'fn_run_anomaly_checks'); assert.equal(r2.alerts, 0);                       // pas de doublon
  const mine = async (u) => (await call(db.app, 'fn_my_notifications', u, 50)).items.filter((x) => x.title === 'Alerte technique');
  assert.equal((await mine(w.admin)).length, 1); assert.equal((await mine(w.seller)).length, 0);
  await call(db.app, 'fn_admin_set_setting', w.admin, 'ops_alerts', 0);
  await db.owner.query(`DELETE FROM notifications WHERE kind = 'system'`).catch(() => {});
  assert.equal((await call(db.app, 'fn_run_anomaly_checks')).alerts, 0);
  await call(db.app, 'fn_admin_set_setting', w.admin, 'ops_alerts', 1);
  await db.owner.query(`INSERT INTO wallet_entries(user_id, kind, amount, description) VALUES ($1, 'adjustment', 7000, 'remise à zéro test')`, [w.seller2]);
  assert.deepEqual(await call(db.app, 'fn_accounting_anomalies', w.admin), []);
});

test('argent livreur non reversé depuis longtemps : signalé comme anomalie (avertissement)', async () => {
  const o = await mk(); await deliver(db, w, o.id, o.ref);
  assert.deepEqual((await call(db.app, 'fn_accounting_anomalies', w.admin)), []);
  await db.owner.query(`UPDATE courier_cash_entries SET created_at = now() - interval '5 days' WHERE courier_id = $1`, [w.courier]);
  const list = await call(db.app, 'fn_accounting_anomalies', w.admin);
  assert.equal(list.length, 1); assert.equal(list[0].code, 'cash_overdue'); assert.equal(list[0].severity, 'warn');
});

test('Aujourd\'hui : chaque rôle voit seulement ses propres actions', async () => {
  const o = await mk();
  const t = async (u) => (await call(db.app, 'fn_today', u));
  const keys = async (u) => (await t(u)).items.map((x) => x.key);
  assert.ok((await keys(w.admin)).includes('orders_new'));
  assert.ok((await keys(w.seller)).includes('to_confirm'));
  assert.ok(!(await keys(w.seller2)).includes('to_confirm'));                    // un autre vendeur ne voit pas mes commandes
  assert.ok((await keys(w.agent1)).includes('queue'));
  assert.ok(!(await keys(w.agent1)).includes('assign'));                         // l'affectation est pour le chef
  assert.equal((await t(w.courier)).role, 'courier');
  assert.deepEqual(await keys(w.courier2), []);
  await call(db.app, 'fn_agent_take_order', w.agent1, o.id); await call(db.app, 'fn_agent_log_call', w.agent1, o.id, 'confirmed', 'OK');
  assert.ok((await keys(w.chief)).includes('assign'));
  await call(db.app, 'fn_chief_assign', w.chief, o.id, w.courier);
  assert.ok((await keys(w.courier)).includes('to_pick'));
  assert.ok(!(await keys(w.courier2)).includes('to_pick'));
  assert.ok((await keys(w.supplier)).includes('parcels'));
  await expectErr(call(db.app, 'fn_today', '00000000-0000-0000-0000-0000000000aa'), 'forbidden');
  await call(db.app, 'fn_courier_pickup', w.courier, o.id); await call(db.app, 'fn_courier_depart', w.courier, o.id); await call(db.app, 'fn_courier_deliver', w.courier, o.id, await codeOf(db, o.ref));
});

test('historique produit : chronologie complète, sans marge ; fournisseur propriétaire et administration seulement', async () => {
  const h = await call(db.app, 'fn_product_history', w.supplier, product);
  assert.equal(h.product.id, product);
  const kinds = h.events.map((e) => e.kind);
  for (const kd of ['created', 'arrival', 'order']) assert.ok(kinds.includes(kd), kd);
  assert.ok(!JSON.stringify(h).includes('margin'));
  const adm = await call(db.app, 'fn_product_history', w.admin, product); assert.equal(adm.events.length, h.events.length);
  await expectErr(call(db.app, 'fn_product_history', w.seller, product), 'forbidden');
  await expectErr(call(db.app, 'fn_product_history', w.courier, product), 'forbidden');
  const other = await call(db.app, 'fn_register', phone(), 'Fournisseur Deux', 'supplier', 'x', 'CNI-999999');
  await call(db.app, 'fn_admin_set_user_status', w.admin, other, 'active');
  await expectErr(call(db.app, 'fn_product_history', other, product), 'forbidden');
  await expectErr(call(db.app, 'fn_product_history', w.admin, '00000000-0000-0000-0000-0000000000aa'), 'not_found');
  const sorted = [...h.events].sort((a, b) => new Date(b.at) - new Date(a.at)).map((e) => e.at); assert.deepEqual(h.events.map((e) => e.at), sorted);
});

test('rapports : génération manuelle idempotente, archive en ajout seul, automatique éteint par défaut', async () => {
  const day = '2020-01-15';
  assert.equal(await call(db.app, 'fn_admin_report_make', w.admin, 'daily', day), true);
  assert.equal(await call(db.app, 'fn_admin_report_make', w.admin, 'daily', day), false);                        // jamais deux fois
  assert.equal(await call(db.app, 'fn_admin_report_make', w.admin, 'weekly', day), true);
  assert.equal(await call(db.app, 'fn_admin_report_make', w.admin, 'monthly', day), true);
  await expectErr(call(db.app, 'fn_admin_report_make', w.admin, 'daily', today()), 'invalid_input');           // période pas terminée
  await expectErr(call(db.app, 'fn_admin_report_make', w.admin, 'yearly', day), 'invalid_input');
  await expectErr(call(db.app, 'fn_admin_report_make', w.seller, 'daily', '2020-01-16'), 'forbidden');
  const list = await call(db.app, 'fn_admin_reports', w.admin, null); assert.equal(list.length, 3);
  const monthly = list.find((r) => r.kind === 'monthly'); assert.equal(monthly.from, '2020-01-01'); assert.equal(monthly.to, '2020-01-31');
  assert.equal(list.find((r) => r.kind === 'weekly').from, '2020-01-13');
  assert.equal(monthly.auto, false); assert.equal(typeof monthly.data.delivered.count, 'number');
  await expectErr(call(db.app, 'fn_admin_reports', w.seller, null), 'forbidden');
  await assert.rejects(db.owner.query('DELETE FROM company_reports'), /ajout seul/);
  await assert.rejects(db.owner.query(`UPDATE company_reports SET kind = 'daily'`), /ajout seul/);
  assert.equal((await call(db.app, 'fn_run_reports')).disabled, true);
  assert.equal((await db.owner.query('SELECT count(*)::int AS n FROM company_reports')).rows[0].n, 3);
});

test('rapports automatiques : une fois allumés, hier + semaine + mois écoulés, sans doublon, administrateurs prévenus', async () => {
  const before = await money();
  await call(db.app, 'fn_admin_set_setting', w.admin, 'auto_reports', 1);
  const r1 = await call(db.app, 'fn_run_reports'); assert.equal(r1.created, 3);
  assert.equal((await call(db.app, 'fn_run_reports')).created, 0);
  const auto = (await call(db.app, 'fn_admin_reports', w.admin, null)).filter((r) => r.auto);
  assert.equal(auto.length, 3);
  assert.ok((await call(db.app, 'fn_my_notifications', w.admin, 50)).items.some((x) => x.title === 'Rapports financiers disponibles'));
  assert.deepEqual(await money(), before);
  await call(db.app, 'fn_admin_set_setting', w.admin, 'auto_reports', 0);
});

test('dettes et créances : soldes dus, argent des livreurs attendu, administrateur seulement', async () => {
  const o = await mk(); await deliver(db, w, o.id, o.ref);
  const d = await call(db.app, 'fn_admin_debts', w.admin);
  assert.ok(d.owed.total > 0); assert.ok(d.owed.by_role.some((x) => x.role === 'seller'));
  assert.ok(d.receivable.total > 0); assert.equal(d.receivable.couriers[0].courier.length > 0, true);
  const held = (await db.owner.query(`SELECT COALESCE(sum(amount),0)::bigint AS n FROM courier_cash_entries WHERE count_id IS NULL AND remittance_id IS NULL`)).rows[0].n;
  assert.equal(String(d.receivable.total), String(held));
  await expectErr(call(db.app, 'fn_admin_debts', w.seller), 'forbidden');
  await expectErr(call(db.app, 'fn_admin_debts', w.courier), 'forbidden');
});

test('performances : l\'administrateur voit tout, le vendeur seulement les siennes, jamais la marge de la plateforme', async () => {
  const o = await call(db.app, 'fn_seller_create_order_once', w.seller2, 'pilot-test-key-s2000001', product, null, null, 1, 'Autre Client', phone(), 'Ratoma', 'Rue 2 Ratoma', null, false);
  const to = today(), from = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const a = await call(db.app, 'fn_performance', w.admin, from, to);
  const s = await call(db.app, 'fn_performance', w.seller, from, to);
  const s2 = await call(db.app, 'fn_performance', w.seller2, from, to);
  assert.equal(a.scope, 'admin'); assert.equal(s.scope, 'seller');
  assert.ok(a.totals.orders > s.totals.orders);
  assert.equal(s2.totals.orders, 1); assert.equal(s2.totals.delivered, 0);
  assert.ok('platform_revenue' in a.totals); assert.ok(!('platform_revenue' in s.totals)); assert.ok('gains' in s.totals);
  assert.ok(!JSON.stringify(s).includes('platform_revenue')); assert.ok(!JSON.stringify(s).includes('margin')); assert.deepEqual(s.sellers, []);
  assert.ok(a.sellers.length >= 2); assert.ok(a.zones.length >= 1); assert.ok(a.products.length >= 1);
  assert.ok(Array.isArray(a.series) && a.series.length >= 1); assert.equal(a.weekly, false);
  assert.equal(a.series.reduce((t, x) => t + x.orders, 0), a.totals.orders);                                   // la courbe retombe sur le total
  assert.ok(a.products.every((x) => 'qty' in x)); assert.ok(a.products.some((x) => x.qty >= 1));
  assert.equal(s2.series.reduce((t, x) => t + x.orders, 0), 1);                                                // chacun sa courbe
  const year = await call(db.app, 'fn_performance', w.admin, new Date(Date.now() - 364 * 864e5).toISOString().slice(0, 10), to);
  assert.equal(year.weekly, true); assert.equal(year.series.reduce((t, x) => t + x.orders, 0), year.totals.orders);
  await expectErr(call(db.app, 'fn_performance', w.supplier, from, to), 'forbidden');
  await expectErr(call(db.app, 'fn_performance', w.admin, to, from), 'invalid_input');
  await expectErr(call(db.app, 'fn_performance', w.admin, '2010-01-01', to), 'invalid_input');
  void o;
});

test('dossier de commande : administrateur, vendeur propriétaire, livreur affecté, fournisseur du produit ; les autres sont refusés', async () => {
  const o = await mk(); const done = await deliver(db, w, o.id, o.ref); void done;
  const adm = await call(db.app, 'fn_order_dossier', w.admin, o.id);
  assert.equal(adm.order.ref, o.ref); assert.ok(adm.history.length >= 4); assert.ok(adm.cash);
  const sel = await call(db.app, 'fn_order_dossier', w.seller, o.id); assert.equal(sel.cash, null);               // le vendeur ne voit pas la caisse du livreur
  const cou = await call(db.app, 'fn_order_dossier', w.courier, o.id); assert.ok(cou.cash);
  await call(db.app, 'fn_order_dossier', w.supplier, o.id);
  await expectErr(call(db.app, 'fn_order_dossier', w.seller2, o.id), 'forbidden');
  await expectErr(call(db.app, 'fn_order_dossier', w.courier2, o.id), 'forbidden');
  await expectErr(call(db.app, 'fn_order_dossier', w.admin, '00000000-0000-0000-0000-0000000000aa'), 'not_found');
  assert.ok(!JSON.stringify(sel).includes('delivery_code') && !JSON.stringify(sel).includes('customer_phone'));
});

test('dossier de retrait : propriétaire et administration seulement', async () => {
  await db.owner.query(`INSERT INTO wallet_entries(user_id, kind, amount, description) VALUES ($1, 'adjustment', 90000, 'solde test retrait')`, [w.seller]);
  const wid = await call(db.app, 'fn_withdrawal_request', w.seller, 60000, 'orange_money', '620000001');
  const d = await call(db.app, 'fn_withdrawal_dossier', w.seller, wid); assert.equal(d.withdrawal.amount, 60000); assert.ok(!('owner' in d.withdrawal));
  const a = await call(db.app, 'fn_withdrawal_dossier', w.admin, wid); assert.ok(a.withdrawal.owner);
  await expectErr(call(db.app, 'fn_withdrawal_dossier', w.seller2, wid), 'forbidden');
  await expectErr(call(db.app, 'fn_withdrawal_dossier', w.admin, '00000000-0000-0000-0000-0000000000aa'), 'not_found');
});

test('le contrôle des comptes reste vide et aucun montant n\'a été modifié par les lectures', async () => {
  const before = await money();
  await call(db.app, 'fn_today', w.admin); await call(db.app, 'fn_admin_debts', w.admin); await call(db.app, 'fn_performance', w.admin, new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10), today()); await call(db.app, 'fn_accounting_anomalies', w.admin);
  assert.deepEqual(await money(), before);
  assert.equal((await db.owner.query('SELECT count(*)::int AS n FROM fn_ledger_check()')).rows[0].n, 0);
});

test('retour arrière 075 : refusé si des rapports sont archivés, puis propre', async () => {
  await assert.rejects(run('retour-arriere-075.sql'), /refusé/);
  await db.owner.query('ALTER TABLE company_reports DISABLE TRIGGER company_reports_append_only');
  await db.owner.query('DELETE FROM company_reports');
  await db.owner.query('ALTER TABLE company_reports ENABLE TRIGGER company_reports_append_only');
  await run('retour-arriere-075.sql');
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('fn_today','fn_admin_debts','fn_performance','fn_run_reports','_anomaly_list','fn_product_history','fn_order_dossier')`)).rows[0].n, 0);
  assert.equal((await db.owner.query(`SELECT to_regclass('company_reports') AS t`)).rows[0].t, null);
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '075_pilotage.sql'`)).rows[0].n, 0);
  assert.equal((await db.owner.query('SELECT count(*)::int AS n FROM fn_ledger_check()')).rows[0].n, 0);   // le reste fonctionne toujours
});
