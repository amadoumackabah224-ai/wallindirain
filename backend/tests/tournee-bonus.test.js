// Étape 8 : la tournée est proposée au livreur, qui l'accepte avant de partir ; bonus de tournée paramétrable (0 par défaut) (migration 025).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshDb, TEST_DB, APP_PW, world, approvedProduct, codeOf, call, expectErr } from './helpers.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';
import { splitSql, migrate } from '../src/migrate.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PW = 'Secret123';
const PLATFORM = '00000000-0000-0000-0000-000000000001';
let db, w, product, srv, base, n = 0, k = 0;
const count = async (sql, p = []) => Number((await db.owner.query(sql, p)).rows[0].n);
const phone = () => `6${String(++n).padStart(8, '0')}`;
const mk = () => call(db.app, 'fn_seller_create_order_once', w.seller, `bonus-test-key-${String(++k).padStart(8, '0')}`, product, null, null, 1, 'Client Test', phone(), 'Kaloum', 'Rue 1 Kaloum', null, true);
const mkMany = async (x) => { const r = []; for (let i = 0; i < x; i++) r.push((await mk()).id); return r; };
const create = (orders, courier = w.courier, actor = w.chief) => call(db.app, 'fn_chief_create_tour', actor, courier, orders, null);
const tour = async (id) => (await call(db.app, 'fn_chief_tours', w.chief)).find((x) => x.id === id);
const row = async (id) => (await db.owner.query('SELECT * FROM tours WHERE id = $1', [id])).rows[0];
const ost = async (id) => (await db.owner.query('SELECT status, courier_id FROM orders WHERE id = $1', [id])).rows[0];
const sum = async (user, kind) => Number((await db.owner.query(`SELECT COALESCE(sum(amount), 0) AS s FROM wallet_entries WHERE user_id = $1 AND ($2::text IS NULL OR kind = $2)`, [user, kind ?? null])).rows[0].s);
const setBonus = (v) => call(db.app, 'fn_admin_set_setting', w.admin, 'tour_bonus_per_extra_order', v);
const deliverOne = async (id, courier = w.courier) => {
  const ref = (await db.owner.query('SELECT ref FROM orders WHERE id = $1', [id])).rows[0].ref;
  await call(db.app, 'fn_courier_pickup', courier, id); await call(db.app, 'fn_courier_depart', courier, id);
  await call(db.app, 'fn_courier_deliver', courier, id, await codeOf(db, ref));
};
const entries = (kind) => count(`SELECT count(*)::int AS n FROM wallet_entries WHERE kind = $1`, [kind]);

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
const runRollback = async () => { const rb = ['031', '030', '029', '026', '025'].map((x) => fs.readFileSync(path.join(root, 'docs', `retour-arriere-${x}.sql`), 'utf8')).join('\n'); await db.owner.query('BEGIN'); try { for (const s of splitSql(rb)) { if (/^(begin|commit)$/i.test(s.trim())) continue; await db.owner.query(s); } await db.owner.query('COMMIT'); } catch (e) { await db.owner.query('ROLLBACK'); throw e; } };

before(async () => {
  db = await freshDb('wld_bonus'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  product = await approvedProduct(db, w, { price: 60000, qty: 150 });
  await call(db.app, 'fn_seller_set_price', w.seller, product, 120000);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_bonus', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });

test('retour arrière 025 (aucun bonus versé) : retire acceptation et bonus, restaure les fonctions d\'avant ; migration rejouable', async () => {
  const names = "'fn_courier_accept_tour','fn_courier_refuse_tour','_tour_pay_bonus','_tour_plan','_tour_target_pay','_tour_release_orders','fn_chief_create_tour','fn_chief_cancel_tour','_tours_refresh','fn_courier_tours','fn_chief_tours','fn_courier_pickup','fn_ledger_check','fn_chief_reorder_tour'";
  const snap = async () => (await db.owner.query(`SELECT (SELECT count(*) FROM wallet_entries)::text AS ecr, (SELECT count(*) FROM orders)::text AS cmd,
     (SELECT md5(string_agg(key || value::text, ',' ORDER BY key)) FROM settings WHERE key NOT IN ('tour_bonus_per_extra_order','tour_share_bps','tour_extra_share_bps')) AS s,
     (SELECT string_agg(p.proname || ':' || md5(pg_get_functiondef(p.oid)) || ':' || COALESCE(p.proacl::text, ''), E'\\n' ORDER BY p.proname, p.oid::text) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND p.proname NOT IN (${names},'fn_admin_reset_activity','fn_warehouse_count_arrival','_notify_arrival','_notify_prepare','fn_warehouse_handover','fn_warehouse_declare_loss','fn_warehouse_return_note','fn_warehouse_add_return_photo','fn_return_photo_get','fn_register','_company_scale','_courier_kind','_courier_pay_quote','_order_pay','fn_admin_add_courier_expense','fn_admin_void_courier_expense','fn_admin_set_company_scale','fn_admin_set_courier_kind','_settle_delivery','fn_chief_assign','fn_courier_fail','fn_courier_offers','fn_chief_create_tour','fn_courier_tours','fn_chief_tours','fn_ledger_check','_tour_plan','_tour_pay_bonus')) AS fonctions`)).rows[0];
  assert.equal(Number((await db.owner.query(`SELECT value FROM settings WHERE key = 'tour_bonus_per_extra_order'`)).rows[0].value), 0);     // 0 par défaut : aucun changement de paie
  await create(await mkMany(2));                                                                                                           // une tournée « proposée » existe
  const before = await snap();
  await runRollback();
  assert.deepEqual(await snap(), before);
  assert.equal(await count(`SELECT (SELECT count(*) FROM information_schema.columns WHERE table_name = 'tours' AND column_name IN ('bonus_per_extra','accepted_at','bonus_paid')) + (SELECT count(*) FROM pg_proc WHERE proname IN ('fn_courier_accept_tour','_tour_pay_bonus'))
     + (SELECT count(*) FROM settings WHERE key = 'tour_bonus_per_extra_order') + (SELECT count(*) FROM schema_migrations WHERE name = '025_tournee_acceptation_bonus.sql') AS n`), 0);
  assert.equal(await count(`SELECT count(*)::int AS n FROM tours WHERE status IN ('proposed', 'refused')`), 0);                           // les tournées proposées sont devenues « annulées »
  await migrate({ ...TEST_DB, database: 'wld_bonus' }, APP_PW, () => {});
  assert.equal(await count(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '025_tournee_acceptation_bonus.sql'`), 1);
  for (const t of await call(db.app, 'fn_chief_tours', w.chief)) if (['proposed', 'active'].includes(t.status)) await call(db.app, 'fn_chief_cancel_tour', w.chief, t.id);
});

test('la tournée est proposée : le livreur ne peut pas récupérer un colis avant d\'avoir accepté', async () => {
  const ids = await mkMany(3); const id = await create(ids);
  assert.equal((await row(id)).status, 'proposed'); assert.equal((await row(id)).accepted_at, null);
  for (const o of ids) assert.deepEqual(await ost(o), { status: 'assigned', courier_id: w.courier });                                     // déjà affectées au livreur
  await expectErr(call(db.app, 'fn_courier_pickup', w.courier, ids[0]), 'tour_not_accepted');
  assert.equal((await ost(ids[0])).status, 'assigned');
  const t = await tour(id); assert.equal(t.status, 'proposed'); assert.equal(t.accepted_at, null);
  const mine = await call(db.app, 'fn_courier_tours', w.courier); assert.equal(mine[0].status, 'proposed'); assert.ok(mine[0].stops.every((s) => Number(s.pay) > 0));
  for (const actor of [w.courier2, w.chief, w.seller, w.admin]) await expectErr(call(db.app, 'fn_courier_accept_tour', actor, id), actor === w.courier2 ? 'not_found' : 'forbidden');
  await call(db.app, 'fn_courier_accept_tour', w.courier, id);
  assert.equal((await row(id)).status, 'active'); assert.ok((await row(id)).accepted_at);
  await expectErr(call(db.app, 'fn_courier_accept_tour', w.courier, id), 'invalid_state');
  await expectErr(call(db.app, 'fn_courier_refuse_tour', w.courier, id), 'invalid_state');
  await call(db.app, 'fn_courier_pickup', w.courier, ids[0]);                                                                              // maintenant possible
  assert.equal((await ost(ids[0])).status, 'picked_up');
  await call(db.app, 'fn_chief_cancel_tour', w.chief, id);
});

test('refus du livreur ou annulation avant acceptation : les commandes retournent au chef, sans pénalité ni écriture d\'argent', async () => {
  const wallet = await count('SELECT count(*)::int AS n FROM wallet_entries');
  const a = await mkMany(2); const t1 = await create(a);
  await expectErr(call(db.app, 'fn_courier_refuse_tour', w.courier2, t1), 'not_found');
  await call(db.app, 'fn_courier_refuse_tour', w.courier, t1);
  assert.equal((await row(t1)).status, 'refused'); for (const o of a) assert.deepEqual(await ost(o), { status: 'confirmed', courier_id: null });
  assert.equal(await count('SELECT count(*)::int AS n FROM tour_stops WHERE tour_id = $1 AND active', [t1]), 0);
  assert.deepEqual(await call(db.app, 'fn_courier_tours', w.courier), []);
  const t2 = await create(a, w.courier2);                                                                                                  // les commandes se reproposent à un autre livreur
  await call(db.app, 'fn_chief_cancel_tour', w.chief, t2);                                                                                 // annulation avant acceptation
  assert.equal((await row(t2)).status, 'cancelled'); for (const o of a) assert.deepEqual(await ost(o), { status: 'confirmed', courier_id: null });
  const t3 = await create(a); await call(db.app, 'fn_courier_accept_tour', w.courier, t3); await call(db.app, 'fn_chief_cancel_tour', w.chief, t3);
  for (const o of a) assert.deepEqual(await ost(o), { status: 'assigned', courier_id: w.courier });                                        // acceptée puis annulée : restent affectées (comportement d'avant)
  assert.equal(await count('SELECT count(*)::int AS n FROM wallet_entries'), wallet);
  await call(db.app, 'fn_chief_assign', w.chief, a[0], w.courier2);
  await call(db.app, 'fn_chief_assign', w.chief, a[1], w.courier2);
});

test('bonus à 0 par défaut : la tournée livrée ne verse aucun bonus, la paie reste celle de chaque commande', async () => {
  const ids = await mkMany(3); const id = await create(ids); await call(db.app, 'fn_courier_accept_tour', w.courier, id);
  const pay = Number((await db.owner.query('SELECT sum(courier_pay) AS s FROM orders WHERE id = ANY($1)', [ids])).rows[0].s);
  const before = await sum(w.courier);
  for (const o of ids) await deliverOne(o);
  const t = await tour(id); assert.equal(t.status, 'closed'); assert.equal(t.bonus_paid, null);
  assert.equal(await sum(w.courier) - before, pay); assert.equal(await entries('tour_bonus'), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM fn_ledger_check()'), 0);
});

test('bonus activé : figé à la création, versé une seule fois, seulement pour les commandes livrées à partir de la 2e, jamais au-delà de la marge', async () => {
  await setBonus(2000);
  const ids = await mkMany(3); const id = await create(ids);
  assert.equal(Number((await row(id)).bonus_per_extra), 2000);
  await setBonus(9999);                                                                                                                    // un changement ultérieur ne touche pas une tournée créée
  assert.equal(Number((await row(id)).bonus_per_extra), 2000);
  const proposed = await tour(id); assert.equal(Number(proposed.planned_bonus), 4000);
  assert.equal((await call(db.app, 'fn_courier_tours', w.courier))[0].bonus_max, 4000);
  await call(db.app, 'fn_courier_accept_tour', w.courier, id);
  const before = await sum(w.courier);
  await deliverOne(ids[0]); await deliverOne(ids[1]);
  assert.equal(await entries('tour_bonus'), 0);                                                                                            // rien tant que la tournée n'est pas close
  await call(db.app, 'fn_courier_pickup', w.courier, ids[2]); await call(db.app, 'fn_courier_fail', w.courier, ids[2], 'customer_absent');   // la 3e échoue : pas de bonus pour elle
  const t = await tour(id); assert.equal(t.status, 'closed'); assert.equal(Number(t.bonus_paid), 2000);                                   // 2 livrées : 1 commande « à partir de la 2e »
  for (let i = 0; i < 3; i++) await call(db.app, 'fn_chief_tours', w.chief);                                                              // relectures : jamais de second versement
  assert.equal(await entries('tour_bonus'), 2); assert.equal(await sum(w.courier, 'tour_bonus'), 2000); assert.equal(await sum(PLATFORM, 'tour_bonus'), -2000);
  const pay = Number((await db.owner.query('SELECT sum(courier_pay) AS s FROM orders WHERE id = ANY($1) AND status = $2', [ids, 'delivered'])).rows[0].s);
  assert.equal(await sum(w.courier) - before, pay + 2000);
  assert.equal(await count('SELECT count(*)::int AS n FROM fn_ledger_check()'), 0);
  // une seule commande livrée : pas de bonus
  const solo = await mkMany(2); const t2 = await create(solo); await call(db.app, 'fn_courier_accept_tour', w.courier, t2);
  await deliverOne(solo[0]); await call(db.app, 'fn_courier_pickup', w.courier, solo[1]); await call(db.app, 'fn_courier_fail', w.courier, solo[1], 'customer_absent');
  assert.equal((await tour(t2)).bonus_paid, null); assert.equal(await entries('tour_bonus'), 2);
  // annulation d'une tournée en cours après 2 livraisons : le bonus gagné est versé une seule fois
  const c = await mkMany(3); const t3 = await create(c); await call(db.app, 'fn_courier_accept_tour', w.courier, t3);
  await deliverOne(c[0]); await deliverOne(c[1]);
  await call(db.app, 'fn_chief_cancel_tour', w.chief, t3);
  assert.equal(Number((await row(t3)).bonus_paid), 9999);
  await expectErr(call(db.app, 'fn_chief_cancel_tour', w.chief, t3), 'invalid_state');
  assert.equal(await entries('tour_bonus'), 4);
  assert.equal(await count('SELECT count(*)::int AS n FROM fn_ledger_check()'), 0);
  await setBonus(0);
});

test('garde-fou : un bonus qui ferait dépasser les frais de livraison refuse la création de la tournée', async () => {
  await setBonus(40001);                                                                                                                   // marge de 2 commandes Kaloum = 2 x (25 000 - paie) < 40 001
  const ids = await mkMany(2);
  await expectErr(create(ids), 'tour_bonus_exceeds_fee');
  assert.equal(await count('SELECT count(*)::int AS n FROM tour_stops WHERE order_id = ANY($1)', [ids]), 0);
  for (const o of ids) assert.equal((await ost(o)).status, 'confirmed');                                                                  // rien n'a été affecté
  await setBonus(0);
  const id = await create(ids); await call(db.app, 'fn_chief_cancel_tour', w.chief, id);
  await expectErr(call(db.app, 'fn_admin_set_setting', w.chief, 'tour_bonus_per_extra_order', 100), 'forbidden');                      // l'administrateur seul règle le bonus
});

test('HTTP : proposer, accepter, refuser, récupérer ; accès croisés refusés', async () => {
  const chief = await login(w.chief), cou = await login(w.courier), cou2 = await login(w.courier2), sel = await login(w.seller);
  const ids = await mkMany(2); const r = await chief.post('/api/chief/tours', { courier_id: w.courier, order_ids: ids }); assert.equal(r.status, 201);
  const list = (await chief.get('/api/chief/tours')).json.tours.find((t) => t.id === r.json.id); assert.equal(list.status, 'proposed');
  const mine = (await cou.get('/api/courier/tours')).json.tours; assert.equal(mine.length, 1); assert.equal(mine[0].status, 'proposed'); assert.equal((await cou2.get('/api/courier/tours')).json.tours.length, 0);
  const pick = await cou.post(`/api/courier/orders/${ids[0]}/pickup`); assert.equal(pick.status, 409); assert.equal(pick.json.error, 'tour_not_accepted');
  assert.equal((await sel.post(`/api/courier/tours/${r.json.id}/accept`)).status, 403);
  assert.equal((await chief.post(`/api/courier/tours/${r.json.id}/accept`)).status, 403);
  assert.equal((await cou2.post(`/api/courier/tours/${r.json.id}/accept`)).status, 404);
  assert.equal((await cou.post(`/api/courier/tours/pas-un-id/accept`)).status, 400);
  assert.equal((await cou.post(`/api/courier/tours/${r.json.id}/accept`)).status, 200);
  assert.equal((await cou.post(`/api/courier/tours/${r.json.id}/accept`)).status, 409);
  assert.equal((await cou.post(`/api/courier/orders/${ids[0]}/pickup`)).status, 200);
  assert.equal((await chief.post(`/api/chief/tours/${r.json.id}/reorder`, { order_ids: [ids[1], ids[0]] })).status, 200);                 // l'ordre se règle aussi après acceptation
  assert.equal((await chief.post(`/api/chief/tours/${r.json.id}/cancel`)).status, 200);
  const more = await mkMany(2); const r2 = await chief.post('/api/chief/tours', { courier_id: w.courier2, order_ids: more });
  assert.equal((await chief.post(`/api/chief/tours/${r2.json.id}/reorder`, { order_ids: [more[1], more[0]] })).status, 200);                // et pendant la proposition
  assert.equal((await cou2.post(`/api/courier/tours/${r2.json.id}/refuse`)).status, 200);
  assert.equal((await cou2.post(`/api/courier/tours/${r2.json.id}/refuse`)).status, 409);
  assert.equal((await chief.post(`/api/chief/tours/${r2.json.id}/reorder`, { order_ids: [more[1], more[0]] })).status, 409);
  assert.equal((await chief.get('/api/chief/tours')).json.tours.find((t) => t.id === r2.json.id).status, 'refused');
});

test('droits SQL, journal et retour arrière bloqué si un bonus a été versé (donnée financière protégée)', async () => {
  for (const f of ['fn_courier_accept_tour', 'fn_courier_refuse_tour', 'fn_chief_create_tour', 'fn_courier_pickup', 'fn_chief_tours']) {
    const r = (await db.owner.query(`SELECT prosecdef, proconfig::text AS c, has_function_privilege('wld_app', oid, 'EXECUTE') AS e FROM pg_proc WHERE proname = $1`, [f])).rows[0];
    assert.equal(r.prosecdef, true); assert.match(r.c, /search_path=public, pg_temp/); assert.equal(r.e, true, f);
  }
  for (const f of ['_tour_pay_bonus', '_tour_release_orders']) assert.equal((await db.owner.query(`SELECT has_function_privilege('wld_app', oid, 'EXECUTE') AS e FROM pg_proc WHERE proname = $1`, [f])).rows[0].e, false);
  assert.ok(await count(`SELECT count(*)::int AS n FROM audit_log WHERE action IN ('tour_accepted','tour_refused')`) >= 2);
  assert.equal((await db.owner.query(`SELECT has_column_privilege('wld_app', 'product_images', 'data', 'SELECT') AS p`)).rows[0].p, false);     // la 025 ne rouvre pas les octets des photos
  assert.ok(await entries('tour_bonus') > 0);
  await assert.rejects(runRollback(), /Retour arrière impossible/);
  assert.equal(await count(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'tours' AND column_name = 'bonus_per_extra'`), 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM fn_ledger_check()'), 0);
});
