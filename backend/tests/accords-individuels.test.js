// 036 : accords individuels de rémunération (livreur de Wallindirain, agent).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, call, expectErr, world, approvedProduct, codeOf } from './helpers.js';

let db, w, product, n = 0;
const PLATFORM = '00000000-0000-0000-0000-000000000001';
before(async () => {
  db = await freshDb('wld_accords'); w = await world(db);
  await call(db.app, 'fn_admin_set_setting', w.admin, 'unlock_hours', 0);
  product = await approvedProduct(db, w);
  await call(db.app, 'fn_seller_set_price', w.seller, product, 150000);
});
after(async () => { await db.app.end(); await db.owner.end(); });
const mk = () => call(db.app, 'fn_seller_create_order', w.seller, product, null, null, 1, 'Client', `6206${String(10000 + ++n)}`, 'Ratoma', 'Rue 1', null);
const sum = async (u, kind, order) => Number((await db.owner.query(`SELECT COALESCE(sum(amount),0)::bigint s FROM wallet_entries WHERE user_id=$1 AND kind=$2 ${order ? 'AND order_id=$3' : ''}`, order ? [u, kind, order] : [u, kind])).rows[0].s);
const run = async (o, courier = w.courier) => {
  await call(db.app, 'fn_agent_take_order', w.agent1, o.id); await call(db.app, 'fn_agent_log_call', w.agent1, o.id, 'confirmed', 'OK');
  await call(db.app, 'fn_chief_assign', w.chief, o.id, courier);
  await call(db.app, 'fn_courier_pickup', courier, o.id); await call(db.app, 'fn_courier_depart', courier, o.id);
  await call(db.app, 'fn_courier_deliver', courier, o.id, await codeOf(db, o.ref));
};
const ledger = async () => (await db.app.query('SELECT count(*)::int n FROM fn_ledger_check()')).rows[0].n;

test('livreur indépendant : l\'accord individuel remplace la paie commune, sans toucher aux commandes déjà affectées ; fin d\'accord = retour aux règles communes', async () => {
  await expectErr(call(db.app, 'fn_admin_set_courier_agreement', w.seller, w.courier, 12000, 0, 0, 0, 0, null, null), 'forbidden');
  await expectErr(call(db.app, 'fn_admin_set_courier_agreement', w.admin, w.courier, 0, 0, 0, 0, 0, null, null), 'invalid_input');
  await expectErr(call(db.app, 'fn_admin_set_courier_agreement', w.admin, w.courier, 999999, 0, 0, 0, 0, null, null), 'courier_pay_exceeds_fee');
  const o0 = await mk();                                           // affectée avant l'accord : paie commune (5 000)
  await call(db.app, 'fn_agent_take_order', w.agent1, o0.id); await call(db.app, 'fn_agent_log_call', w.agent1, o0.id, 'confirmed', 'OK');
  await call(db.app, 'fn_chief_assign', w.chief, o0.id, w.courier);
  await call(db.app, 'fn_admin_set_courier_agreement', w.admin, w.courier, 12000, 0, 0, 0, 0, null, 'Accord du 30/10');
  await call(db.app, 'fn_courier_pickup', w.courier, o0.id); await call(db.app, 'fn_courier_depart', w.courier, o0.id);
  await call(db.app, 'fn_courier_deliver', w.courier, o0.id, await codeOf(db, o0.ref));
  assert.equal(await sum(w.courier, 'team_pay', o0.id), 5000);       // jamais rétroactif
  const o1 = await mk(); await run(o1);
  assert.equal(await sum(w.courier, 'team_pay', o1.id), 12000);      // accord individuel
  assert.equal(await ledger(), 0);
  await call(db.app, 'fn_admin_end_courier_agreement', w.admin, w.courier, 'Fin');
  await expectErr(call(db.app, 'fn_admin_end_courier_agreement', w.admin, w.courier, null), 'invalid_state');
  const o2 = await mk(); await run(o2);
  assert.equal(await sum(w.courier, 'team_pay', o2.id), 5000);       // retour aux règles communes
  // l'accord individuel ne pollue pas le barème commun
  assert.equal((await db.owner.query(`SELECT count(*)::int n FROM courier_pay_scales WHERE courier_id IS NULL`)).rows[0].n, 0);
});

test('agent : rémunération individuelle à la livraison, jamais avant ; sans accord, montant commun ; l\'autre agent n\'est pas touché', async () => {
  await expectErr(call(db.app, 'fn_admin_set_agent_agreement', w.admin, w.courier, 2000, null, null), 'not_found');
  await expectErr(call(db.app, 'fn_admin_set_agent_agreement', w.agent1, w.agent1, 2000, null, null), 'forbidden');
  const o = await mk();
  await call(db.app, 'fn_agent_take_order', w.agent1, o.id);
  await call(db.app, 'fn_admin_set_agent_agreement', w.admin, w.agent1, 2500, null, 'Accord agent');
  await call(db.app, 'fn_agent_log_call', w.agent1, o.id, 'confirmed', 'OK');     // confirmée APRÈS l'accord
  assert.equal(await sum(w.agent1, 'team_pay', o.id), 0);
  await call(db.app, 'fn_chief_assign', w.chief, o.id, w.courier);
  await call(db.app, 'fn_courier_pickup', w.courier, o.id); await call(db.app, 'fn_courier_depart', w.courier, o.id);
  await call(db.app, 'fn_courier_deliver', w.courier, o.id, await codeOf(db, o.ref));
  assert.equal(await sum(w.agent1, 'team_pay', o.id), 2500);
  assert.equal(await ledger(), 0);
  await call(db.app, 'fn_admin_end_agent_agreement', w.admin, w.agent1, null);
  const o2 = await mk(); await run(o2);
  assert.equal(await sum(w.agent1, 'team_pay', o2.id), 1000);       // montant commun
});

test('livreur de Wallindirain avec accord : l\'accord l\'emporte sur le barème commun ; sans accord le barème commun s\'applique', async () => {
  await call(db.app, 'fn_admin_set_courier_kind', w.admin, w.courier2, 'company', null);
  await call(db.app, 'fn_admin_set_company_scale', w.admin, 7000, 0, 0, 0, 0, null, 'Barème commun');
  const o1 = await mk(); await run(o1, w.courier2);
  assert.equal(await sum(w.courier2, 'team_pay', o1.id), 7000);
  await call(db.app, 'fn_admin_set_courier_agreement', w.admin, w.courier2, 9000, 0, 0, 0, 0, null, 'Accord individuel');
  const o2 = await mk(); await run(o2, w.courier2);
  assert.equal(await sum(w.courier2, 'team_pay', o2.id), 9000);
  assert.equal(await ledger(), 0);
});
