// Contrôle de conservation de l'argent : quels que soient les frais réglés, une commande livrée répartit EXACTEMENT ce que le livreur a encaissé.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, call, world, approvedProduct, codeOf } from './helpers.js';

let db, w, prod;
let n = 0;
const ph = () => `65${String(3000000 + ++n)}`;
// petit générateur pseudo-aléatoire reproductible
let seed = 20261021; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];
before(async () => { db = await freshDb('wld_conservation'); w = await world(db); prod = await approvedProduct(db, w, { qty: 400 }); });
after(async () => { await db.owner.end(); await db.app.end(); });

test('conservation : 60 commandes aléatoires avec frais, part livreur et commandes déjà confirmées', async () => {
  const set = (k, v) => call(db.app, 'fn_admin_set_setting', w.admin, k, v);
  const zones = (await db.owner.query(`SELECT commune FROM delivery_rates WHERE active`)).rows.map((r) => r.commune);
  let delivered = 0, totalSale = 0;
  for (let i = 0; i < 60; i++) {
    if (i % 6 === 0) {   // on change les réglages en cours de route
      await set('fee_order_bps', pick([0, 300, 500, 1000])); await set('fee_unit', pick([0, 500, 2000]));
      await set('courier_share_bps', pick([0, 5000, 8000, 9000])); await set('margin_bps', pick([1000, 1500, 2000]));
    }
    let o;
    try { o = await call(db.app, 'fn_seller_create_order', w.seller, prod, null, 400000 + Math.floor(rnd() * 200) * 1000, 1 + Math.floor(rnd() * 3), 'Client ' + i, ph(), pick(zones), 'Rue ' + i, null, rnd() < 0.4); }
    catch (e) { assert.ok(['price_below_minimum', 'out_of_stock'].includes(e.code), `erreur inattendue : ${e.code} ${e.message}`); continue; }
    if (rnd() < 0.15) { await call(db.app, 'fn_seller_cancel_order', w.seller, o.id); continue; }
    if (o.status !== 'confirmed') {   // commande normale : un agent confirme par appel ; une commande déjà confirmée saute cette étape
      await call(db.app, 'fn_agent_take_order', w.agent1, o.id); await call(db.app, 'fn_agent_log_call', w.agent1, o.id, 'confirmed', 'OK');
    }
    await call(db.app, 'fn_chief_assign', w.chief, o.id, w.courier);
    await call(db.app, 'fn_courier_pickup', w.courier, o.id); await call(db.app, 'fn_courier_depart', w.courier, o.id);
    await call(db.app, 'fn_courier_deliver', w.courier, o.id, await codeOf(db, o.ref));
    const r = (await db.owner.query(`SELECT o.sale_total, o.platform_fee, o.courier_pay, o.delivery_fee,
        (SELECT COALESCE(sum(amount),0) FROM wallet_entries e WHERE e.order_id = o.id)::bigint AS spread,
        (SELECT COALESCE(sum(amount),0) FROM wallet_entries e WHERE e.order_id = o.id AND e.kind = 'seller_gain')::bigint AS gain,
        (SELECT COALESCE(sum(amount),0) FROM courier_cash_entries c WHERE c.order_id = o.id)::bigint AS cash
        FROM orders o WHERE o.id = $1`, [o.id])).rows[0];
    assert.equal(Number(r.spread), Number(r.sale_total), `commande ${o.ref} : la répartition doit égaler l'encaissement`);
    assert.equal(Number(r.cash), Number(r.sale_total));
    assert.ok(Number(r.gain) >= 0, 'jamais de gain vendeur négatif');
    assert.ok(Number(r.courier_pay) >= 0 && Number(r.courier_pay) <= Number(r.delivery_fee) || Number(r.courier_pay) === 5000, 'part du livreur cohérente');
    delivered++; totalSale += Number(r.sale_total);
  }
  assert.ok(delivered >= 30, `assez de livraisons simulées (${delivered})`);
  const all = (await db.owner.query(`SELECT COALESCE(sum(amount),0)::bigint s FROM wallet_entries WHERE order_id IS NOT NULL`)).rows[0].s;
  assert.equal(Number(all), totalSale, 'au total, tout l\'argent encaissé est réparti, sans création ni perte');
  assert.equal((await db.app.query('SELECT count(*)::int n FROM fn_ledger_check()')).rows[0].n, 0);
});
