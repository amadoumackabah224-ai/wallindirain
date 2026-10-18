// Livraison sans code (réglage par défaut) : le livreur valide en un geste ; le code redevient obligatoire si on l'active.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, call, expectErr, world, approvedProduct, codeOf } from './helpers.js';

let db, w, product;
before(async () => {
  db = await freshDb('wld_nocode', { deliveryCode: false });
  w = await world(db);
  await call(db.app, 'fn_admin_set_setting', w.admin, 'unlock_hours', 0);
  product = await approvedProduct(db, w, { qty: 20 });
  await call(db.app, 'fn_seller_set_price', w.seller, product, 150000);
});
after(async () => { await db.app.end(); await db.owner.end(); });

const toTheRoad = async (phone) => {
  const o = await call(db.app, 'fn_seller_create_order', w.seller, product, null, null, 1, 'Client', phone, 'Ratoma', 'Rue 1', null);
  await call(db.app, 'fn_agent_take_order', w.agent1, o.id);
  await call(db.app, 'fn_agent_log_call', w.agent1, o.id, 'confirmed', 'OK');
  await call(db.app, 'fn_chief_assign', w.chief, o.id, w.courier);
  await call(db.app, 'fn_courier_pickup', w.courier, o.id);
  await call(db.app, 'fn_courier_depart', w.courier, o.id);
  return o;
};

test('réglage par défaut : pas de code, le message au client n\'en contient pas', async () => {
  assert.equal(Number((await db.owner.query(`SELECT value FROM settings WHERE key='require_delivery_code'`)).rows[0].value), 0);
  const o = await toTheRoad('620300001');
  const m = (await db.app.query(`SELECT template, body FROM messages WHERE order_id=$1`, [o.id])).rows;
  assert.equal(m.some((x) => x.template === 'delivery_code'), false);
  assert.match(m.find((x) => x.template === 'order_confirmed').body, new RegExp(o.ref));
  assert.doesNotMatch(m.find((x) => x.template === 'order_confirmed').body, /code/i);
});

test('le livreur livre sans code ; l\'argent est réparti comme avant', async () => {
  const o = await toTheRoad('620300002');
  const r = await call(db.app, 'fn_courier_deliver', w.courier, o.id);   // aucun code
  assert.equal(r.ok, true);
  const st = (await db.app.query(`SELECT status FROM orders WHERE id=$1`, [o.id])).rows[0].status;
  assert.equal(st, 'delivered');
  const gain = Number((await db.app.query(`SELECT COALESCE(sum(amount),0)::bigint s FROM wallet_entries WHERE user_id=$1 AND order_id=$2 AND kind='seller_gain'`, [w.seller, o.id])).rows[0].s);
  assert.equal(gain, 46000);
  assert.equal((await db.app.query('SELECT count(*)::int n FROM fn_ledger_check()')).rows[0].n, 0);
  const h = (await db.app.query(`SELECT note FROM order_history WHERE order_id=$1 AND to_status='delivered'`, [o.id])).rows[0].note;
  assert.match(h, /sans code/);                                          // la traçabilité dit que la livraison s'est faite sans code
});

test('un autre livreur ne peut toujours pas valider ce colis', async () => {
  const o = await toTheRoad('620300003');
  await expectErr(call(db.app, 'fn_courier_deliver', w.courier2, o.id), 'invalid_state');
});

test('code réactivé : il redevient obligatoire pour livrer', async () => {
  await expectErr(call(db.app, 'fn_admin_set_setting', w.admin, 'require_delivery_code', 2), 'invalid_input');
  await call(db.app, 'fn_admin_set_setting', w.admin, 'require_delivery_code', 1);
  const o = await toTheRoad('620300004');
  assert.equal((await call(db.app, 'fn_courier_deliver', w.courier, o.id)).ok, false);          // sans code : refusé
  assert.equal((await call(db.app, 'fn_courier_deliver', w.courier, o.id, '0000')).ok, false);   // faux code : refusé
  assert.equal((await call(db.app, 'fn_courier_deliver', w.courier, o.id, await codeOf(db, o.ref))).ok, true);
  await call(db.app, 'fn_admin_set_setting', w.admin, 'require_delivery_code', 0);
});
