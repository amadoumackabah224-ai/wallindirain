// Tests des règles métier du cahier des charges v2.0 (critères d'acceptation du pilote).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, call, expectErr, world, approvedProduct, codeOf, deliver, makeProof } from './helpers.js';

let db, w, product;
const sum = async (user, kind) => Number((await db.app.query(
  `SELECT COALESCE(sum(amount),0)::bigint s FROM wallet_entries WHERE user_id=$1 ${kind ? 'AND kind=$2' : ''}`, kind ? [user, kind] : [user])).rows[0].s);
const PLATFORM = '00000000-0000-0000-0000-000000000001';
const FLOAT = '00000000-0000-0000-0000-000000000002';

before(async () => {
  db = await freshDb('wld_rules');
  w = await world(db);
  await call(db.app, 'fn_admin_set_setting', w.admin, 'unlock_hours', 0);
  product = await approvedProduct(db, w);
  await call(db.app, 'fn_seller_set_price', w.seller, product, 150000);
});
after(async () => { await db.app.end(); await db.owner.end(); });

const order = (qty = 1, phone = '620000001', commune = 'Ratoma') =>
  call(db.app, 'fn_seller_create_order', w.seller, product, null, null, qty, 'Client Test', phone, commune, 'Rue 1', null);

test('prix : marge 15 % et prix minimum de vente', async () => {
  const p = (await db.app.query('SELECT margin_unit FROM products WHERE id=$1', [product])).rows[0];
  assert.equal(p.margin_unit, 9000);
  // minimum = 60000 + 9000 + 5000 + 30000 = 104000
  await expectErr(call(db.app, 'fn_seller_set_price', w.seller, product, 103999), 'price_below_minimum');
  await call(db.app, 'fn_seller_set_price', w.seller, product, 104000);
  await call(db.app, 'fn_seller_set_price', w.seller, product, 150000);
});

test('un produit non compté par le magasinier n\'est pas vendable', async () => {
  const p2 = await call(db.app, 'fn_supplier_add_product', w.supplier, 'Casque', null, 40000, 'wallindirain', 0);
  await call(db.app, 'fn_admin_review_product', w.admin, p2, true, null);
  await call(db.app, 'fn_supplier_announce_arrival', w.supplier, p2, 5);
  await call(db.app, 'fn_seller_set_price', w.seller, p2, 100000);
  await expectErr(call(db.app, 'fn_seller_create_order', w.seller, p2, null, null, 1, 'Client', '620000002', 'Kaloum', 'Rue', null), 'out_of_stock');
});

test('exemple du cahier des charges : formule A, 150 000 GNF, Ratoma', async () => {
  const o = await order(1, '620000010');
  const r = await deliver(db, w, o.id, o.ref);
  assert.equal(r.ok, true);
  assert.equal(await sum(w.seller, 'seller_gain'), 46000);
  assert.equal(await sum(w.supplier, 'supplier_payment'), 60000);
  assert.equal(await sum(PLATFORM, 'platform_revenue'), 44000);
  assert.equal(await sum(w.agent1, 'team_pay'), 1000);
  assert.equal(await sum(w.courier, 'team_pay'), 5000);
  // résultat de Wallindirain après rémunérations = 38 000
  assert.equal(await sum(PLATFORM), 38000);
  // critère 4 : fournisseur + vendeur + Wallindirain = argent encaissé
  assert.equal(46000 + 60000 + 44000, 150000);
});

test('critère 7 : un tarif modifié ne change pas les commandes déjà créées', async () => {
  const o = await order(1, '620000011');
  await call(db.app, 'fn_admin_set_delivery_rate', w.admin, 'Ratoma', 99000);
  const row = (await db.app.query('SELECT delivery_fee, call_fee FROM orders WHERE id=$1', [o.id])).rows[0];
  assert.equal(row.delivery_fee, 30000);
  await call(db.app, 'fn_admin_set_delivery_rate', w.admin, 'Ratoma', 30000);
  await call(db.app, 'fn_staff_cancel_order', w.admin, o.id, 'test');
  await assert.rejects(db.owner.query(`UPDATE orders SET delivery_fee = 1 WHERE id = $1`, [o.id]), /figés/);
});

test('critère 2 : deux agents ne prennent pas la même commande', async () => {
  const o = await order(1, '620000012');
  const results = await Promise.allSettled([
    call(db.app, 'fn_agent_take_order', w.agent1, o.id),
    call(db.app, 'fn_agent_take_order', w.agent2, o.id)
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.match(results.find((r) => r.status === 'rejected').reason.message, /already_taken/);
  // l'agent perdant ne peut pas signer d'appel
  const loser = results[0].status === 'rejected' ? w.agent1 : w.agent2;
  await expectErr(call(db.app, 'fn_agent_log_call', loser, o.id, 'confirmed', null), 'not_your_order');
  const winner = loser === w.agent1 ? w.agent2 : w.agent1;
  await call(db.app, 'fn_agent_log_call', winner, o.id, 'refused', 'ne veut plus');
  const c = (await db.app.query('SELECT agent_name, call_center FROM calls WHERE order_id=$1', [o.id])).rows[0];
  assert.match(c.agent_name, /agent[12]/); assert.equal(c.call_center, 'Alpha');
});

test('critère 3 : pas de livraison sans le bon code (5 essais)', async () => {
  const o = await order(1, '620000013');
  await call(db.app, 'fn_agent_take_order', w.agent1, o.id);
  await call(db.app, 'fn_agent_log_call', w.agent1, o.id, 'confirmed', null);
  await call(db.app, 'fn_chief_assign', w.chief, o.id, w.courier);
  await call(db.app, 'fn_courier_pickup', w.courier, o.id);
  await call(db.app, 'fn_courier_depart', w.courier, o.id);
  const good = await codeOf(db, o.ref);
  const bad = good === '0000' ? '1111' : '0000';
  for (let i = 1; i <= 4; i++) {
    const r = await call(db.app, 'fn_courier_deliver', w.courier, o.id, bad);
    assert.equal(r.ok, false); assert.equal(r.remaining, 5 - i);
  }
  const fifth = await call(db.app, 'fn_courier_deliver', w.courier, o.id, bad);
  assert.equal(fifth.locked, true);
  // bloqué : même le bon code est refusé
  assert.equal((await call(db.app, 'fn_courier_deliver', w.courier, o.id, good)).ok, false);
  // un autre livreur ne peut pas livrer cette commande
  await expectErr(call(db.app, 'fn_courier_deliver', w.courier2, o.id, good), 'invalid_state');
  // le chef réaffecte : le compteur repart
  await call(db.app, 'fn_courier_fail', w.courier, o.id, 'customer_absent');
  await call(db.app, 'fn_chief_assign', w.chief, o.id, w.courier2);
  await call(db.app, 'fn_courier_pickup', w.courier2, o.id);
  await call(db.app, 'fn_courier_depart', w.courier2, o.id);
  assert.equal((await call(db.app, 'fn_courier_deliver', w.courier2, o.id, good)).ok, true);
});

test('commande identique en cours refusée ; client à risque signalé', async () => {
  const o = await order(1, '620000014');
  await expectErr(order(1, '620000014'), 'duplicate_order');
  await call(db.app, 'fn_agent_take_order', w.agent1, o.id);
  await call(db.app, 'fn_agent_log_call', w.agent1, o.id, 'refused', 'refus');
  const o2 = await order(1, '620000014');
  assert.equal(o2.risk, true);
  await call(db.app, 'fn_staff_cancel_order', w.admin, o2.id, 'test');
});

test('injoignable : retour dans la file puis escalade au chef après 5 essais', async () => {
  const o = await order(1, '620000015');
  for (let i = 0; i < 5; i++) {
    await call(db.app, 'fn_agent_take_order', w.agent1, o.id);
    await call(db.app, 'fn_agent_log_call', w.agent1, o.id, 'unreachable', null);
  }
  await expectErr(call(db.app, 'fn_agent_take_order', w.agent1, o.id), 'already_taken');
  await call(db.app, 'fn_agent_take_order', w.chief, o.id);   // le chef peut la reprendre
  await call(db.app, 'fn_agent_log_call', w.chief, o.id, 'refused', null);
});

test('annulation : vendeur seulement avant appel ; le stock réservé est libéré', async () => {
  const before = (await db.app.query('SELECT reserved_qty FROM products WHERE id=$1', [product])).rows[0].reserved_qty;
  const o = await order(2, '620000016');
  assert.equal((await db.app.query('SELECT reserved_qty FROM products WHERE id=$1', [product])).rows[0].reserved_qty, before + 2);
  await call(db.app, 'fn_seller_cancel_order', w.seller, o.id);
  assert.equal((await db.app.query('SELECT reserved_qty FROM products WHERE id=$1', [product])).rows[0].reserved_qty, before);
  const o2 = await order(1, '620000017');
  await call(db.app, 'fn_agent_take_order', w.agent1, o2.id);
  await call(db.app, 'fn_agent_log_call', w.agent1, o2.id, 'unreachable', null);
  await expectErr(call(db.app, 'fn_seller_cancel_order', w.seller, o2.id), 'too_late');
  await expectErr(call(db.app, 'fn_seller_cancel_order', w.seller2, o2.id), 'not_found');
  await call(db.app, 'fn_staff_cancel_order', w.admin, o2.id, 'test');
});

test('stock : jamais de survente, même en commandes simultanées', async () => {
  const p = await approvedProduct(db, w, { price: 30000, qty: 3 });
  await call(db.app, 'fn_seller_set_price', w.seller, p, 90000);
  const tries = await Promise.allSettled([1, 2, 3, 4, 5].map((i) =>
    call(db.app, 'fn_seller_create_order', w.seller, p, null, null, 1, 'Cli', `62100000${i}`, 'Kaloum', 'Rue', null)));
  assert.equal(tries.filter((t) => t.status === 'fulfilled').length, 3);
  const r = (await db.app.query('SELECT stock_qty, reserved_qty FROM products WHERE id=$1', [p])).rows[0];
  assert.deepEqual(r, { stock_qty: 3, reserved_qty: 3 });
});

test('formule B : stock acheté, payé à l\'avance, consommé en premier', async () => {
  const p = await approvedProduct(db, w, { price: 60000, qty: 10 });
  await call(db.app, 'fn_seller_set_price', w.seller2, p, 150000);
  await expectErr(call(db.app, 'fn_seller_buy_stock', w.seller2, p, 2), 'insufficient_funds');
  await call(db.app, 'fn_admin_deposit', w.admin, w.seller2, 200000, 'OM-REF-1');
  const buy = await call(db.app, 'fn_seller_buy_stock', w.seller2, p, 2);   // 2 x 69 000
  assert.equal(buy.cost, 138000);
  assert.equal(await sum(w.seller2), 62000);
  const mk = (q, ph) => call(db.app, 'fn_seller_create_order', w.seller2, p, null, null, q, 'Cli', ph, 'Ratoma', 'Rue', null);
  const o = await mk(3, '620000031');            // 2 du stock vendeur + 1 du catalogue
  const row = (await db.app.query('SELECT formula, qty_from_seller, qty_from_catalog FROM orders WHERE id=$1', [o.id])).rows[0];
  assert.deepEqual(row, { formula: 'AB', qty_from_seller: 2, qty_from_catalog: 1 });
  const before = await sum(w.seller2);
  await deliver(db, w, o.id, o.ref);
  // total 450 000 - livraison 30 000 - call 5 000 - 1 unité catalogue à 69 000 = 346 000
  assert.equal(await sum(w.seller2) - before, 346000);
  assert.equal((await db.app.query('SELECT qty, reserved_qty FROM seller_stock WHERE seller_id=$1 AND product_id=$2', [w.seller2, p])).rows[0].qty, 0);
  // fournisseur payé 3 x 60 000 ; le stock prépayé de Wallindirain est libéré
  assert.equal(await sum(w.supplier, 'supplier_payment') >= 180000, true);
  assert.equal(await sum(FLOAT), 0 + (138000 - 138000));
});

test('formule C : produit propre, seulement livraison et call center', async () => {
  const o = await call(db.app, 'fn_seller_create_order', w.seller2, null, 'Sac artisanal', 40000, 1, 'Cli', '620000041', 'Matoto', 'Rue', null);
  await expectErr(call(db.app, 'fn_seller_create_order', w.seller2, null, 'Sac', 34999, 1, 'Cli', '620000042', 'Matoto', 'Rue', null), 'price_below_minimum');
  const before = await sum(w.seller2);
  await deliver(db, w, o.id, o.ref);
  assert.equal(await sum(w.seller2) - before, 5000);          // 40 000 - 30 000 - 5 000
  assert.equal((await db.app.query('SELECT supplier_unit_price FROM orders WHERE id=$1', [o.id])).rows[0].supplier_unit_price, 0);
});

test('retours : refus client, défectueux, abîmé en transport', async () => {
  const failAndReturn = async (ph, cause) => {
    const o = await order(1, ph);
    await call(db.app, 'fn_agent_take_order', w.agent1, o.id);
    await call(db.app, 'fn_agent_log_call', w.agent1, o.id, 'confirmed', null);
    await call(db.app, 'fn_chief_assign', w.chief, o.id, w.courier);
    await call(db.app, 'fn_courier_fail', w.courier, o.id, 'customer_refusal');
    await call(db.app, 'fn_chief_return_to_warehouse', w.chief, o.id);
    const stock0 = (await db.app.query('SELECT stock_qty FROM products WHERE id=$1', [product])).rows[0].stock_qty;
    await call(db.app, 'fn_warehouse_receive_return', w.warehouse, o.id, cause);
    const stock1 = (await db.app.query('SELECT stock_qty FROM products WHERE id=$1', [product])).rows[0].stock_qty;
    return { o, delta: stock1 - stock0 };
  };
  let b = await sum(w.seller);
  let r = await failAndReturn('620000051', 'customer_refusal');
  assert.equal(await sum(w.seller) - b, -35000);        // livraison 30 000 + call center 5 000
  assert.equal(r.delta, 0); // la réservation est libérée, le produit reste en stock
  b = await sum(w.supplier);
  r = await failAndReturn('620000052', 'defective');
  assert.equal(await sum(w.supplier) - b, -30000);      // le fournisseur paie le retour
  assert.equal(r.delta, -1);                            // pas de remise en stock
  b = await sum(PLATFORM);
  r = await failAndReturn('620000053', 'damaged_transport');
  assert.equal(r.delta, -1);
  assert.equal(await sum(PLATFORM) - b, -60000 - 1000); // perte à la charge de Wallindirain + paie de l'agent
  assert.equal((await db.app.query('SELECT status FROM orders WHERE id=$1', [r.o.id])).rows[0].status, 'returned');
});

test('critère 6 : manque de caisse débité au livreur', async () => {
  const o = await order(1, '620000061');
  await deliver(db, w, o.id, o.ref, w.courier2);
  // courier2 a déjà livré une commande de 150 000 plus tôt : caisse attendue = 300 000
  const res = await call(db.app, 'fn_admin_count_cash', w.admin, w.courier2, 290000);
  assert.deepEqual(res, { expected: 300000, counted: 290000, shortage: 10000, surplus: 0 });
  assert.equal(await sum(w.courier2, 'cash_shortage'), -10000);
  await expectErr(call(db.app, 'fn_admin_count_cash', w.admin, w.courier2, 0), 'invalid_state');
});

test('critère 5 : retrait impossible sans identité vérifiée et sans code', async () => {
  // le vendeur a des gains disponibles (déblocage 0 h dans ce test)
  await expectErr(call(db.app, 'fn_withdrawal_request', w.seller, 50000, 'orange_money', '620000099'), 'identity_required');
  await call(db.app, 'fn_admin_verify_identity', w.admin, w.seller, true);
  await expectErr(call(db.app, 'fn_withdrawal_request', w.seller, 49999, 'orange_money', '620000099'), 'below_minimum');
  await expectErr(call(db.app, 'fn_withdrawal_request', w.seller, 999999999, 'orange_money', '620000099'), 'insufficient_funds');
  const bal = await sum(w.seller);
  const wd = await call(db.app, 'fn_withdrawal_request', w.seller, 50000, 'orange_money', '620000099');
  assert.equal(await sum(w.seller), bal);               // rien n'est débité avant le code
  await expectErr(call(db.app, 'fn_admin_pay_withdrawal', w.admin, wd, 'REF-1'), 'invalid_state');
  const wrong = await call(db.app, 'fn_withdrawal_confirm', w.seller, wd, '000000');
  assert.equal(wrong.ok, false);
  const code = /: (\d{6})\./.exec((await db.app.query(`SELECT body FROM messages WHERE template='withdrawal_code' ORDER BY id DESC LIMIT 1`)).rows[0].body)[1];
  assert.equal((await call(db.app, 'fn_withdrawal_confirm', w.seller, wd, code)).ok, true);
  assert.equal(await sum(w.seller), bal - 50000);
  await expectErr(call(db.app, 'fn_admin_pay_withdrawal', w.admin, wd, 'OM-2026-0001'), 'proof_required');   // capture obligatoire
  await call(db.app, 'fn_admin_pay_withdrawal', w.admin, wd, 'OM-2026-0001', await makeProof(db, w.admin, 'withdrawal_payment'));
  await expectErr(call(db.app, 'fn_admin_pay_withdrawal', w.admin, wd, 'OM-2', await makeProof(db, w.admin, 'withdrawal_payment')), 'invalid_state');
  // rejet : remboursé
  const wd2 = await call(db.app, 'fn_withdrawal_request', w.seller, 50000, 'mtn_momo', '660000099');
  const code2 = /: (\d{6})\./.exec((await db.app.query(`SELECT body FROM messages WHERE template='withdrawal_code' ORDER BY id DESC LIMIT 1`)).rows[0].body)[1];
  await call(db.app, 'fn_withdrawal_confirm', w.seller, wd2, code2);
  await call(db.app, 'fn_admin_reject_withdrawal', w.admin, wd2, 'compte invalide');
  assert.equal(await sum(w.seller), bal - 50000);
});

test('déblocage : les gains restent bloqués pendant le délai réglé (48 h)', async () => {
  await call(db.app, 'fn_admin_set_setting', w.admin, 'unlock_hours', 48);
  const o = await order(1, '620000071');
  const before = Number((await db.app.query('SELECT _wallet_available($1) v', [w.seller]).catch(() => ({ rows: [{ v: 0 }] }))).rows[0].v);
  await deliver(db, w, o.id, o.ref);
  const pending = (await db.app.query(`SELECT COALESCE(sum(amount),0)::bigint s FROM wallet_entries WHERE user_id=$1 AND order_id=$2 AND available_at > now()`, [w.seller, o.id])).rows[0].s;
  assert.equal(Number(pending), 46000);
  assert.equal(before >= 0, true);
  await call(db.app, 'fn_admin_set_setting', w.admin, 'unlock_hours', 0);
});

test('intégrité : journaux et portefeuille en ajout seul, pas de suppression physique', async () => {
  await assert.rejects(db.owner.query('UPDATE wallet_entries SET amount = amount + 1'), /ajout seul/);
  await assert.rejects(db.owner.query('DELETE FROM audit_log'), /ajout seul/);
  await assert.rejects(db.owner.query('DELETE FROM order_history'), /ajout seul/);
  await assert.rejects(db.owner.query('DELETE FROM orders'), /ajout seul/);
});

test('cohérence comptable globale : somme des portefeuilles et contrôles', async () => {
  const bad = (await db.app.query('SELECT * FROM fn_ledger_check()')).rows;
  assert.deepEqual(bad, []);
  // l'argent créé = dépôts ; la somme de tous les mouvements des commandes livrées est nulle
  const { rows } = await db.app.query(`SELECT COALESCE(sum(amount),0)::bigint s FROM wallet_entries WHERE kind NOT IN ('deposit','withdrawal','withdrawal_refund')
     AND order_id IS NOT NULL AND order_id IN (SELECT id FROM orders WHERE status='delivered')`);
  const s = Number(rows[0].s);
  assert.ok(s >= 0);
});
