// Alertes automatiques dans la cloche : stock bas, colis non récupéré, argent à reverser, numéro de versement manquant (migration 028).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshDb, TEST_DB, APP_PW, world, approvedProduct, codeOf, call } from './helpers.js';
import { splitSql, migrate } from '../src/migrate.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let db, w, product, n = 0, k = 0;
const count = async (sql, p = []) => Number((await db.owner.query(sql, p)).rows[0].n);
const phone = () => `6${String(++n).padStart(8, '0')}`;
const mk = () => call(db.app, 'fn_seller_create_order_once', w.seller, `alert-test-key-${String(++k).padStart(8, '0')}`, product, null, null, 1, 'Client Test', phone(), 'Kaloum', 'Rue 1 Kaloum', null, true);
const run = () => call(db.app, 'fn_run_alerts');
const titles = async (user) => (await call(db.app, 'fn_my_notifications', user, 100)).items.map((x) => x.title);
const bodies = async (user, title) => (await call(db.app, 'fn_my_notifications', user, 100)).items.filter((x) => x.title === title).map((x) => x.body);
const setSetting = (key, v) => call(db.app, 'fn_admin_set_setting', w.admin, key, v);
const moneyState = async () => (await db.owner.query('SELECT (SELECT COALESCE(sum(amount),0) FROM wallet_entries)::text AS a, (SELECT count(*) FROM courier_cash_entries)::text AS b, (SELECT COALESCE(sum(stock_qty+reserved_qty),0) FROM products)::text AS c')).rows[0];

before(async () => {
  db = await freshDb('wld_alertes'); w = await world(db);
  product = await approvedProduct(db, w, { price: 60000, qty: 150 });
  await call(db.app, 'fn_seller_set_price', w.seller, product, 120000);
});
after(async () => { await db.owner.end(); await db.app.end(); });

test('stock bas puis rupture : le fournisseur est prévenu une fois par état, pas de doublon, réglage 0 = désactivé', async () => {
  const low = await approvedProduct(db, w, { price: 30000, qty: 3 });                       // 3 unités vendables ≤ 5
  const before = await moneyState();
  const r1 = await run();
  assert.equal(r1.stock, 1);
  const t = (await bodies(w.supplier, 'Stock bas'))[0];
  assert.match(t, /il reste 3 unité/);
  assert.equal((await run()).stock, 0);                                                      // relancer ne crée rien
  assert.deepEqual(await moneyState(), before, 'aucune donnée d\'argent ni de stock modifiée');
  assert.equal(await count('SELECT count(*)::int AS n FROM fn_ledger_check()'), 0);
  await db.owner.query('UPDATE products SET reserved_qty = stock_qty WHERE id = $1', [low]);   // préparation du test : le stock est épuisé
  const after = await moneyState();
  assert.equal((await run()).stock, 1);                                                      // passage à la rupture : nouvelle alerte
  assert.ok((await titles(w.supplier)).includes('Rupture de stock'));
  assert.equal((await run()).stock, 0);
  assert.deepEqual(await moneyState(), after, 'les alertes ne modifient rien');
  // le produit très approvisionné ne déclenche rien
  assert.equal(await count(`SELECT count(*)::int AS n FROM notifications WHERE body LIKE '%' || (SELECT name FROM products WHERE id = $1) || '%' AND title IN ('Stock bas','Rupture de stock') AND dedupe_key LIKE '%' || $1 || '%'`, [product]), 0);
  await setSetting('alert_low_stock_qty', 0);
  await db.owner.query(`DELETE FROM notifications WHERE dedupe_key LIKE 'stock:%'`);
  assert.equal((await run()).stock, 0);
  await setSetting('alert_low_stock_qty', 5);
});

test('colis non récupéré : le livreur et les chefs d\'équipe sont prévenus une fois par affectation', async () => {
  const o = await mk();
  await call(db.app, 'fn_chief_assign', w.chief, o.id, w.courier);
  assert.equal((await run()).pickup, 0);                                                     // trop tôt (2 h par défaut)
  await db.owner.query('ALTER TABLE order_history DISABLE TRIGGER USER');
  await db.owner.query(`UPDATE order_history SET at = now() - interval '5 hours' WHERE order_id = $1 AND to_status = 'assigned'`, [o.id]);
  await db.owner.query('ALTER TABLE order_history ENABLE TRIGGER USER');
  assert.equal((await run()).pickup, 1);
  assert.ok((await titles(w.courier)).includes('Colis à récupérer'));
  assert.ok((await titles(w.chief)).includes('Colis non récupéré'));
  assert.equal((await run()).pickup, 0);                                                     // pas de doublon
  const ref = (await db.owner.query('SELECT ref FROM orders WHERE id = $1', [o.id])).rows[0].ref;
  assert.ok((await bodies(w.chief, 'Colis non récupéré'))[0].includes(ref));
  await call(db.app, 'fn_courier_pickup', w.courier, o.id);                                   // récupéré : plus d'alerte
  await db.owner.query(`DELETE FROM notifications WHERE dedupe_key LIKE 'pickup:%'`);
  assert.equal((await run()).pickup, 0);
  await call(db.app, 'fn_courier_depart', w.courier, o.id); await call(db.app, 'fn_courier_deliver', w.courier, o.id, await codeOf(db, ref));
});

test('argent à reverser : un rappel par jour au livreur, pas si le reversement est déjà fait ou en attente', async () => {
  assert.ok(await count('SELECT count(*)::int AS n FROM courier_cash_entries WHERE count_id IS NULL') > 0, 'de l\'argent encaissé existe');
  assert.equal((await run()).cash, 0);                                                       // trop récent (24 h)
  await db.owner.query(`UPDATE courier_cash_entries SET created_at = now() - interval '30 hours' WHERE count_id IS NULL`);
  const before = await moneyState();
  assert.equal((await run()).cash, 1);
  assert.match((await bodies(w.courier, 'Argent à reverser'))[0], /GNF encaissés depuis plus de 24 h/);
  assert.equal((await run()).cash, 0);                                                       // une seule fois par jour
  assert.deepEqual(await moneyState(), before);
  await db.owner.query(`DELETE FROM notifications WHERE dedupe_key LIKE 'cash:%'`);
  await db.owner.query(`UPDATE courier_cash_entries SET count_id = gen_random_uuid() WHERE count_id IS NULL`);   // reversement validé
  assert.equal((await run()).cash, 0);
});

test('numéro de versement manquant : rappel hebdomadaire aux personnes concernées, jamais à l\'admin ni au magasin', async () => {
  assert.equal((await run()).payout, 0);                                                     // comptes trop récents
  await db.owner.query(`UPDATE users SET created_at = now() - interval '5 days'`);
  const r = await run();
  assert.ok(r.payout >= 4);
  for (const who of [w.seller, w.supplier, w.courier, w.agent1, w.chief]) assert.ok((await titles(who)).includes('Numéro de versement manquant'), who);
  assert.ok(!(await titles(w.admin)).includes('Numéro de versement manquant'));
  assert.ok(!(await titles(w.warehouse)).includes('Numéro de versement manquant'));
  assert.equal((await run()).payout, 0);
  await db.owner.query(`DELETE FROM notifications WHERE dedupe_key LIKE 'payout:%'`);
  await db.owner.query(`UPDATE users SET payout_method = 'orange_money', payout_phone = '622000111' WHERE id = $1`, [w.seller]);
  await run();
  assert.ok(!(await titles(w.seller)).includes('Numéro de versement manquant'), 'plus de rappel une fois le numéro enregistré');
});

test('droits : la fonction de service n\'est pas une action utilisateur, les aides internes ne sont pas appelables', async () => {
  assert.equal((await db.owner.query(`SELECT has_function_privilege('wld_app', '_notify_once(uuid,text,text,text,text,text)', 'EXECUTE') AS e`)).rows[0].e, false);
  const r = (await db.owner.query(`SELECT prosecdef, proconfig::text AS c FROM pg_proc WHERE proname = 'fn_run_alerts'`)).rows[0];
  assert.equal(r.prosecdef, true); assert.match(r.c, /search_path=public, pg_temp/);
});

test('retour arrière 028 : retire la fonction, la colonne et les réglages ; migration rejouable', async () => {
  const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-028.sql'), 'utf8');
  await db.owner.query('BEGIN');
  try { for (const s of splitSql(rb)) { if (/^(begin|commit)$/i.test(s.trim())) continue; await db.owner.query(s); } await db.owner.query('COMMIT'); } catch (e) { await db.owner.query('ROLLBACK'); throw e; }
  assert.equal(await count(`SELECT (SELECT count(*) FROM pg_proc WHERE proname IN ('fn_run_alerts','_notify_once')) + (SELECT count(*) FROM information_schema.columns WHERE table_name = 'notifications' AND column_name = 'dedupe_key') + (SELECT count(*) FROM settings WHERE key LIKE 'alert\\_%') AS n`), 0);
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'fn_my_notifications'`)).rows[0].n, 1);   // les notifications (027) restent
  await migrate({ ...TEST_DB, database: 'wld_alertes' }, APP_PW, () => {});
  assert.equal(await count(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '028_alertes.sql'`), 1);
  assert.equal((await run()).payout >= 0, true);
});
