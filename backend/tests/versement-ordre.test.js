// Étape 7 : reversement du livreur en espèces (à qui remis), ordre de passage d'une tournée, montants prévus (migration 024).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshDb, TEST_DB, APP_PW, world, approvedProduct, call, expectErr, deliver } from './helpers.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';
import { splitSql, migrate } from '../src/migrate.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PW = 'Secret123';
let db, w, product, srv, base, n = 0, k = 0;
const count = async (sql, p = []) => Number((await db.owner.query(sql, p)).rows[0].n);
const phone = () => `6${String(++n).padStart(8, '0')}`;
const mk = (confirmed = true) => call(db.app, 'fn_seller_create_order_once', w.seller, `vers-test-key-${String(++k).padStart(8, '0')}`, product, null, null, 1, 'Client Test', phone(), 'Kaloum', 'Rue 1 Kaloum', null, confirmed);
const delivered = async (courier = w.courier) => { const o = await mk(false); await deliver(db, w, o.id, o.ref, courier); return o; };
const sum = async (user, kind) => Number((await db.owner.query(`SELECT COALESCE(sum(amount), 0) AS s FROM wallet_entries WHERE user_id = $1 AND ($2::text IS NULL OR kind = $2)`, [user, kind ?? null])).rows[0].s);
const tours = (actor = w.chief) => call(db.app, 'fn_chief_tours', actor);

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
const rollbackSql = () => fs.readFileSync(path.join(root, 'docs', 'retour-arriere-024.sql'), 'utf8');
const runRollback = async () => { await db.owner.query('BEGIN'); try { for (const s of splitSql(rollbackSql())) { if (/^(begin|commit)$/i.test(s.trim())) continue; await db.owner.query(s); } await db.owner.query('COMMIT'); } catch (e) { await db.owner.query('ROLLBACK'); throw e; } };

before(async () => {
  db = await freshDb('wld_versement'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  product = await approvedProduct(db, w, { price: 60000, qty: 90 });
  await call(db.app, 'fn_seller_set_price', w.seller, product, 120000);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_versement', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });

test('retour arrière 024 (sans reversement en espèces) : rétablit transfert seul, ordre et fonctions d\'avant ; migration rejouable', async () => {
  const snap = async () => (await db.owner.query(`SELECT (SELECT count(*) FROM wallet_entries)::text AS ecr, (SELECT count(*) FROM remittances)::text AS rev,
     (SELECT md5(string_agg(key || value::text, ',' ORDER BY key)) FROM settings) AS s,
     (SELECT string_agg(p.proname || ':' || md5(pg_get_functiondef(p.oid)) || ':' || COALESCE(p.proacl::text, ''), E'\\n' ORDER BY p.proname, p.oid::text) FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND p.proname NOT IN ('fn_courier_remit','fn_chief_reorder_tour','fn_chief_tours')) AS fonctions`)).rows[0];
  const before = await snap();
  await runRollback();
  assert.deepEqual(await snap(), before);
  assert.equal(await count(`SELECT (SELECT count(*) FROM information_schema.columns WHERE table_name = 'remittances' AND column_name = 'handed_to') + (SELECT count(*) FROM pg_proc WHERE proname = 'fn_chief_reorder_tour')
     + (SELECT count(*) FROM schema_migrations WHERE name = '024_versement_especes_ordre.sql') AS n`), 0);
  await assert.rejects(db.owner.query(`INSERT INTO remittances(courier_id, method, amount, proof_id) VALUES ($1, 'cash', 1, NULL)`, [w.courier]));          // l'espèce n'existe plus
  await migrate({ ...TEST_DB, database: 'wld_versement' }, APP_PW, () => {});
  assert.equal(await count(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '024_versement_especes_ordre.sql'`), 1);
});

test('reversement en espèces : il faut dire à qui, validation par l\'administrateur, manque débité au livreur, compta juste', async () => {
  const a = await delivered(); const b = await delivered();
  await expectErr(call(db.app, 'fn_courier_remit', w.courier, 'cash', null, null, [a.id], null), 'invalid_input');
  await expectErr(call(db.app, 'fn_courier_remit', w.courier, 'cash', null, null, [a.id], ' '), 'invalid_input');
  await expectErr(call(db.app, 'fn_courier_remit', w.courier, 'cash', null, null, [a.id], 'x'), 'invalid_input');
  await expectErr(call(db.app, 'fn_courier_remit', w.courier, 'orange_money', null, 'REF', [a.id], null), 'proof_required');           // le transfert exige toujours la capture
  await expectErr(call(db.app, 'fn_courier_remit', w.courier, 'virement', null, null, [a.id], 'Mamadou'), 'invalid_input');
  await expectErr(call(db.app, 'fn_courier_remit', w.seller, 'cash', null, null, [a.id], 'Mamadou'), 'forbidden');
  const r = await call(db.app, 'fn_courier_remit', w.courier, 'cash', null, 'Bureau Kaloum, 15 h', [a.id], '  Mamadou Diallo ');
  const row = (await db.owner.query('SELECT method, proof_id, handed_to, status, amount FROM remittances WHERE id = $1', [r.id])).rows[0];
  assert.deepEqual([row.method, row.proof_id, row.handed_to, row.status, Number(row.amount)], ['cash', null, 'Mamadou Diallo', 'pending', Number(r.amount)]);
  await expectErr(call(db.app, 'fn_courier_remit', w.courier, 'cash', null, null, [a.id], 'Mamadou'), 'invalid_state');                  // déjà couvert : pas de double reversement
  const short = Number(r.amount) - 10000; const before = await sum(w.courier, 'cash_shortage');
  const res = await call(db.app, 'fn_admin_confirm_remittance', w.admin, r.id, short);
  assert.equal(res.shortage, 10000); assert.equal(await sum(w.courier, 'cash_shortage') - before, -10000);                              // le manque est débité, comme pour un transfert
  // refus : les encaissements redeviennent à remettre
  const c2 = await call(db.app, 'fn_courier_remit', w.courier, 'cash', null, null, [b.id], 'Fatoumata Bah');
  await call(db.app, 'fn_admin_reject_remittance', w.admin, c2.id, 'Argent non reçu');
  assert.equal(await count(`SELECT count(*)::int AS n FROM courier_cash_entries WHERE order_id = $1 AND remittance_id IS NULL AND count_id IS NULL`, [b.id]), 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM fn_ledger_check()'), 0);
});

test('reversement en espèces par HTTP : champ obligatoire, liste du livreur et de l\'administrateur avec « remis à »', async () => {
  const cou = await login(w.courier), admin = await login(w.admin), sel = await login(w.seller);
  const o = await delivered();
  assert.equal((await cou.post('/api/courier/remit', { method: 'cash', orders: [o.id] })).status, 400);                                  // « remis à » manquant
  assert.equal((await cou.post('/api/courier/remit', { method: 'orange_money', orders: [o.id] })).status, 400);                          // capture manquante
  assert.equal((await sel.post('/api/courier/remit', { method: 'cash', handed_to: 'Mamadou', orders: [o.id] })).status, 403);
  const ok = await cou.post('/api/courier/remit', { method: 'cash', handed_to: 'Mamadou Diallo', reference: 'Bureau, 17 h', orders: [o.id] });
  assert.equal(ok.status, 201);
  const mine = (await cou.get('/api/courier/cash')).json.remittances.find((r) => r.id === ok.json.id); assert.deepEqual([mine.method, mine.handed_to, mine.proof_id], ['cash', 'Mamadou Diallo', null]);
  const adm = (await admin.get('/api/admin/remittances')).json.remittances.find((r) => r.id === ok.json.id); assert.deepEqual([adm.method, adm.handed_to, adm.status], ['cash', 'Mamadou Diallo', 'pending']);
  assert.equal((await admin.post(`/api/admin/remittances/${ok.json.id}/confirm`, { received: Number(ok.json.amount) })).status, 200);
  assert.equal(await count('SELECT count(*)::int AS n FROM fn_ledger_check()'), 0);
});

test('tournée : ordre de passage modifiable par le chef, validations, montants prévus dès la création', async () => {
  const ids = []; for (let i = 0; i < 4; i++) ids.push((await mk(true)).id);
  const id = await call(db.app, 'fn_chief_create_tour', w.chief, w.courier2, ids, null);
  let t = (await tours()).find((x) => x.id === id);
  const fees = Number((await db.owner.query('SELECT sum(delivery_fee) AS s FROM orders WHERE id = ANY($1)', [ids])).rows[0].s);
  const pay = Number((await db.owner.query('SELECT sum(courier_pay) AS s FROM orders WHERE id = ANY($1)', [ids])).rows[0].s);
  assert.equal(Number(t.planned_fees), fees); assert.equal(Number(t.planned_pay), pay); assert.equal(Number(t.delivery_fees), 0);        // prévu dès le début, encaissé = 0 avant livraison
  assert.deepEqual(t.stops.map((s) => [Number(s.fee) > 0, Number(s.pay) > 0]), [[true, true], [true, true], [true, true], [true, true]]);
  const order = [ids[2], ids[0], ids[3], ids[1]];
  await call(db.app, 'fn_chief_reorder_tour', w.chief, id, order);
  t = (await tours(w.admin)).find((x) => x.id === id); assert.deepEqual(t.stops.map((s) => s.order_id), order); assert.deepEqual(t.stops.map((s) => s.position), [1, 2, 3, 4]);
  assert.deepEqual((await call(db.app, 'fn_courier_tours', w.courier2))[0].stops.map((s) => s.order_id), order);                      // le livreur voit le nouvel ordre
  await expectErr(call(db.app, 'fn_chief_reorder_tour', w.chief, id, [ids[0], ids[1]]), 'invalid_input');                            // incomplet
  await expectErr(call(db.app, 'fn_chief_reorder_tour', w.chief, id, [ids[0], ids[0], ids[1], ids[2]]), 'invalid_input');           // doublon
  await expectErr(call(db.app, 'fn_chief_reorder_tour', w.chief, id, [ids[0], ids[1], ids[2], '00000000-0000-0000-0000-000000000009']), 'invalid_input');
  await expectErr(call(db.app, 'fn_chief_reorder_tour', w.chief, id, null), 'invalid_input');
  await expectErr(call(db.app, 'fn_chief_reorder_tour', w.chief, '00000000-0000-0000-0000-000000000009', order), 'not_found');
  for (const actor of [w.seller, w.agent1, w.courier2, w.warehouse]) await expectErr(call(db.app, 'fn_chief_reorder_tour', actor, id, order), 'forbidden');
  // une commande qui sort de la tournée : les autres se réordonnent, la sortie reste en fin de liste
  await call(db.app, 'fn_chief_assign', w.chief, ids[0], w.courier);
  await call(db.app, 'fn_chief_reorder_tour', w.chief, id, [ids[1], ids[3], ids[2]]);
  t = (await tours()).find((x) => x.id === id);
  assert.deepEqual(t.stops.filter((s) => s.active).map((s) => s.order_id), [ids[1], ids[3], ids[2]]); assert.equal(t.stops.at(-1).order_id, ids[0]); assert.equal(t.stops.at(-1).active, false);
  assert.equal(Number(t.planned_fees), fees - Number((await db.owner.query('SELECT delivery_fee FROM orders WHERE id = $1', [ids[0]])).rows[0].delivery_fee));   // la commande sortie n'est plus comptée
  await call(db.app, 'fn_chief_cancel_tour', w.chief, id);
  await expectErr(call(db.app, 'fn_chief_reorder_tour', w.chief, id, [ids[1], ids[3], ids[2]]), 'invalid_state');                     // tournée annulée : plus modifiable
});

test('tournée par HTTP : réordonner ; accès croisés refusés', async () => {
  const chief = await login(w.chief), cou = await login(w.courier2), sel = await login(w.seller);
  const ids = []; for (let i = 0; i < 3; i++) ids.push((await mk(true)).id);
  const created = await chief.post('/api/chief/tours', { courier_id: w.courier2, order_ids: ids }); assert.equal(created.status, 201);
  const tid = created.json.id; const order = [ids[2], ids[1], ids[0]];
  assert.equal((await chief.post(`/api/chief/tours/${tid}/reorder`, { order_ids: [] })).status, 400);
  assert.equal((await chief.post(`/api/chief/tours/${tid}/reorder`, { order_ids: 'x' })).status, 400);
  assert.equal((await sel.post(`/api/chief/tours/${tid}/reorder`, { order_ids: order })).status, 403);
  assert.equal((await cou.post(`/api/chief/tours/${tid}/reorder`, { order_ids: order })).status, 403);
  assert.equal((await chief.post(`/api/chief/tours/${tid}/reorder`, { order_ids: [ids[0], ids[1]] })).status, 400);
  assert.equal((await chief.post(`/api/chief/tours/${tid}/reorder`, { order_ids: order })).status, 200);
  assert.deepEqual((await chief.get('/api/chief/tours')).json.tours.find((t) => t.id === tid).stops.map((s) => s.order_id), order);
  assert.deepEqual((await cou.get('/api/courier/tours')).json.tours[0].stops.map((s) => s.order_id), order);
  const eligible = (await chief.get('/api/chief/orders')).json.orders; assert.ok(eligible.every((o) => o.delivery_fee !== undefined && o.courier_pay !== undefined));
  await call(db.app, 'fn_chief_cancel_tour', w.chief, tid);
});

test('droits SQL et retour arrière bloqué tant qu\'un reversement en espèces existe (donnée financière protégée)', async () => {
  for (const f of ['fn_courier_remit', 'fn_chief_reorder_tour', 'fn_chief_tours']) {
    const r = (await db.owner.query(`SELECT prosecdef, proconfig::text AS c, has_function_privilege('wld_app', oid, 'EXECUTE') AS e FROM pg_proc WHERE proname = $1`, [f])).rows[0];
    assert.equal(r.prosecdef, true); assert.match(r.c, /search_path=public, pg_temp/); assert.equal(r.e, true);
  }
  assert.ok(await count(`SELECT count(*)::int AS n FROM remittances WHERE method = 'cash'`) > 0);
  const before = await count('SELECT count(*)::int AS n FROM remittances');
  await assert.rejects(runRollback(), /Retour arrière impossible/);
  assert.equal(await count('SELECT count(*)::int AS n FROM remittances'), before);                                                    // rien n'a été supprimé
  assert.equal(await count(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'remittances' AND column_name = 'handed_to'`), 1);
  await assert.rejects(db.app.query(`UPDATE remittances SET handed_to = 'x'`), /permission denied/);
});
