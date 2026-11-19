// Migrations 071-072 : livraison à la demande (livreur sans code de livraison, argent) et parrainage des autres rôles.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { splitSql } from '../src/migrate.js';
import { freshDb, world, call, expectErr } from './helpers.js';

let db, w, ship, n = 0;
const root = path.resolve(import.meta.dirname, '..', '..');
const ph = () => `69${String(++n + 6000000).padStart(7, '0')}`;
const set = (k, val) => db.owner.query('UPDATE settings SET value = $2 WHERE key = $1', [k, val]);
const one = async (sql, p = []) => (await db.owner.query(sql, p)).rows[0];
const create = (over = {}) => call(db.app, 'fn_dlv_request_create', ship, ...Object.values({ from: 'Taouyah', fa: 'Rue 12', to: 'Ratoma', ta: 'Marché', rn: 'Mariama', rp: ph(), d: 'Carton', kg: 3, dv: 0, payer: 'receiver', ack: true, ...over }));
const wallet = async (user, kind) => Number((await one('SELECT COALESCE(sum(amount),0)::bigint AS s FROM wallet_entries WHERE user_id = $1 AND kind = $2', [user, kind])).s);
const PLATFORM = '00000000-0000-0000-0000-000000000001';
const run = async (file) => { const rb = fs.readFileSync(path.join(root, 'docs', file), 'utf8'); await db.owner.query('BEGIN'); try { for (const q of splitSql(rb)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT'); } catch (e) { await db.owner.query('ROLLBACK'); throw e; } };

before(async () => {
  db = await freshDb('wld_dlvmoney'); w = await world(db);
  await call(db.app, 'fn_admin_dlv_import', w.admin, 'Taouyah', JSON.stringify([{ places: ['Ratoma', 'Kaporo'], light: 10000, heavy: 15000 }]));
  await set('feature_livraison_demande', 1); await set('dlv_open_signup', 1); await set('dlv_daily_limit', 50);
  ship = await call(db.app, 'fn_register', ph(), 'Expéditeur Test', 'shipper', 'x'.repeat(60), null, null, null, null);
});
after(async () => { await db.owner.end(); await db.app.end(); });

test('désignation : admin seulement, livreur actif, retrait possible avant ramassage', async () => {
  const r = await create();
  await expectErr(call(db.app, 'fn_admin_dlv_assign', w.seller, r.id, w.courier), 'forbidden');
  await expectErr(call(db.app, 'fn_admin_dlv_assign', w.admin, r.id, w.seller), 'not_found');
  await call(db.app, 'fn_admin_dlv_assign', w.admin, r.id, w.courier);
  assert.equal((await call(db.app, 'fn_courier_dlv_list', w.courier)).length, 1);
  await call(db.app, 'fn_admin_dlv_unassign', w.admin, r.id);
  assert.equal((await call(db.app, 'fn_courier_dlv_list', w.courier)).length, 0);
  await call(db.app, 'fn_admin_dlv_assign', w.admin, r.id, w.courier);
  await expectErr(call(db.app, 'fn_courier_dlv_pickup', w.agent1 || w.seller, r.id), 'forbidden');
});

test('course payée par le destinataire : livraison sans code, paie 70 %, plateforme, espèces, reversement', async () => {
  const r = await create({ payer: 'receiver' });
  await call(db.app, 'fn_admin_dlv_assign', w.admin, r.id, w.courier);
  await call(db.app, 'fn_courier_dlv_pickup', w.courier, r.id);
  assert.equal((await one('SELECT count(*)::int AS n FROM courier_cash_entries WHERE dlv_request_id = $1', [r.id])).n, 0);   // rien encaissé avant la livraison
  const before = { pay: await wallet(w.courier, 'team_pay'), rev: await wallet(PLATFORM, 'platform_revenue') };
  await call(db.app, 'fn_courier_dlv_deliver', w.courier, r.id);
  assert.equal(await wallet(w.courier, 'team_pay') - before.pay, 7000);
  assert.equal(await wallet(PLATFORM, 'platform_revenue') - before.rev, 10000);
  const e = await one('SELECT amount::int AS a, order_id FROM courier_cash_entries WHERE dlv_request_id = $1', [r.id]);
  assert.equal(e.a, 10000); assert.equal(e.order_id, null);
  await expectErr(call(db.app, 'fn_courier_dlv_deliver', w.courier, r.id), 'invalid_state');   // jamais deux fois
  await call(db.app, 'fn_courier_remit', w.courier, 'cash', null, null, [r.id], 'Chef de caisse');   // reversement par identifiant de course
  assert.equal((await one('SELECT remittance_id IS NOT NULL AS x FROM courier_cash_entries WHERE dlv_request_id = $1', [r.id])).x, true);
  assert.equal((await db.owner.query('SELECT * FROM fn_ledger_check()')).rows.length, 0);
});

test('seul le livreur désigné peut valider, et seulement après le ramassage', async () => {
  const r = await create();
  await call(db.app, 'fn_admin_dlv_assign', w.admin, r.id, w.courier);
  await expectErr(call(db.app, 'fn_courier_dlv_deliver', w.courier, r.id), 'invalid_state');
  await call(db.app, 'fn_courier_dlv_pickup', w.courier, r.id);
  await expectErr(call(db.app, 'fn_courier_dlv_deliver', w.courier2, r.id), 'invalid_state');
  await call(db.app, 'fn_courier_dlv_deliver', w.courier, r.id);
});

test('payée par l\'expéditeur : espèce au ramassage ; échec = 50 % de la paie et prix acquis', async () => {
  const r = await create({ payer: 'sender' });
  await call(db.app, 'fn_admin_dlv_assign', w.admin, r.id, w.courier); await call(db.app, 'fn_courier_dlv_pickup', w.courier, r.id);
  assert.equal((await one('SELECT amount::int AS a FROM courier_cash_entries WHERE dlv_request_id = $1', [r.id])).a, 10000);
  const pay0 = await wallet(w.courier, 'team_pay'); const rev0 = await wallet(PLATFORM, 'platform_revenue');
  await expectErr(call(db.app, 'fn_courier_dlv_fail', w.courier, r.id, ''), 'invalid_input');
  await call(db.app, 'fn_courier_dlv_fail', w.courier, r.id, 'Destinataire absent');
  assert.equal(await wallet(w.courier, 'team_pay') - pay0, 3500);
  assert.equal(await wallet(PLATFORM, 'platform_revenue') - rev0, 10000);
  assert.equal((await call(db.app, 'fn_dlv_my_requests', ship)).find((x) => x.id === r.id).fail_reason, 'Destinataire absent');
});

test('échec quand le destinataire devait payer : aucune espèce, aucun revenu, la plateforme supporte la paie', async () => {
  const r = await create({ payer: 'receiver' });
  await call(db.app, 'fn_admin_dlv_assign', w.admin, r.id, w.courier); await call(db.app, 'fn_courier_dlv_pickup', w.courier, r.id);
  const rev0 = await wallet(PLATFORM, 'platform_revenue');
  await call(db.app, 'fn_courier_dlv_fail', w.courier, r.id, 'Refus du colis');
  assert.equal(await wallet(PLATFORM, 'platform_revenue') - rev0, 0);
  assert.equal((await one('SELECT count(*)::int AS n FROM courier_cash_entries WHERE dlv_request_id = $1', [r.id])).n, 0);
  assert.equal((await db.owner.query('SELECT * FROM fn_ledger_check()')).rows.length, 0);
});

test('parrainage expéditeur : bonus unique après N courses livrées (désactivé tant que le montant est 0)', async () => {
  const parrain = w.seller; const code = (await one('SELECT referral_code AS c FROM users WHERE id = $1', [parrain])).c;
  const f = await call(db.app, 'fn_register', ph(), 'Filleul Expéditeur', 'shipper', 'x'.repeat(60), null, null, null, null);
  assert.equal(await call(db.app, 'fn_register_referral', f, code), true);
  const deliver = async (shipper) => {
    const r = await call(db.app, 'fn_dlv_request_create', shipper, 'Taouyah', 'Rue 1', 'Ratoma', 'Rue 2', 'Dest', ph(), 'Colis', 2, 0, 'receiver', true);
    await call(db.app, 'fn_admin_dlv_assign', w.admin, r.id, w.courier); await call(db.app, 'fn_courier_dlv_pickup', w.courier, r.id);
    await call(db.app, 'fn_courier_dlv_deliver', w.courier, r.id);
  };
  await deliver(f); await deliver(f);
  assert.equal(await wallet(parrain, 'referral_bonus'), 0);   // montant à 0 : rien
  await set('referral_bonus_shipper', 5000); await set('referral_dlv_required', 2);
  await deliver(f);   // 3e course : objectif atteint
  assert.equal(await wallet(parrain, 'referral_bonus'), 5000);
  await deliver(f);
  assert.equal(await wallet(parrain, 'referral_bonus'), 5000);   // versé une seule fois
  assert.equal(await wallet(PLATFORM, 'referral_bonus'), -5000);
});

test('parrainage livreur : l\'admin indique le parrain, bonus après N livraisons', async () => {
  const parrain = w.supplier; const code = (await one('SELECT referral_code AS c FROM users WHERE id = $1', [parrain])).c;
  await expectErr(call(db.app, 'fn_admin_set_referrer', w.seller, w.courier, code), 'forbidden');
  await expectErr(call(db.app, 'fn_admin_set_referrer', w.admin, w.courier, 'ZZZZZZZ'), 'not_found');
  await call(db.app, 'fn_admin_set_referrer', w.admin, w.courier, code);
  await expectErr(call(db.app, 'fn_admin_set_referrer', w.admin, w.courier, code), 'invalid_state');
  await set('referral_bonus_courier', 2000); await set('referral_courier_required', 1);
  const r = await create();
  await call(db.app, 'fn_admin_dlv_assign', w.admin, r.id, w.courier); await call(db.app, 'fn_courier_dlv_pickup', w.courier, r.id);
  await call(db.app, 'fn_courier_dlv_deliver', w.courier, r.id);
  assert.equal(await wallet(parrain, 'referral_bonus'), 2000);
  assert.equal((await db.owner.query('SELECT * FROM fn_ledger_check()')).rows.length, 0);
});

test('retour arrière : 072 refusé après un bonus versé ; 071 refusé après une course confiée', async () => {
  await assert.rejects(run('retour-arriere-072.sql'), /refusé/);
  await assert.rejects(run('retour-arriere-071.sql'), /refusé pour ne rien perdre/);
});
