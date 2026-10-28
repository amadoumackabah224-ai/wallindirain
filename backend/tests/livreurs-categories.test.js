// Deux catégories de livreurs (migration 029) : indépendant (règles communes, inchangées) et de Wallindirain (barème séparé, daté, retenu à l'affectation).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshDb, TEST_DB, APP_PW, world, approvedProduct, codeOf, call, expectErr } from './helpers.js';
import { splitSql, migrate } from '../src/migrate.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLATFORM = '00000000-0000-0000-0000-000000000001';
let db, w, product, n = 0, k = 0;
const phone = () => `6${String(++n).padStart(8, '0')}`;
const num = async (sql, p = []) => Number((await db.owner.query(sql, p)).rows[0].n);
const mk = () => call(db.app, 'fn_seller_create_order_once', w.seller, `cat-test-key-${String(++k).padStart(8, '0')}`, product, null, null, 1, 'Client Test', phone(), 'Kaloum', 'Rue 1 Kaloum', null, true);
const assign = (id, courier) => call(db.app, 'fn_chief_assign', w.chief, id, courier);
const finishOne = async (id, courier) => {
  const ref = (await db.owner.query('SELECT ref FROM orders WHERE id = $1', [id])).rows[0].ref;
  await call(db.app, 'fn_courier_pickup', courier, id); await call(db.app, 'fn_courier_depart', courier, id);
  await call(db.app, 'fn_courier_deliver', courier, id, await codeOf(db, ref));
};
const deliverTo = async (courier) => { const o = await mk(); await assign(o.id, courier); await finishOne(o.id, courier); return o.id; };
const ord = async (id) => (await db.owner.query('SELECT status, courier_kind, courier_scale_id, courier_pay::bigint AS pay, courier_pay_paid::bigint AS paid, delivery_fee::bigint AS fee FROM orders WHERE id = $1', [id])).rows[0];
const sum = async (user, kind) => num(`SELECT COALESCE(sum(amount), 0) AS n FROM wallet_entries WHERE user_id = $1 AND ($2::text IS NULL OR kind = $2)`, [user, kind ?? null]);
const entriesOf = (kind, user) => num(`SELECT count(*)::int AS n FROM wallet_entries WHERE kind = $1 AND ($2::uuid IS NULL OR user_id = $2)`, [kind, user ?? null]);
const setKind = (courier, kind, actor = w.admin) => call(db.app, 'fn_admin_set_courier_kind', actor, courier, kind, null);
const setScale = (per, extra = 0, failed = 0, thr = 0, prime = 0, eff = null, actor = w.admin) => call(db.app, 'fn_admin_set_company_scale', actor, per, extra, failed, thr, prime, eff, null);
const ledger = () => num('SELECT count(*)::int AS n FROM fn_ledger_check()');
const fee = async () => Number((await db.owner.query(`SELECT fee FROM delivery_rates WHERE commune = 'Kaloum'`)).rows[0].fee);

before(async () => {
  db = await freshDb('wld_categories'); w = await world(db);
  product = await approvedProduct(db, w, { price: 60000, qty: 300 });
  await call(db.app, 'fn_seller_set_price', w.seller, product, 120000);
  w.courier3 = await call(db.app, 'fn_admin_create_staff', w.admin, phone(), 'courier3', 'courier', 'x', null);
});
after(async () => { await db.owner.end(); await db.app.end(); });

test('un livreur est indépendant par défaut ; aucune ligne, aucun barème, aucun montant créé par la migration', async () => {
  assert.equal((await db.owner.query('SELECT _courier_kind($1) AS k', [w.courier])).rows[0].k, 'independent');
  assert.equal(await num('SELECT count(*)::int AS n FROM courier_pay_scales'), 0);
  assert.equal(await num('SELECT count(*)::int AS n FROM courier_kind_log'), 0);
  assert.equal((await db.owner.query('SELECT _company_scale() AS s')).rows[0].s, null);
});

test('livreur de Wallindirain SANS barème : payé exactement comme un indépendant', async () => {
  await setKind(w.courier2, 'company');
  const a = await deliverTo(w.courier), b = await deliverTo(w.courier2);
  const A = await ord(a), B = await ord(b);
  assert.equal(A.courier_kind, 'independent'); assert.equal(B.courier_kind, 'company');
  assert.equal(B.courier_scale_id, null);
  assert.equal(A.paid, A.pay); assert.equal(B.paid, B.pay); assert.equal(B.paid, A.paid);
  assert.equal(await ledger(), 0);
});

test('barème Wallindirain : seul le livreur de Wallindirain est concerné, l\'indépendant garde sa paie', async () => {
  const f = await fee(); const per = Math.min(7000, f - 1);
  await setScale(per);
  const before = await sum(w.courier2, 'team_pay'), beforeInd = await sum(w.courier, 'team_pay'), beforePlat = await sum(PLATFORM, 'team_pay');
  const a = await deliverTo(w.courier), b = await deliverTo(w.courier2);
  const A = await ord(a), B = await ord(b);
  assert.equal(B.paid, per); assert.notEqual(B.courier_scale_id, null);
  assert.equal(A.paid, A.pay); assert.equal(A.courier_scale_id, null);                                            // l'indépendant : règles communes
  assert.equal(await sum(w.courier2, 'team_pay') - before, per);
  assert.equal(await sum(w.courier, 'team_pay') - beforeInd, A.pay);
  assert.equal(beforePlat - await sum(PLATFORM, 'team_pay'), per + A.pay);                                          // contrepartie sur Wallindirain, une seule fois
  assert.equal(await ledger(), 0);
});

test('le barème est retenu à l\'AFFECTATION : un nouveau barème ne change pas une mission déjà affectée', async () => {
  const f = await fee(); const v1 = Math.min(6000, f - 1), v2 = Math.min(9000, f - 1);
  await setScale(v1);
  const o = await mk(); await assign(o.id, w.courier2);
  await setScale(v2);                                                                                              // changé APRÈS l'affectation
  await finishOne(o.id, w.courier2);
  assert.equal((await ord(o.id)).paid, v1);
  assert.equal(await deliverTo(w.courier2).then(async (id) => (await ord(id)).paid), v2);                         // la mission suivante prend le nouveau barème
});

test('barème : jamais rétroactif, jamais au-dessus de la zone la moins chère, réservé à l\'administrateur ; 0 = retour aux règles communes', async () => {
  await expectErr(setScale(5000, 0, 0, 0, 0, new Date(Date.now() - 3600 * 1000).toISOString()), 'invalid_input');
  await expectErr(setScale(10 ** 9), 'courier_pay_exceeds_fee');
  await expectErr(setScale(5000, 0, 0, 3, 0), 'invalid_input');                                                      // prime incomplète
  await expectErr(setScale(5000, 0, 0, 0, 1000), 'invalid_input');
  await expectErr(setScale(-1), 'invalid_input');
  await expectErr(setScale(5000, 0, 0, 0, 0, null, w.chief), 'forbidden');
  await expectErr(setScale(5000, 0, 0, 0, 0, null, w.courier), 'forbidden');
  const future = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
  const cur = (await db.owner.query('SELECT _company_scale() AS s')).rows[0].s;
  await setScale(8000, 0, 0, 0, 0, future);                                                                          // daté dans le futur : sans effet maintenant
  assert.equal((await db.owner.query('SELECT _company_scale() AS s')).rows[0].s, cur);
  await setScale(0);                                                                                                  // retour aux règles communes
  assert.equal((await db.owner.query('SELECT _company_scale() AS s')).rows[0].s, null);
  const id = await deliverTo(w.courier2); const o = await ord(id);
  assert.equal(o.paid, o.pay); assert.equal(o.courier_scale_id, null);
  assert.ok(await num('SELECT count(*)::int AS n FROM audit_log WHERE action = \'courier_scale_set\'') >= 3);       // chaque version est tracée
  await assert.rejects(db.owner.query('UPDATE courier_pay_scales SET per_delivery = 1'), /append|immutable|interdit|modif/i);     // historique intouchable
  await assert.rejects(db.owner.query('DELETE FROM courier_pay_scales'), /append|immutable|interdit|modif/i);
});

test('changement de catégorie : refusé avec une mission, une proposition ou une tournée en cours ; sans effet rétroactif', async () => {
  const f = await fee(); await setScale(Math.min(7000, f - 1));
  const done = await deliverTo(w.courier2); const before = await ord(done);
  const open = await mk(); await assign(open.id, w.courier2);
  await expectErr(setKind(w.courier2, 'independent'), 'courier_busy');
  await finishOne(open.id, w.courier2);
  await expectErr(setKind(w.courier2, 'company'), 'invalid_state');                                                   // déjà de cette catégorie
  await expectErr(setKind(w.courier2, 'independent', w.chief), 'forbidden');
  await expectErr(setKind(w.courier2, 'moto'), 'invalid_input');
  await expectErr(setKind(w.admin, 'company'), 'not_found');
  await setKind(w.courier2, 'independent');
  assert.deepEqual(await ord(done), before);                                                                          // l'ancienne livraison ne bouge pas
  const next = await deliverTo(w.courier2); const N = await ord(next);
  assert.equal(N.courier_kind, 'independent'); assert.equal(N.paid, N.pay);
  await setKind(w.courier2, 'company');
  assert.equal(await num('SELECT count(*)::int AS n FROM courier_kind_log WHERE courier_id = $1', [w.courier2]), 3);   // historique complet : Wallindirain, indépendant, Wallindirain
  await setScale(0);
});

test('tournée d\'un livreur de Wallindirain : modes A/B refusés, supplément du barème versé une seule fois à la clôture', async () => {
  const f = await fee(); const per = Math.min(6000, f - 1), extra = Math.min(1500, f - per);
  await setScale(per, extra);
  const ids = []; for (let i = 0; i < 3; i++) ids.push((await mk()).id);
  await call(db.app, 'fn_admin_set_setting', w.admin, 'tour_share_bps', 6000);
  await expectErr(call(db.app, 'fn_chief_create_tour', w.chief, w.courier2, ids, null, 'share'), 'invalid_input');
  const tour = await call(db.app, 'fn_chief_create_tour', w.chief, w.courier2, ids, null, 'normal');
  const view = (await call(db.app, 'fn_courier_tours', w.courier2)).find((x) => x.id === tour);
  assert.equal(Number(view.plan_total), per * 3 + extra * 2);                                                         // annoncé avant d'accepter = ce qui sera payé
  await call(db.app, 'fn_courier_accept_tour', w.courier2, tour);
  const before = await sum(w.courier2, null);
  for (const id of ids) await finishOne(id, w.courier2);
  await call(db.app, 'fn_chief_tours', w.chief);                                                                      // clôture
  await call(db.app, 'fn_chief_tours', w.chief);                                                                      // rejouée : rien de plus
  assert.equal(await sum(w.courier2, null) - before, per * 3 + extra * 2);
  assert.equal(await entriesOf('tour_bonus', w.courier2), 1);
  assert.equal(await ledger(), 0);
  await setScale(0);
});

test('prime du jour : une seule fois par jour, au seuil ; indemnité de déplacement à vide : une seule fois par commande', async () => {
  const f = await fee(); const per = Math.min(5000, f - 1);
  await setScale(per, 0, 1000, 2, 3000);
  const p0 = await entriesOf('courier_prime', w.courier3);
  await setKind(w.courier3, 'company');
  await deliverTo(w.courier3);
  assert.equal(await entriesOf('courier_prime', w.courier3), p0);                                                     // seuil pas atteint
  await deliverTo(w.courier3);
  assert.equal(await entriesOf('courier_prime', w.courier3), p0 + 1);
  assert.equal(await sum(w.courier3, 'courier_prime'), 3000);
  await deliverTo(w.courier3);
  assert.equal(await entriesOf('courier_prime', w.courier3), p0 + 1);                                                 // pas une 2e fois le même jour
  const o = await mk(); await assign(o.id, w.courier3);
  const f0 = await sum(w.courier3, 'failed_trip');
  await call(db.app, 'fn_courier_fail', w.courier3, o.id, 'customer_absent');
  assert.equal(await sum(w.courier3, 'failed_trip') - f0, 1000);
  await assign(o.id, w.courier3); await call(db.app, 'fn_courier_fail', w.courier3, o.id, 'customer_absent');
  assert.equal(await sum(w.courier3, 'failed_trip') - f0, 1000);                                                      // jamais deux fois pour la même commande
  assert.equal(await ledger(), 0);
  await setScale(0);
});

test('charges de la moto : journal de l\'administrateur, annulation avec motif, aucune écriture dans le portefeuille', async () => {
  const w0 = await num('SELECT count(*)::int AS n FROM wallet_entries');
  const id = await call(db.app, 'fn_admin_add_courier_expense', w.admin, w.courier2, 'fuel', 15000, null, 'plein');
  await expectErr(call(db.app, 'fn_admin_add_courier_expense', w.chief, w.courier2, 'fuel', 1000, null, null), 'forbidden');
  await expectErr(call(db.app, 'fn_admin_add_courier_expense', w.admin, w.courier2, 'fuel', 0, null, null), 'invalid_input');
  await expectErr(call(db.app, 'fn_admin_add_courier_expense', w.admin, w.courier2, 'cadeau', 1000, null, null), 'invalid_input');
  await expectErr(call(db.app, 'fn_admin_add_courier_expense', w.admin, w.seller, 'fuel', 1000, null, null), 'not_found');
  await expectErr(call(db.app, 'fn_admin_void_courier_expense', w.admin, id, ''), 'invalid_input');
  await call(db.app, 'fn_admin_void_courier_expense', w.admin, id, 'saisie en double');
  await expectErr(call(db.app, 'fn_admin_void_courier_expense', w.admin, id, 'encore'), 'invalid_state');
  assert.equal(await num('SELECT count(*)::int AS n FROM courier_expenses WHERE voided_at IS NOT NULL'), 1);          // annulée, jamais effacée
  assert.equal(await num('SELECT count(*)::int AS n FROM wallet_entries'), w0);
});

test('droits : le rôle applicatif lit les tables mais ne peut ni écrire ni appeler les fonctions internes', async () => {
  assert.ok((await db.app.query('SELECT per_delivery, effective_from FROM courier_pay_scales')).rows.length >= 0);                  // lecture permise
  await assert.rejects(db.app.query(`INSERT INTO courier_pay_scales(per_delivery, effective_from) VALUES (1, now())`), /permission|denied/i);
  await assert.rejects(db.app.query(`UPDATE orders SET courier_pay_paid = 1`), /permission|denied/i);
  await assert.rejects(db.app.query(`SELECT _order_pay(o) FROM orders o LIMIT 1`), /permission|denied/i);
  await assert.rejects(db.app.query(`INSERT INTO courier_kind_log(courier_id, kind) VALUES ($1, 'company')`, [w.courier]), /permission|denied/i);
});

test('retour arrière 029 : refusé tant que des données financières existent ; sur une base sans barème, tout est retiré puis la migration se rejoue', async () => {
  const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-029.sql'), 'utf8');
  const run = async (pool) => { await pool.query('BEGIN'); try { for (const s of splitSql(rb)) { if (/^(begin|commit)$/i.test(s.trim())) continue; await pool.query(s); } await pool.query('COMMIT'); } catch (e) { await pool.query('ROLLBACK'); throw e; } };
  await assert.rejects(run(db.owner), /Retour arrière impossible/);                                                    // des livreurs/barèmes existent ici
  const db2 = await freshDb('wld_categories_rb'); const w2 = await world(db2);
  await run(db2.owner);
  const gone = await db2.owner.query(`SELECT (SELECT count(*) FROM pg_class WHERE relname IN ('courier_kind_log','courier_pay_scales','courier_expenses')) AS t,
    (SELECT count(*) FROM information_schema.columns WHERE table_name = 'orders' AND column_name IN ('courier_kind','courier_scale_id','courier_pay_paid')) AS c,
    (SELECT count(*) FROM pg_proc WHERE proname IN ('_courier_kind','_company_scale','_order_pay','_courier_pay_quote','fn_admin_set_courier_kind','fn_admin_set_company_scale','fn_admin_add_courier_expense')) AS f,
    (SELECT count(*) FROM schema_migrations WHERE name = '029_livreurs_categories.sql') AS m,
    (SELECT prosrc FROM pg_proc WHERE proname = 'fn_chief_assign') AS src`);
  assert.equal(Number(gone.rows[0].t) + Number(gone.rows[0].c) + Number(gone.rows[0].f) + Number(gone.rows[0].m), 0);
  assert.ok(!/courier_kind/.test(gone.rows[0].src));
  assert.equal(Number((await db2.owner.query('SELECT count(*)::int AS n FROM fn_ledger_check()')).rows[0].n), 0);
  await migrate({ ...TEST_DB, database: 'wld_categories_rb' }, APP_PW, () => {});                                       // rejouable
  assert.equal(Number((await db2.owner.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '029_livreurs_categories.sql'`)).rows[0].n), 1);
  await db2.owner.end(); await db2.app.end();
});
