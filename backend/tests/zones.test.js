// Zones de livraison de Conakry et villes de Guinée : créées sans tarif et désactivées, activées par l'administrateur.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, call, expectErr, world, approvedProduct } from './helpers.js';

let db, w, prod;
before(async () => { db = await freshDb('wld_zones'); w = await world(db); prod = await approvedProduct(db, w, { qty: 20 }); await call(db.app, 'fn_seller_set_price', w.seller, prod, 150000); });
after(async () => { await db.owner.end(); await db.app.end(); });

const q = async (sql, p = []) => (await db.owner.query(sql, p)).rows;
const order = (zone) => call(db.app, 'fn_seller_create_order', w.seller, prod, null, 150000, 1, 'Client Test', '660000001', zone, 'Rue 1', null, false);

test('les zones de Conakry et des villes sont présentes, sans tarif et désactivées', async () => {
  const [t] = await q(`SELECT count(*)::int AS n, count(*) FILTER (WHERE NOT active AND fee = 0)::int AS todo FROM delivery_rates`);
  assert.ok(t.n >= 100, `zones : ${t.n}`); assert.ok(t.todo >= 90);
  const names = (await q('SELECT commune FROM delivery_rates')).map((r) => r.commune);
  for (const z of ['Kipé', 'Hamdalaye', 'Km 36', 'Dar-es-Salam', 'Kankan', 'Nzérékoré', 'Labé', 'Kamsar', 'Coyah', 'Dubréka']) assert.ok(names.includes(z), z);
  assert.equal((await q(`SELECT count(*)::int AS n FROM delivery_rates WHERE commune IN ('Kaloum','Dixinn','Matam','Ratoma','Matoto') AND active AND fee >= 25000`))[0].n, 5);   // zones existantes inchangées
  assert.ok((await q(`SELECT 1 FROM delivery_rates WHERE commune = 'Autre quartier / ville' AND active`)).length === 1);
});

test('une zone sans tarif n\'est ni proposée ni commandable, et ne peut pas être activée à 0', async () => {
  await expectErr(order('Kankan'), 'invalid_input');
  await expectErr(call(db.app, 'fn_admin_set_delivery_rate', w.admin, 'Kankan', 0, true), 'invalid_input');
  assert.equal((await q(`SELECT active FROM delivery_rates WHERE commune = 'Kankan'`))[0].active, false);
  await call(db.app, 'fn_admin_set_delivery_rate', w.admin, 'Kankan', 28000, true);
  assert.ok((await order('Kankan')).id);
  assert.equal(Number((await q(`SELECT delivery_fee FROM orders ORDER BY created_at DESC LIMIT 1`))[0].delivery_fee), 28000);
});
