// 034 : l'agent n'est payé que si la commande est confirmée ET livrée ; le call center n'est facturé que si la commande est livrée.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, call, world, approvedProduct, codeOf } from './helpers.js';

let db, w, product, n = 0;
before(async () => {
  db = await freshDb('wld_agentliv'); w = await world(db);
  await call(db.app, 'fn_admin_set_setting', w.admin, 'unlock_hours', 0);
  product = await approvedProduct(db, w);
  await call(db.app, 'fn_seller_set_price', w.seller, product, 150000);
});
after(async () => { await db.app.end(); await db.owner.end(); });
const mk = () => call(db.app, 'fn_seller_create_order', w.seller, product, null, null, 1, 'Client', `6205${String(10000 + ++n)}`, 'Ratoma', 'Rue 1', null);
const sum = async (u, kind, order) => Number((await db.owner.query(`SELECT COALESCE(sum(amount),0)::bigint s FROM wallet_entries WHERE user_id=$1 AND kind=$2 ${order ? 'AND order_id=$3' : ''}`, order ? [u, kind, order] : [u, kind])).rows[0].s);
const ledger = async () => (await db.app.query('SELECT count(*)::int n FROM fn_ledger_check()')).rows[0].n;

test('confirmée seulement : l\'agent n\'est pas payé ; livrée : il est payé une seule fois', async () => {
  const o = await mk();
  await call(db.app, 'fn_agent_take_order', w.agent1, o.id);
  await call(db.app, 'fn_agent_log_call', w.agent1, o.id, 'confirmed', 'OK');
  assert.equal(await sum(w.agent1, 'team_pay', o.id), 0);
  assert.equal(await ledger(), 0);
  await call(db.app, 'fn_chief_assign', w.chief, o.id, w.courier);
  await call(db.app, 'fn_courier_pickup', w.courier, o.id); await call(db.app, 'fn_courier_depart', w.courier, o.id);
  await call(db.app, 'fn_courier_deliver', w.courier, o.id, await codeOf(db, o.ref));
  assert.equal(await sum(w.agent1, 'team_pay', o.id), 1000);
  assert.equal(await sum('00000000-0000-0000-0000-000000000001', 'team_pay', o.id), -6000);
  assert.equal(await ledger(), 0);
});

test('confirmée puis échec/retour : aucune rémunération d\'agent et aucun call center pour le vendeur', async () => {
  const o = await mk();
  await call(db.app, 'fn_agent_take_order', w.agent1, o.id);
  await call(db.app, 'fn_agent_log_call', w.agent1, o.id, 'confirmed', 'OK');
  await call(db.app, 'fn_chief_assign', w.chief, o.id, w.courier);
  await call(db.app, 'fn_courier_pickup', w.courier, o.id); await call(db.app, 'fn_courier_depart', w.courier, o.id);
  await call(db.app, 'fn_courier_fail', w.courier, o.id, 'customer_refusal'); await call(db.app, 'fn_chief_return_to_warehouse', w.chief, o.id);
  await call(db.app, 'fn_warehouse_receive_return', w.warehouse, o.id, 'customer_refusal');
  assert.equal(await sum(w.agent1, 'team_pay', o.id), 0);
  assert.equal((await db.owner.query(`SELECT count(*)::int n FROM wallet_entries WHERE order_id=$1 AND kind='return_fees'`, [o.id])).rows[0].n, 0);
  assert.equal(await ledger(), 0);
});
