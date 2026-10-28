// Étape 2 : propositions de mission (migration 019) — le chef propose, le livreur voit sa rémunération puis accepte ou refuse.
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
const setting = (key, value) => db.owner.query('UPDATE settings SET value = $2 WHERE key = $1', [key, value]);
const mk = (over = {}) => call(db.app, 'fn_seller_create_order_once', w.seller, `miss-test-key-${String(++k).padStart(8, '0')}`, product, null, null, 1, 'Client Test', phone(), over.commune ?? 'Kaloum', 'Rue 1 Kaloum', null, over.pre ?? true);   // pré-confirmée : prête à être proposée
const offer = (order, courier, chief = w.chief) => call(db.app, 'fn_chief_offer_order', chief, order, courier);
const status = async (id) => (await db.owner.query('SELECT status, courier_id, assigned_by FROM orders WHERE id = $1', [id])).rows[0];
const offerRow = async (id) => (await db.owner.query('SELECT * FROM mission_offers WHERE id = $1', [id])).rows[0];
const finance = async () => (await db.owner.query(`SELECT (SELECT count(*) FROM wallet_entries)::text || '/' || (SELECT COALESCE(sum(amount),0) FROM wallet_entries)::text AS ecr,
  (SELECT md5(string_agg(key || value::text, ',' ORDER BY key) ) FROM settings WHERE key NOT LIKE 'mission\\_%' AND key <> 'courier_max_open') AS s, (SELECT md5(string_agg(commune || fee::text || active::text, ',' ORDER BY commune)) FROM delivery_rates) AS z,
  (SELECT md5(string_agg(courier_pay::text || delivery_fee::text, ',' ORDER BY id)) FROM orders) AS o`)).rows[0];

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
  db = await freshDb('wld_missions'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  product = await approvedProduct(db, w, { price: 60000, qty: 80 });
  await call(db.app, 'fn_seller_set_price', w.seller, product, 120000);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_missions', user: 'wld_app', password: APP_PW, max: 8 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });

test('proposition puis acceptation : rémunération visible, données du client cachées, affectation existante, livraison et paie inchangées', async () => {
  const o = await mk(); const before = await finance();
  const m = await offer(o.id, w.courier);
  const list = await call(db.app, 'fn_courier_offers', w.courier);
  assert.equal(list.length, 1); assert.equal(list[0].id, m.id);
  const frozen = Number((await db.owner.query('SELECT courier_pay FROM orders WHERE id = $1', [o.id])).rows[0].courier_pay);
  assert.equal(Number(list[0].courier_pay), frozen); assert.equal(Number(list[0].amount_to_collect), 120000); assert.equal(list[0].commune, 'Kaloum');
  assert.doesNotMatch(JSON.stringify(list), /Rue 1|Client Test|\b6\d{8}\b/);                              // ni adresse, ni nom, ni téléphone avant d'accepter
  assert.deepEqual(await call(db.app, 'fn_courier_offers', w.courier2), []);                         // un autre livreur ne la voit pas
  await call(db.app, 'fn_courier_accept_offer', w.courier, m.id);
  const st = await status(o.id); assert.equal(st.status, 'assigned'); assert.equal(st.courier_id, w.courier); assert.equal(st.assigned_by, w.chief);
  assert.equal((await offerRow(m.id)).status, 'accepted');
  assert.equal(await count(`SELECT count(*)::int AS n FROM order_history WHERE order_id = $1 AND to_status = 'assigned'`, [o.id]), 1);
  await expectErr(call(db.app, 'fn_courier_accept_offer', w.courier, m.id), 'offer_unavailable');       // on n'accepte pas deux fois
  assert.deepEqual(await call(db.app, 'fn_courier_offers', w.courier), []);
  assert.deepEqual(await finance(), before);                                                          // proposer et accepter n'écrivent rien en argent
  await call(db.app, 'fn_courier_pickup', w.courier, o.id); await call(db.app, 'fn_courier_depart', w.courier, o.id);
  await call(db.app, 'fn_courier_deliver', w.courier, o.id, await codeOf(db, o.ref));
  assert.equal(Number((await db.owner.query(`SELECT amount FROM wallet_entries WHERE user_id = $1 AND kind = 'team_pay' AND order_id = $2`, [w.courier, o.id])).rows[0].amount), frozen);   // paie figée à la création, vue avant d'accepter
  assert.equal(await count('SELECT count(*)::int AS n FROM fn_ledger_check()'), 0);
});

test('refus : motif facultatif, aucune écriture financière, commande de nouveau proposable ; un livreur ne reçoit pas deux fois la même commande ; plafond de propositions', async () => {
  const o = await mk(); const before = await finance();
  const m1 = await offer(o.id, w.courier);
  await expectErr(call(db.app, 'fn_courier_refuse_offer', w.courier, m1.id, 'parce que'), 'invalid_input');
  await call(db.app, 'fn_courier_refuse_offer', w.courier, m1.id, 'too_far');
  const r = await offerRow(m1.id); assert.equal(r.status, 'refused'); assert.equal(r.refuse_reason, 'too_far');
  assert.equal((await status(o.id)).status, 'confirmed');
  await expectErr(call(db.app, 'fn_courier_refuse_offer', w.courier, m1.id), 'offer_unavailable');
  await expectErr(offer(o.id, w.courier), 'already_offered');
  const m2 = await offer(o.id, w.courier2); await call(db.app, 'fn_courier_refuse_offer', w.courier2, m2.id);             // sans motif
  assert.equal((await offerRow(m2.id)).refuse_reason, null);
  await db.owner.query(`INSERT INTO users(role, status, full_name, phone, password_hash) VALUES ('courier', 'active', 'Livreur Trois', '622000003', 'x')`);
  const c3 = (await db.owner.query(`SELECT id FROM users WHERE phone = '622000003'`)).rows[0].id;
  const m3 = await offer(o.id, c3); await call(db.app, 'fn_courier_refuse_offer', c3, m3.id);
  await db.owner.query(`INSERT INTO users(role, status, full_name, phone, password_hash) VALUES ('courier', 'active', 'Livreur Quatre', '622000004', 'x')`);
  const c4 = (await db.owner.query(`SELECT id FROM users WHERE phone = '622000004'`)).rows[0].id;
  await expectErr(offer(o.id, c4), 'max_offers_reached');                                                // 3 propositions : le chef affecte directement
  await call(db.app, 'fn_chief_assign', w.chief, o.id, c4);                                              // l'affectation directe reste possible
  assert.equal((await status(o.id)).courier_id, c4);
  assert.deepEqual(await finance(), before);                                                          // refus : aucune pénalité
});

test('expiration : vérifiée à chaque appel, sans minuteur ; réponse tardive refusée, rien d\'écrit en argent, commande de nouveau disponible', async () => {
  const o = await mk(); const before = await finance();
  const m = await offer(o.id, w.courier);
  await db.owner.query(`UPDATE mission_offers SET expires_at = now() - interval '1 minute' WHERE id = $1`, [m.id]);
  await expectErr(call(db.app, 'fn_courier_accept_offer', w.courier, m.id), 'offer_expired');   // un refus annule sa transaction : le statut est écrit à la lecture suivante
  await call(db.app, 'fn_courier_offers', w.courier);
  assert.equal((await offerRow(m.id)).status, 'expired');
  assert.equal((await status(o.id)).status, 'confirmed');
  const m2 = await offer(o.id, w.courier2);                                                              // la proposition échue ne bloque plus
  await db.owner.query(`UPDATE mission_offers SET expires_at = now() - interval '1 minute' WHERE id = $1`, [m2.id]);
  assert.deepEqual(await call(db.app, 'fn_courier_offers', w.courier2), []);                         // la liste la clôt aussi
  assert.equal((await offerRow(m2.id)).status, 'expired');
  await expectErr(call(db.app, 'fn_courier_refuse_offer', w.courier2, m2.id), 'offer_unavailable');
  assert.deepEqual(await finance(), before);
  await setting('mission_offer_minutes', 0);                                                             // réglage absurde : au moins 1 minute
  const o2 = await mk(); const m3 = await offer(o2.id, w.courier);
  assert.ok(new Date(m3.expires_at) > new Date(Date.now() + 30_000));
  await setting('mission_offer_minutes', 10);
  await call(db.app, 'fn_chief_cancel_offer', w.chief, m3.id);
});

test('pas de double attribution : une proposition ouverte par commande, acceptations simultanées, affectation manuelle ou annulation entre-temps', async () => {
  const o = await mk(); const m = await offer(o.id, w.courier);
  await expectErr(offer(o.id, w.courier2), 'offer_open');
  const res = await Promise.allSettled(Array.from({ length: 5 }, () => call(db.app, 'fn_courier_accept_offer', w.courier, m.id)));
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await status(o.id)).courier_id, w.courier);
  assert.equal(await count(`SELECT count(*)::int AS n FROM order_history WHERE order_id = $1 AND to_status = 'assigned'`, [o.id]), 1);
  // le chef affecte à la main avant la réponse
  const o2 = await mk(); const m2 = await offer(o2.id, w.courier2);
  await call(db.app, 'fn_chief_assign', w.chief, o2.id, w.courier);
  await expectErr(call(db.app, 'fn_courier_accept_offer', w.courier2, m2.id), 'offer_unavailable');
  assert.equal((await status(o2.id)).courier_id, w.courier);
  await call(db.app, 'fn_courier_offers', w.courier2); assert.equal((await offerRow(m2.id)).status, 'cancelled');
  // annulation de la commande avant la réponse
  const o3 = await mk(); const m3 = await offer(o3.id, w.courier2);
  await call(db.app, 'fn_staff_cancel_order', w.chief, o3.id, 'Client injoignable');
  assert.deepEqual(await call(db.app, 'fn_courier_offers', w.courier2), []);
  await expectErr(call(db.app, 'fn_courier_accept_offer', w.courier2, m3.id), 'offer_unavailable');
  assert.equal((await status(o3.id)).status, 'cancelled');
  assert.equal(await count('SELECT count(*)::int AS n FROM fn_ledger_check()'), 0);
});

test('règles : indisponible, plafond de missions (affectation directe non limitée), sans zone permis, états et rôles', async () => {
  const o = await mk();
  await call(db.app, 'fn_courier_set_availability', w.courier2, false);
  await expectErr(offer(o.id, w.courier2), 'courier_unavailable');
  await call(db.app, 'fn_courier_set_availability', w.courier2, true);
  assert.deepEqual((await call(db.app, 'fn_courier_profile', w.courier2)).zones, []);                 // sans zone : permis
  await setting('courier_max_open', 2);
  const a = await mk(), b = await mk(), c = await mk();
  await call(db.app, 'fn_chief_assign', w.chief, a.id, w.courier2); await call(db.app, 'fn_chief_assign', w.chief, b.id, w.courier2);
  await expectErr(offer(o.id, w.courier2), 'courier_busy');
  await call(db.app, 'fn_chief_assign', w.chief, c.id, w.courier2);                                   // direct : imposé, sans plafond
  assert.equal((await status(c.id)).courier_id, w.courier2);
  await setting('courier_max_open', 3);
  const fresh = await mk(); await expectErr(offer(fresh.id, w.courier2), 'courier_busy');            // 3 en cours
  const neuve = await mk({ pre: false });                                                              // pas encore confirmée
  await expectErr(offer(neuve.id, w.courier), 'invalid_state');
  await expectErr(offer(fresh.id, w.seller), 'not_found');                                            // pas un livreur
  await expectErr(offer(fresh.id, '00000000-0000-0000-0000-000000000009'), 'not_found');
  for (const actor of [w.seller, w.agent1, w.courier, w.warehouse, w.supplier]) await expectErr(offer(fresh.id, w.courier, actor), 'forbidden');
  const m = await offer(fresh.id, w.courier);
  await expectErr(call(db.app, 'fn_courier_accept_offer', w.courier2, m.id), 'not_found');           // la proposition d'un autre
  await expectErr(call(db.app, 'fn_courier_refuse_offer', w.courier2, m.id), 'offer_unavailable');
  for (const actor of [w.seller, w.agent1, w.admin]) await expectErr(call(db.app, 'fn_courier_offers', actor), 'forbidden');
  await expectErr(call(db.app, 'fn_chief_cancel_offer', w.agent1, m.id), 'forbidden');
  await call(db.app, 'fn_chief_cancel_offer', w.admin, m.id);                                         // l'administrateur peut aussi proposer et retirer
  await expectErr(call(db.app, 'fn_chief_cancel_offer', w.chief, m.id), 'invalid_state');
  await expectErr(call(db.app, 'fn_courier_accept_offer', w.courier, m.id), 'offer_unavailable');
});

test('commande en échec : peut être reproposée à un autre livreur', async () => {
  await setting('courier_max_open', 50);                                                                 // les tests précédents ont chargé ce livreur
  const o = await mk(); await call(db.app, 'fn_chief_assign', w.chief, o.id, w.courier);
  await call(db.app, 'fn_courier_fail', w.courier, o.id, 'customer_absent');
  const m = await offer(o.id, w.courier2);
  assert.equal((await call(db.app, 'fn_courier_offers', w.courier2))[0].retry, true);
  await call(db.app, 'fn_courier_accept_offer', w.courier2, m.id);
  const st = await status(o.id); assert.equal(st.status, 'assigned'); assert.equal(st.courier_id, w.courier2);
});

test('HTTP : parcours chef et livreur, accès croisés refusés, codes d\'erreur', async () => {
  const o = await mk(); const chief = await login(w.chief), cou = await login(w.courier), cou2 = await login(w.courier2), sel = await login(w.seller);
  const r = await chief.post(`/api/chief/orders/${o.id}/offer`, { courier_id: w.courier }); assert.equal(r.status, 201); assert.ok(r.json.id);
  assert.equal((await chief.post(`/api/chief/orders/${o.id}/offer`, { courier_id: w.courier2 })).json.error, 'offer_open');
  assert.equal((await chief.post(`/api/chief/orders/${o.id}/offer`, { courier_id: 'x' })).status, 400);
  assert.equal((await sel.post(`/api/chief/orders/${o.id}/offer`, { courier_id: w.courier })).status, 403);
  assert.equal((await cou.post(`/api/chief/orders/${o.id}/offer`, { courier_id: w.courier })).status, 403);
  const ov = await chief.get('/api/chief/offers'); assert.equal(ov.status, 200); assert.ok(ov.json.open.some((x) => x.id === r.json.id)); assert.equal(ov.json.counts[o.id], 1); assert.equal(ov.json.max_offers, 3);
  assert.equal((await cou.get('/api/chief/offers')).status, 403);
  const mine = await cou.get('/api/courier/offers'); assert.equal(mine.status, 200); assert.equal(mine.json.offers.length, 1);
  assert.equal((await cou2.get('/api/courier/offers')).json.offers.length, 0);
  assert.equal((await chief.get('/api/courier/offers')).status, 403);
  assert.equal((await cou2.post(`/api/courier/offers/${r.json.id}/accept`)).status, 404);
  assert.equal((await cou.post(`/api/courier/offers/${r.json.id}/refuse`, { reason: 'zzz' })).status, 400);
  assert.equal((await cou.post(`/api/courier/offers/pas-un-id/accept`)).status, 400);
  assert.equal((await cou.post(`/api/courier/offers/${r.json.id}/accept`)).status, 200);
  assert.equal((await cou.post(`/api/courier/offers/${r.json.id}/accept`)).json.error, 'offer_unavailable');
  assert.equal((await chief.post(`/api/chief/offers/${r.json.id}/cancel`)).status, 409);
  const o2 = await mk(); const r2 = await chief.post(`/api/chief/orders/${o2.id}/offer`, { courier_id: w.courier2 });
  assert.equal((await chief.post(`/api/chief/offers/${r2.json.id}/cancel`)).status, 200);
  const o3 = await mk(); const r3 = await chief.post(`/api/chief/orders/${o3.id}/offer`, { courier_id: w.courier2 });
  assert.equal((await cou2.post(`/api/courier/offers/${r3.json.id}/refuse`, { reason: 'busy' })).status, 200);
  assert.equal((await cou2.post(`/api/courier/offers/${r3.json.id}/refuse`, {})).status, 409);
});

test('droits SQL : propositions en lecture seule pour l\'application, fonctions SECURITY DEFINER, fonctions internes non exécutables, aucun accès aux autres tables sensibles', async () => {
  for (const priv of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) assert.equal((await db.owner.query(`SELECT has_table_privilege('wld_app', 'mission_offers', $1) AS p`, [priv])).rows[0].p, false, priv);
  await assert.rejects(db.app.query(`UPDATE mission_offers SET status = 'accepted'`), /permission denied/);
  await assert.rejects(db.app.query(`SELECT _expire_offers()`), /permission denied/);
  await assert.rejects(db.app.query(`SELECT _courier_load('${w.courier}')`), /permission denied/);
  const fns = (await db.owner.query(`SELECT proname, prosecdef, proconfig::text AS c, has_function_privilege('wld_app', oid, 'EXECUTE') AS e FROM pg_proc
     WHERE proname IN ('fn_chief_offer_order','fn_chief_cancel_offer','fn_chief_offers','fn_courier_offers','fn_courier_accept_offer','fn_courier_refuse_offer','_expire_offers','_courier_load') ORDER BY 1`)).rows;
  assert.equal(fns.length, 8);
  for (const f of fns) { assert.equal(f.prosecdef, true, f.proname); assert.match(f.c, /search_path=public, pg_temp/); assert.equal(f.e, !f.proname.startsWith('_'), f.proname); }
  assert.equal((await db.owner.query(`SELECT has_table_privilege('wld_app', 'order_requests', 'SELECT') AS p`)).rows[0].p, false);
});

test('remise à zéro de l\'activité avec des propositions enregistrées : réussit et les vide', async () => {
  assert.ok(await count('SELECT count(*)::int AS n FROM mission_offers') > 0);
  await call(db.app, 'fn_admin_reset_activity', w.admin, 'REINITIALISER');
  assert.equal(await count('SELECT count(*)::int AS n FROM mission_offers'), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM orders'), 0);
});

test('retour arrière 019 : retire propositions et réglages ajoutés, restaure la remise à zéro, rien en argent ; migration rejouable', async () => {
  const snap = async () => (await db.owner.query(`SELECT (SELECT count(*) FROM wallet_entries)::text AS ecr, (SELECT count(*) FROM orders)::text AS cmd,
     (SELECT md5(string_agg(key || value::text, ',' ORDER BY key)) FROM settings WHERE key NOT IN ('mission_offer_minutes','mission_max_offers','courier_max_open','tour_bonus_per_extra_order','tour_share_bps','tour_extra_share_bps')) AS s,
     (SELECT string_agg(p.proname || ':' || md5(pg_get_functiondef(p.oid)) || ':' || COALESCE(p.proacl::text, '') || ':' || p.prosecdef::text || ':' || COALESCE(p.proconfig::text, ''), E'\\n' ORDER BY p.proname, p.oid::text) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
        AND p.proname NOT IN ('fn_chief_offer_order','fn_chief_cancel_offer','fn_chief_offers','fn_courier_offers','fn_courier_accept_offer','fn_courier_refuse_offer','_expire_offers','_courier_load','fn_admin_reset_activity','fn_chief_create_tour','fn_chief_cancel_tour','fn_chief_set_tour_cost','fn_chief_tours','fn_courier_tours','_tours_refresh','fn_courier_pickup','fn_ledger_check','fn_chief_reorder_tour','fn_courier_remit','fn_courier_accept_tour','fn_courier_refuse_tour','_tour_pay_bonus','_tour_plan','_tour_target_pay','_tour_release_orders','_company_scale','_courier_kind','_courier_pay_quote','_order_pay','fn_admin_add_courier_expense','fn_admin_void_courier_expense','fn_admin_set_company_scale','fn_admin_set_courier_kind','_settle_delivery','fn_chief_assign','fn_courier_fail','fn_register','fn_admin_reset_activity','fn_warehouse_count_arrival','_notify_arrival','_notify_prepare','fn_warehouse_handover','fn_warehouse_declare_loss','fn_warehouse_return_note','fn_warehouse_add_return_photo','fn_return_photo_get')) AS fonctions`)).rows[0];
  const before = await snap();
  const rb = ['031', '030', '029', '026', '025', '024', '020'].map((x) => fs.readFileSync(path.join(root, 'docs', `retour-arriere-${x}.sql`), 'utf8')).join('\n') + '\n' + fs.readFileSync(path.join(root, 'docs', 'retour-arriere-019.sql'), 'utf8');   // 020 d'abord (ordre inverse)
  await db.owner.query('BEGIN');
  for (const s of splitSql(rb)) { if (/^(begin|commit)$/i.test(s.trim())) continue; await db.owner.query(s); }
  await db.owner.query('COMMIT');
  assert.deepEqual(await snap(), before);
  assert.equal(await count(`SELECT (SELECT count(*) FROM pg_class WHERE relname = 'mission_offers') + (SELECT count(*) FROM settings WHERE key IN ('mission_offer_minutes','mission_max_offers','courier_max_open'))
     + (SELECT count(*) FROM schema_migrations WHERE name = '019_missions.sql') + (SELECT count(*) FROM pg_proc WHERE prosrc LIKE '%mission_offers%') AS n`), 0);
  await call(db.app, 'fn_admin_reset_activity', w.admin, 'REINITIALISER');                              // la version restaurée fonctionne
  await migrate({ ...TEST_DB, database: 'wld_missions' }, APP_PW, () => {});
  assert.equal(await count(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '019_missions.sql'`), 1);
  assert.equal(await count(`SELECT count(*)::int AS n FROM settings WHERE key IN ('mission_offer_minutes','mission_max_offers','courier_max_open')`), 3);
  assert.equal((await db.owner.query(`SELECT has_table_privilege('wld_app', 'mission_offers', 'INSERT') AS p`)).rows[0].p, false);
});
