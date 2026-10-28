// Étape 9 : modes de paie d'une tournée groupée (normal / A : pourcentage de tournée / B : 1re normale puis partage), choisis par le chef et figés (migration 026).
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
const mk = () => call(db.app, 'fn_seller_create_order_once', w.seller, `modes-test-key-${String(++k).padStart(8, '0')}`, product, null, null, 1, 'Client Test', phone(), 'Kaloum', 'Rue 1 Kaloum', null, true);
const mkMany = async (x) => { const r = []; for (let i = 0; i < x; i++) r.push((await mk()).id); return r; };
const create = (orders, mode = 'normal', courier = w.courier, actor = w.chief) => call(db.app, 'fn_chief_create_tour', actor, courier, orders, null, mode);
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
const runRollback = async () => { const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-032.sql'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'docs', 'retour-arriere-031.sql'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'docs', 'retour-arriere-030.sql'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'docs', 'retour-arriere-029.sql'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'docs', 'retour-arriere-026.sql'), 'utf8'); await db.owner.query('BEGIN'); try { for (const s of splitSql(rb)) { if (/^(begin|commit)$/i.test(s.trim())) continue; await db.owner.query(s); } await db.owner.query('COMMIT'); } catch (e) { await db.owner.query('ROLLBACK'); throw e; } };

before(async () => {
  db = await freshDb('wld_modes'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  product = await approvedProduct(db, w, { price: 60000, qty: 150 });
  await call(db.app, 'fn_seller_set_price', w.seller, product, 120000);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_modes', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });


const setS = (key, val) => call(db.app, 'fn_admin_set_setting', w.admin, key, val);
const accept = (id) => call(db.app, 'fn_courier_accept_tour', w.courier, id);
const ordersOf = async (ids) => (await db.owner.query('SELECT id, delivery_fee::bigint AS fee, courier_pay::bigint AS pay FROM orders WHERE id = ANY($1)', [ids])).rows.reduce((m, r) => ({ ...m, [r.id]: { fee: Number(r.fee), pay: Number(r.pay) } }), {});
const half = (fee) => Math.floor((fee * 5000 + 5000) / 10000);
const pct = (fee, bps) => Math.floor((fee * bps + 5000) / 10000);
const finish = async (ids) => { for (const o of ids) await deliverOne(o); await call(db.app, 'fn_chief_tours', w.chief); };

test('mode normal par défaut : aucune écriture d\'ajustement, la paie reste celle de chaque commande', async () => {
  const ids = await mkMany(3); const id = await create(ids); await accept(id);
  const r = await row(id); assert.equal(r.pay_mode, 'normal'); assert.equal(Number(r.mode_bps), 0);
  const before = await entries('tour_adjust'); await finish(ids);
  assert.equal(await entries('tour_adjust'), before); assert.equal((await row(id)).adjust_paid, null);
  assert.equal((await tour(id)).status, 'closed');
});

test('validations : mode inconnu, mode A non réglé, pourcentage invalide, rôles', async () => {
  const ids = await mkMany(2);
  await expectErr(create(ids, 'inconnu'), 'invalid_input');
  await expectErr(create(ids, 'share'), 'invalid_input');                          // mode A : réglage à 0, indisponible
  await setS('tour_share_bps', 9500); await expectErr(create(ids, 'share'), 'invalid_input');
  await setS('tour_share_bps', 0);
  for (const a of [w.seller, w.courier, w.supplier]) await expectErr(create(ids, 'split', w.courier, a), 'forbidden');
  for (const o of ids) assert.equal((await ost(o)).status, 'confirmed');           // rien n'a été affecté par les refus
  assert.equal(await count(`SELECT count(*)::int AS n FROM tours t JOIN tour_stops s ON s.tour_id = t.id WHERE s.order_id = ANY($1)`, [ids]), 0);
});

test('mode A : pourcentage de tournée sur chaque commande livrée, figé à la création, écrit une seule fois', async () => {
  await setS('tour_share_bps', 6000);
  const ids = await mkMany(3); const o = await ordersOf(ids);
  const id = await create(ids, 'share');
  assert.equal((await row(id)).pay_mode, 'share'); assert.equal(Number((await row(id)).mode_bps), 6000);
  await setS('tour_share_bps', 7500);                                               // le réglage change ensuite : la tournée garde 60 %
  const mine = (await call(db.app, 'fn_courier_tours', w.courier)).find((x) => x.id === id);
  assert.equal(mine.pay_mode, 'share'); assert.equal(Number(mine.mode_bps), 6000);
  const target = ids.reduce((s, i) => s + Math.min(o[i].fee, pct(o[i].fee, 6000)), 0); const base = ids.reduce((s, i) => s + o[i].pay, 0);
  assert.equal(Number(mine.plan_total), target);                                    // le livreur voit son gain prévu avant d'accepter
  assert.ok(mine.stops.every((s) => Number(s.plan_pay) === Math.min(o[s.order_id].fee, pct(o[s.order_id].fee, 6000))));
  assert.equal(Number((await tour(id)).planned_pay), target);
  const t0 = await sum(w.courier, 'team_pay');
  await accept(id); await finish(ids);
  const adj = target - base; const r = await row(id);
  assert.equal(Number(r.adjust_paid), adj); assert.equal(r.status, 'closed');
  assert.equal(await sum(w.courier, 'tour_adjust'), adj); assert.equal(await sum(PLATFORM, 'tour_adjust'), -adj);
  assert.equal(await sum(w.courier, 'team_pay') - t0 + adj, target);                // paie par commande + écart = gain annoncé au livreur
  await call(db.app, 'fn_chief_tours', w.chief); await call(db.app, 'fn_courier_tours', w.courier);
  assert.equal(await sum(w.courier, 'tour_adjust'), adj);                           // une seule fois, même après d'autres lectures
  assert.equal(await count('SELECT count(*)::int AS n FROM fn_ledger_check()'), 0);
  await setS('tour_share_bps', 0);
});

test('mode B : la 1re commande livrée garde la paie habituelle, les suivantes sont partagées 50/50 ; l\'ordre de passage compte', async () => {
  const ids = await mkMany(3); const o = await ordersOf(ids);
  const id = await create(ids, 'split'); assert.equal(Number((await row(id)).mode_bps), 5000);
  const rev = [ids[2], ids[0], ids[1]];
  await call(db.app, 'fn_chief_reorder_tour', w.chief, id, rev);                    // le chef fixe la 1re commande avant l'acceptation
  const mine = (await call(db.app, 'fn_courier_tours', w.courier)).find((x) => x.id === id);
  const sorted = mine.stops.sort((a, b) => a.position - b.position);
  assert.equal(sorted[0].order_id, ids[2]); assert.equal(Number(sorted[0].plan_pay), o[ids[2]].pay);
  assert.equal(Number(sorted[1].plan_pay), Math.min(o[ids[0]].fee, half(o[ids[0]].fee)));
  const target = o[ids[2]].pay + Math.min(o[ids[0]].fee, half(o[ids[0]].fee)) + Math.min(o[ids[1]].fee, half(o[ids[1]].fee));
  assert.equal(Number(mine.plan_total), target);
  const a0 = await sum(w.courier, 'tour_adjust'), q0 = await sum(PLATFORM, 'tour_adjust');
  await accept(id); await finish(rev);
  const adj = target - ids.reduce((s, i) => s + o[i].pay, 0);
  assert.equal(Number((await row(id)).adjust_paid ?? 0), adj);
  assert.equal(await sum(w.courier, 'tour_adjust') - a0, adj);
  assert.equal(await sum(PLATFORM, 'tour_adjust') - q0, -adj);
  assert.equal(await count('SELECT count(*)::int AS n FROM fn_ledger_check()'), 0);
});

test('une seule commande livrée sur la tournée : pas d\'ajustement (ce n\'est pas une tournée groupée)', async () => {
  await setS('tour_share_bps', 3000);
  const ids = await mkMany(2); const id = await create(ids, 'share'); await accept(id);
  const before = await entries('tour_adjust');
  await deliverOne(ids[0]); await call(db.app, 'fn_chief_cancel_tour', w.chief, id);
  assert.equal(await entries('tour_adjust'), before); assert.equal((await row(id)).adjust_paid, null);
  assert.equal((await ost(ids[1])).courier_id, w.courier);
  await deliverOne(ids[1]);                                                         // livrée plus tard, hors tournée : paie habituelle
  assert.equal(await entries('tour_adjust'), before);
  await setS('tour_share_bps', 0);
});

test('HTTP : le chef choisit le mode, le livreur le voit avec ses gains prévus ; mode invalide refusé', async () => {
  const chief = await login(w.chief), cou = await login(w.courier), seller = await login(w.seller);
  const ids = await mkMany(2);
  const bad = await chief.post('/api/chief/tours', { courier_id: w.courier, order_ids: ids, mode: 'zzz' }); assert.equal(bad.status, 400);
  const ok = await chief.post('/api/chief/tours', { courier_id: w.courier, order_ids: ids, mode: 'split' }); assert.equal(ok.status, 201);
  const l = await cou.get('/api/courier/tours'); const t = l.json.tours.find((x) => x.id === ok.json.id);
  assert.equal(t.pay_mode, 'split'); assert.ok(Number(t.plan_total) > 0); assert.equal(t.status, 'proposed');
  const cl = await chief.get('/api/chief/tours'); assert.equal(cl.json.tours.find((x) => x.id === ok.json.id).pay_mode, 'split');
  const dflt = await chief.post('/api/chief/tours', { courier_id: w.courier, order_ids: await mkMany(2) }); assert.equal(dflt.status, 201);   // sans mode : normal
  assert.equal((await row(dflt.json.id)).pay_mode, 'normal');
  assert.equal((await seller.post('/api/chief/tours', { courier_id: w.courier, order_ids: ids, mode: 'split' })).status, 403);
  for (const x of [ok.json.id, dflt.json.id]) await call(db.app, 'fn_chief_cancel_tour', w.chief, x);
});

test('droits SQL, journal et retour arrière bloqué tant qu\'un ajustement ou une tournée A/B existe (donnée financière protégée)', async () => {
  for (const f of ['fn_chief_create_tour', 'fn_chief_tours', 'fn_courier_tours']) {
    const r = (await db.owner.query(`SELECT prosecdef, proconfig::text AS c, has_function_privilege('wld_app', oid, 'EXECUTE') AS e FROM pg_proc WHERE proname = $1`, [f])).rows;
    assert.equal(r.length, 1, f + ' : une seule signature'); assert.equal(r[0].prosecdef, true); assert.match(r[0].c, /search_path=public, pg_temp/); assert.equal(r[0].e, true, f);
  }
  for (const f of ['_tour_plan', '_tour_target_pay', '_tour_pay_bonus']) assert.equal((await db.owner.query(`SELECT has_function_privilege('wld_app', oid, 'EXECUTE') AS e FROM pg_proc WHERE proname = $1`, [f])).rows[0].e, false);
  assert.equal((await db.owner.query(`SELECT has_column_privilege('wld_app', 'product_images', 'data', 'SELECT') AS p`)).rows[0].p, false);
  assert.ok(await entries('tour_adjust') > 0);
  await assert.rejects(runRollback(), /Retour arrière impossible/);
  assert.equal(await count(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'tours' AND column_name = 'pay_mode'`), 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM fn_ledger_check()'), 0);
});

test('retour arrière 026 sur une base sans tournée A/B : retire les modes, restaure les fonctions, migration rejouable', async () => {
  await db.owner.query(`DELETE FROM tour_stops WHERE tour_id IN (SELECT id FROM tours WHERE pay_mode <> 'normal')`);
  await db.owner.query(`DELETE FROM tours WHERE pay_mode <> 'normal'`);
  await db.owner.query('ALTER TABLE wallet_entries DISABLE TRIGGER USER');                                 // nettoyage de test seulement (table en ajout seul)
  await db.owner.query(`DELETE FROM wallet_entries WHERE kind = 'tour_adjust'`);
  await db.owner.query('ALTER TABLE wallet_entries ENABLE TRIGGER USER');
  await runRollback();
  assert.equal(await count(`SELECT (SELECT count(*) FROM information_schema.columns WHERE table_name = 'tours' AND column_name IN ('pay_mode','mode_bps','adjust_paid')) + (SELECT count(*) FROM pg_proc WHERE proname IN ('_tour_plan','_tour_target_pay')) + (SELECT count(*) FROM settings WHERE key IN ('tour_share_bps','tour_extra_share_bps')) + (SELECT count(*) FROM schema_migrations WHERE name = '026_tournee_modes_paie.sql') AS n`), 0);
  assert.equal(await count(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'fn_chief_create_tour'`), 1);
  const id = await call(db.app, 'fn_chief_create_tour', w.chief, w.courier, await mkMany(2), null);   // la création à 4 paramètres fonctionne de nouveau
  assert.ok(id);
  await migrate({ ...TEST_DB, database: 'wld_modes' }, APP_PW, () => {});
  assert.equal(await count(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '026_tournee_modes_paie.sql'`), 1);
  assert.equal(await count(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'fn_chief_create_tour'`), 1);
});
