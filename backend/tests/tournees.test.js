// Étape 3 : tournées groupées (migration 020) — plusieurs commandes pour un livreur, chacune suivie séparément, rentabilité mesurée sans écriture comptable.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshDb, TEST_DB, APP_PW, world, approvedProduct, codeOf, call, expectErr } from './helpers.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';
import { migrate, splitSql } from '../src/migrate.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PW = 'Secret123';
let db, w, product, srv, base, n = 0, k = 0;
const count = async (sql, p = []) => Number((await db.owner.query(sql, p)).rows[0].n);
const phone = () => `6${String(++n).padStart(8, '0')}`;
const mk = (over = {}) => call(db.app, 'fn_seller_create_order_once', w.seller, `tour-test-key-${String(++k).padStart(8, '0')}`, product, null, null, 1, 'Client Test', phone(), over.commune ?? 'Kaloum', 'Rue 1 Kaloum', null, true);
const mkMany = async (x, over) => { const r = []; for (let i = 0; i < x; i++) r.push((await mk(over)).id); return r; };
const create = (orders, courier = w.courier, actor = w.chief, note = null) => call(db.app, 'fn_chief_create_tour', actor, courier, orders, note);
const status = async (id) => (await db.owner.query('SELECT status, courier_id FROM orders WHERE id = $1', [id])).rows[0];
const tours = async (actor = w.chief) => call(db.app, 'fn_chief_tours', actor);
const finish = async (id) => {                                                                       // livre une commande affectée
  const ref = (await db.owner.query('SELECT ref, courier_id FROM orders WHERE id = $1', [id])).rows[0];
  const pending = (await db.owner.query(`SELECT t.id FROM tour_stops s JOIN tours t ON t.id = s.tour_id WHERE s.order_id = $1 AND s.active AND t.status = 'proposed'`, [id])).rows[0];
  if (pending) await call(db.app, 'fn_courier_accept_tour', ref.courier_id, pending.id);                // la tournée proposée est d'abord acceptée par le livreur
  await call(db.app, 'fn_courier_pickup', ref.courier_id, id); await call(db.app, 'fn_courier_depart', ref.courier_id, id);
  await call(db.app, 'fn_courier_deliver', ref.courier_id, id, await codeOf(db, ref.ref));
};
const snap = async () => (await db.owner.query(`SELECT (SELECT md5(string_agg(key || value::text, ',' ORDER BY key)) FROM settings) AS s,
  (SELECT md5(string_agg(commune || fee::text || active::text, ',' ORDER BY commune)) FROM delivery_rates) AS z`)).rows[0];

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
const login = async (id) => {
  const c = new Client(); const ph = (await db.owner.query('SELECT phone FROM users WHERE id = $1', [id])).rows[0].phone;
  assert.equal((await c.post('/api/auth/login', { identifier: ph, password: PW })).status, 200); return c;
};

before(async () => {
  db = await freshDb('wld_tournees'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  product = await approvedProduct(db, w, { price: 60000, qty: 90 });
  await call(db.app, 'fn_seller_set_price', w.seller, product, 120000);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_tournees', user: 'wld_app', password: APP_PW, max: 8 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });

test('création : toutes les commandes affectées au livreur, ordre de passage conservé, sans plafond de nombre, aucune écriture financière', async () => {
  const ids = await mkMany(7); const before = await snap();
  const wallet = await count('SELECT count(*)::int AS n FROM wallet_entries');
  const id = await create(ids, w.courier, w.chief, '  Quartier Kaloum  ');                          // 7 commandes : bien au-delà du plafond de propositions (3)
  for (const o of ids) { const st = await status(o); assert.equal(st.status, 'assigned'); assert.equal(st.courier_id, w.courier); }
  const t = (await tours()).find((x) => x.id === id);
  assert.deepEqual(t.stops.map((s) => s.order_id), ids); assert.deepEqual(t.stops.map((s) => s.position), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(t.note, 'Quartier Kaloum'); assert.equal(t.status, 'proposed'); assert.equal(t.orders, 7);
  assert.equal(await count('SELECT count(*)::int AS n FROM wallet_entries'), wallet);                 // créer une tournée n'écrit rien en argent
  assert.deepEqual(await snap(), before);                                                             // ni réglage ni tarif
  const mine = await call(db.app, 'fn_courier_tours', w.courier); assert.equal(mine.length, 1); assert.equal(mine[0].stops.length, 7);
  assert.deepEqual(await call(db.app, 'fn_courier_tours', w.courier2), []);                          // un autre livreur ne la voit pas
  assert.equal(await count(`SELECT count(*)::int AS n FROM order_history WHERE order_id = ANY($1) AND to_status = 'assigned'`, [ids]), 7);
  await call(db.app, 'fn_chief_cancel_tour', w.chief, id);
});

test('validations : au moins 2 commandes, pas de doublon, états, livreur, rôles, commande déjà dans une tournée', async () => {
  const [a, b, c, d] = await mkMany(4);
  await expectErr(create([a]), 'invalid_input'); await expectErr(create([]), 'invalid_input'); await expectErr(create(null), 'invalid_input');
  await expectErr(create([a, a]), 'invalid_input');
  await expectErr(create([a, '00000000-0000-0000-0000-000000000009']), 'not_found');
  await expectErr(create([a, b], w.seller), 'not_found');                                            // pas un livreur
  for (const actor of [w.seller, w.agent1, w.courier, w.warehouse, w.supplier]) await expectErr(create([a, b], w.courier, actor), 'forbidden');
  await expectErr(create([a, b], w.courier, w.chief, 'x'.repeat(201)), 'invalid_input');
  const neuve = await mk(); await db.owner.query(`UPDATE orders SET status = 'new', confirmed_at = NULL WHERE id = $1`, [neuve.id]);
  await expectErr(create([a, neuve.id]), 'invalid_state');
  assert.equal((await status(a)).status, 'confirmed');                                               // refus complet : rien n'a été affecté
  const t1 = await create([a, b]);
  await expectErr(create([b, c], w.courier2), 'order_in_tour');
  assert.equal((await status(c)).status, 'confirmed');
  await call(db.app, 'fn_courier_accept_tour', w.courier, t1);                                        // acceptée : l'annulation laisse les commandes au livreur
  await call(db.app, 'fn_chief_cancel_tour', w.admin, t1);                                           // l'administrateur aussi
  await expectErr(call(db.app, 'fn_chief_cancel_tour', w.chief, t1), 'invalid_state');
  await expectErr(create([b, c, d], w.courier2, w.admin), 'invalid_state');                          // b reste affectée à un autre livreur
  const t2 = await create([b, c, d], w.courier, w.admin);
  assert.equal((await status(d)).courier_id, w.courier);
  await call(db.app, 'fn_chief_cancel_tour', w.chief, t2);
});

test('suivi par commande : livraison dans la tournée, encaissement et paie par commande inchangés, tournée close automatiquement', async () => {
  const ids = await mkMany(3); const id = await create(ids);
  const frozen = (await db.owner.query('SELECT courier_pay FROM orders WHERE id = $1', [ids[0]])).rows[0].courier_pay;
  await finish(ids[0]);
  let t = (await tours()).find((x) => x.id === id);
  assert.equal(t.status, 'active'); assert.equal(t.delivered, 1); assert.equal(t.stops.filter((s) => s.active).length, 2);
  assert.equal(Number((await db.owner.query(`SELECT amount FROM wallet_entries WHERE user_id = $1 AND kind = 'team_pay' AND order_id = $2`, [w.courier, ids[0]])).rows[0].amount), Number(frozen));
  await finish(ids[1]);
  await call(db.app, 'fn_courier_pickup', w.courier, ids[2]); await call(db.app, 'fn_courier_fail', w.courier, ids[2], 'customer_absent');   // échec : sort de la tournée
  t = (await tours()).find((x) => x.id === id);
  assert.equal(t.status, 'closed'); assert.ok(t.closed_at); assert.equal(t.delivered, 2);
  assert.deepEqual(await call(db.app, 'fn_courier_tours', w.courier), []);
  assert.equal(await count(`SELECT count(*)::int AS n FROM courier_cash_entries WHERE order_id = ANY($1)`, [ids]), 2);   // un encaissement par commande livrée, pas de double
  assert.equal(await count('SELECT count(*)::int AS n FROM fn_ledger_check()'), 0);
  const again = await create([ids[2], (await mk()).id], w.courier2);                                // la commande en échec peut entrer dans une nouvelle tournée
  assert.equal((await status(ids[2])).courier_id, w.courier2);
  await call(db.app, 'fn_chief_cancel_tour', w.chief, again);
});

test('rentabilité : frais encaissés, paie prévue, coût réel saisi (information seulement), marge calculée côté écran sans écriture comptable', async () => {
  const ids = await mkMany(3); const id = await create(ids);
  for (const o of ids) await finish(o);
  const wallet = await count('SELECT count(*)::int AS n FROM wallet_entries'); const before = await snap();
  let t = (await tours()).find((x) => x.id === id);
  assert.equal(Number(t.delivery_fees), 75000);                                                       // 3 x 25 000 (Kaloum)
  const pay = Number((await db.owner.query('SELECT sum(courier_pay) AS s FROM orders WHERE id = ANY($1)', [ids])).rows[0].s);
  assert.equal(Number(t.courier_pay_system), pay); assert.equal(t.actual_cost, null);
  await call(db.app, 'fn_chief_set_tour_cost', w.chief, id, 40000);
  t = (await tours(w.admin)).find((x) => x.id === id); assert.equal(Number(t.actual_cost), 40000);
  await expectErr(call(db.app, 'fn_chief_set_tour_cost', w.chief, id, -1), 'invalid_input');
  await expectErr(call(db.app, 'fn_chief_set_tour_cost', w.chief, '00000000-0000-0000-0000-000000000009', 10), 'not_found');
  await expectErr(call(db.app, 'fn_chief_set_tour_cost', w.agent1, id, 10), 'forbidden');
  await call(db.app, 'fn_chief_set_tour_cost', w.admin, id, null);                                    // effaçable
  assert.equal((await tours()).find((x) => x.id === id).actual_cost, null);
  assert.equal(await count('SELECT count(*)::int AS n FROM wallet_entries'), wallet);                 // aucune écriture d'argent
  assert.deepEqual(await snap(), before);
  assert.equal(await count('SELECT count(*)::int AS n FROM fn_ledger_check()'), 0);
});

test('annulation et réaffectation : la tournée annulée laisse les commandes au livreur ; une réaffectation manuelle sort la commande de la tournée', async () => {
  const [a, b, c] = await mkMany(3); const id = await create([a, b, c]);
  await call(db.app, 'fn_chief_assign', w.chief, b, w.courier2);                                      // affectation directe imposée
  let t = (await tours()).find((x) => x.id === id);
  assert.equal(t.stops.find((s) => s.order_id === b).active, false); assert.equal(t.status, 'proposed');
  await call(db.app, 'fn_staff_cancel_order', w.chief, c, 'Client injoignable');
  t = (await tours()).find((x) => x.id === id); assert.equal(t.stops.find((s) => s.order_id === c).active, false);
  await call(db.app, 'fn_courier_accept_tour', w.courier, id);
  await call(db.app, 'fn_chief_cancel_tour', w.chief, id);
  assert.equal((await status(a)).courier_id, w.courier); assert.equal((await status(a)).status, 'assigned');   // rien n'est repris
  assert.equal((await tours()).find((x) => x.id === id).status, 'cancelled');
  assert.equal(await count('SELECT count(*)::int AS n FROM fn_ledger_check()'), 0);
});

test('concurrence : deux tournées simultanées sur les mêmes commandes, une seule réussit ; aucune commande dans deux tournées actives', async () => {
  const ids = await mkMany(4);
  const res = await Promise.allSettled([create(ids, w.courier), create(ids, w.courier2), create(ids.slice(0, 2), w.courier2)]);
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(res.map((r) => r.reason?.message)));
  assert.equal(await count(`SELECT count(*)::int AS n FROM (SELECT order_id FROM tour_stops WHERE active GROUP BY order_id HAVING count(*) > 1) d`), 0);
  for (const t of await tours()) if (['proposed', 'active'].includes(t.status)) await call(db.app, 'fn_chief_cancel_tour', w.chief, t.id);
});

test('HTTP : chef crée, consulte, saisit un coût et annule ; livreur voit sa tournée ; accès croisés refusés', async () => {
  const ids = await mkMany(3); const chief = await login(w.chief), cou = await login(w.courier), cou2 = await login(w.courier2), sel = await login(w.seller);
  assert.equal((await chief.post('/api/chief/tours', { courier_id: w.courier, order_ids: [ids[0]] })).status, 400);
  assert.equal((await chief.post('/api/chief/tours', { courier_id: w.courier, order_ids: 'x' })).status, 400);
  assert.equal((await chief.post('/api/chief/tours', { courier_id: w.courier, order_ids: ['pas-un-id', ids[1]] })).status, 400);
  assert.equal((await sel.post('/api/chief/tours', { courier_id: w.courier, order_ids: ids })).status, 403);
  assert.equal((await cou.post('/api/chief/tours', { courier_id: w.courier, order_ids: ids })).status, 403);
  const r = await chief.post('/api/chief/tours', { courier_id: w.courier, order_ids: ids, note: 'Test' }); assert.equal(r.status, 201); assert.ok(r.json.id);
  assert.equal((await chief.post('/api/chief/tours', { courier_id: w.courier2, order_ids: ids })).status, 409);
  const list = await chief.get('/api/chief/tours'); assert.equal(list.status, 200); assert.ok(list.json.tours.some((t) => t.id === r.json.id && t.stops.length === 3));
  assert.equal((await cou.get('/api/chief/tours')).status, 403); assert.equal((await sel.get('/api/chief/tours')).status, 403);
  assert.equal((await cou.get('/api/courier/tours')).json.tours.length, 1); assert.equal((await cou2.get('/api/courier/tours')).json.tours.length, 0);
  assert.equal((await chief.get('/api/courier/tours')).status, 403);
  assert.equal((await chief.post(`/api/chief/tours/${r.json.id}/cost`, { cost: 'beaucoup' })).status, 400);
  assert.equal((await chief.post(`/api/chief/tours/${r.json.id}/cost`, { cost: 25000 })).status, 200);
  assert.equal((await cou.post(`/api/chief/tours/${r.json.id}/cost`, { cost: 1 })).status, 403);
  assert.equal((await chief.post(`/api/chief/tours/${r.json.id}/cancel`)).status, 200);
  assert.equal((await chief.post(`/api/chief/tours/${r.json.id}/cancel`)).status, 409);
});

test('droits SQL : tables en lecture seule pour l\'application, fonctions SECURITY DEFINER, fonction interne non exécutable', async () => {
  for (const t of ['tours', 'tour_stops']) for (const priv of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) assert.equal((await db.owner.query(`SELECT has_table_privilege('wld_app', $1, $2) AS p`, [t, priv])).rows[0].p, false, `${t} ${priv}`);
  await assert.rejects(db.app.query(`UPDATE tours SET status = 'closed'`), /permission denied/);
  await assert.rejects(db.app.query(`SELECT _tours_refresh()`), /permission denied/);
  const fns = (await db.owner.query(`SELECT proname, prosecdef, proconfig::text AS c, has_function_privilege('wld_app', oid, 'EXECUTE') AS e FROM pg_proc
     WHERE proname IN ('fn_chief_create_tour','fn_chief_cancel_tour','fn_chief_set_tour_cost','fn_chief_tours','fn_courier_tours','_tours_refresh') ORDER BY 1`)).rows;
  assert.equal(fns.length, 6);
  for (const f of fns) { assert.equal(f.prosecdef, true, f.proname); assert.match(f.c, /search_path=public, pg_temp/); assert.equal(f.e, !f.proname.startsWith('_'), f.proname); }
  assert.equal((await db.owner.query(`SELECT has_table_privilege('wld_app', 'order_requests', 'SELECT') AS p`)).rows[0].p, false);
});

test('remise à zéro de l\'activité avec des tournées enregistrées : réussit et les vide', async () => {
  assert.ok(await count('SELECT count(*)::int AS n FROM tours') > 0);
  await call(db.app, 'fn_admin_reset_activity', w.admin, 'REINITIALISER');
  assert.equal(await count('SELECT count(*)::int AS n FROM tours') + await count('SELECT count(*)::int AS n FROM tour_stops') + await count('SELECT count(*)::int AS n FROM orders'), 0);
});

test('retour arrière 020 : retire les tournées, restaure la remise à zéro de la 019, rien en argent ; migration rejouable', async () => {
  const fnames = "'fn_chief_create_tour','fn_chief_cancel_tour','fn_chief_set_tour_cost','fn_chief_tours','fn_courier_tours','_tours_refresh','fn_admin_reset_activity','fn_courier_remit','fn_chief_reorder_tour','fn_courier_pickup','fn_ledger_check','fn_courier_accept_tour','fn_courier_refuse_tour','_tour_pay_bonus','_tour_plan','_tour_target_pay','_tour_release_orders'";
  const snapAll = async () => (await db.owner.query(`SELECT (SELECT count(*) FROM wallet_entries)::text AS ecr,
     (SELECT md5(string_agg(key || value::text, ',' ORDER BY key)) FROM settings WHERE key NOT IN ('feature_order_channel','tour_bonus_per_extra_order','tour_share_bps','tour_extra_share_bps')) AS s,
     (SELECT string_agg(p.proname || ':' || md5(pg_get_functiondef(p.oid)) || ':' || COALESCE(p.proacl::text, '') || ':' || p.prosecdef::text, E'\\n' ORDER BY p.proname, p.oid::text) FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND p.proname NOT IN (${fnames},'fn_register','fn_set_payout','fn_change_payout','fn_withdrawal_request','fn_record_consent','fn_seller_set_channel','fn_admin_set_courier_agreement','fn_admin_end_courier_agreement','fn_admin_set_agent_agreement','fn_admin_end_agent_agreement','_courier_scale','_agent_pay_for','_company_scale','_courier_pay_quote','fn_chief_assign','fn_supplier_add_product','fn_set_product_category','fn_admin_set_category','fn_admin_classify_zone','fn_admin_zones_use_commune_fee','_default_category','fn_agent_log_call','_settle_delivery','fn_warehouse_receive_return','fn_admin_reset_activity','fn_admin_set_company','fn_company_get','_invoice_number','_issuer','_invoice_store','fn_invoice_issue_delivery','fn_invoice_issue_statement','fn_invoice_issue_withdrawal','fn_invoice_get','fn_invoice_list','fn_admin_finance_summary','fn_warehouse_count_stock','fn_admin_review_stock_count','_expected_shelf','fn_warehouse_expected','fn_warehouse_count_arrival','_notify_arrival','_notify_prepare','fn_warehouse_handover','fn_warehouse_declare_loss','fn_warehouse_return_note','fn_warehouse_add_return_photo','fn_return_photo_get','fn_register','_company_scale','_courier_kind','_courier_pay_quote','_order_pay','fn_admin_add_courier_expense','fn_admin_void_courier_expense','fn_admin_set_company_scale','fn_admin_set_courier_kind','_settle_delivery','fn_chief_assign','fn_courier_fail','fn_courier_offers','fn_chief_create_tour','fn_courier_tours','fn_chief_tours','fn_ledger_check','_tour_plan','_tour_pay_bonus')) AS fonctions`)).rows[0];
  const before = await snapAll();
  const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-038.sql'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'docs', 'retour-arriere-037.sql'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'docs', 'retour-arriere-036.sql'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'docs', 'retour-arriere-035.sql'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'docs', 'retour-arriere-034.sql'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'docs', 'retour-arriere-033.sql'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'docs', 'retour-arriere-032.sql'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'docs', 'retour-arriere-031.sql'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'docs', 'retour-arriere-030.sql'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'docs', 'retour-arriere-029.sql'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'docs', 'retour-arriere-026.sql'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'docs', 'retour-arriere-025.sql'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'docs', 'retour-arriere-024.sql'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'docs', 'retour-arriere-020.sql'), 'utf8');   // 024 d'abord (ordre inverse)
  await db.owner.query('BEGIN');
  for (const s of splitSql(rb)) { if (/^(begin|commit)$/i.test(s.trim())) continue; await db.owner.query(s); }
  await db.owner.query('COMMIT');
  assert.deepEqual(await snapAll(), before);
  assert.equal(await count(`SELECT (SELECT count(*) FROM pg_class WHERE relname IN ('tours','tour_stops')) + (SELECT count(*) FROM schema_migrations WHERE name = '020_tournees.sql')
     + (SELECT count(*) FROM pg_proc WHERE prosrc LIKE '%tour_stops%') AS n`), 0);
  await call(db.app, 'fn_admin_reset_activity', w.admin, 'REINITIALISER');                              // la version restaurée (019) fonctionne
  await migrate({ ...TEST_DB, database: 'wld_tournees' }, APP_PW, () => {});
  assert.equal(await count(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '020_tournees.sql'`), 1);
  assert.equal((await db.owner.query(`SELECT has_table_privilege('wld_app', 'tours', 'INSERT') AS p`)).rows[0].p, false);
});
