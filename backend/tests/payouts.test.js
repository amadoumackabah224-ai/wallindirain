// Tests : numéro de versement, captures d'écran de preuve, reversements des livreurs, outils d'administration.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, call, expectErr, world, approvedProduct, codeOf, makeProof, PNG } from './helpers.js';

let db, w, product;
const PLATFORM = '00000000-0000-0000-0000-000000000001';
const sum = async (user, kind) => Number((await db.app.query(
  `SELECT COALESCE(sum(amount),0)::bigint s FROM wallet_entries WHERE user_id=$1 ${kind ? 'AND kind=$2' : ''}`, kind ? [user, kind] : [user])).rows[0].s);

before(async () => {
  db = await freshDb('wld_payouts');
  w = await world(db);
  await call(db.app, 'fn_admin_set_setting', w.admin, 'unlock_hours', 0);
  product = await approvedProduct(db, w, { qty: 20 });
  await call(db.app, 'fn_seller_set_price', w.seller, product, 150000);
});
after(async () => { await db.app.end(); await db.owner.end(); });

// commande prête à livrer : renvoie l'id et la référence (étapes jusqu'à « en route »)
async function onTheWay(phone, courier = w.courier) {
  const o = await call(db.app, 'fn_seller_create_order', w.seller, product, null, null, 1, 'Client Test', phone, 'Ratoma', 'Rue 1', null);
  await call(db.app, 'fn_agent_take_order', w.agent1, o.id);
  await call(db.app, 'fn_agent_log_call', w.agent1, o.id, 'confirmed', 'OK');
  await call(db.app, 'fn_chief_assign', w.chief, o.id, courier);
  await call(db.app, 'fn_courier_pickup', courier, o.id);
  await call(db.app, 'fn_courier_depart', courier, o.id);
  return o;
}
const finish = async (o, courier = w.courier) => (await call(db.app, 'fn_courier_deliver', courier, o.id, await codeOf(db, o.ref))).ok;
const withdrawalCode = async () => /: (\d{6})\./.exec((await db.app.query(`SELECT body FROM messages WHERE template='withdrawal_code' ORDER BY id DESC LIMIT 1`)).rows[0].body)[1];

test('numéro de versement : enregistré à l\'inscription, le retrait part toujours vers lui', async () => {
  const s = await call(db.app, 'fn_register', '691000001', 'Vendeur Payé', 'seller', 'x', 'CNI-909090', 'orange_money', '622111222');
  await call(db.app, 'fn_admin_verify_identity', w.admin, s, true);
  await call(db.app, 'fn_admin_deposit', w.admin, s, 200000, 'DEP-1');
  // même si on essaie d'imposer un autre numéro, c'est le numéro enregistré qui est utilisé
  const wd = await call(db.app, 'fn_withdrawal_request', s, 50000, 'mtn_momo', '666999888');
  const row = (await db.app.query('SELECT method, account_number FROM withdrawals WHERE id=$1', [wd])).rows[0];
  assert.deepEqual(row, { method: 'orange_money', account_number: '622111222' });
  // opérateur sans numéro (ou l'inverse) : refusé
  await expectErr(call(db.app, 'fn_register', '691000002', 'Vendeur', 'seller', 'x', 'CNI-909091', 'orange_money', null), 'invalid_input');
  await expectErr(call(db.app, 'fn_register', '691000003', 'Vendeur', 'seller', 'x', 'CNI-909092', 'orange_money', '12345'), 'invalid_input');
});

test('numéro de versement : à définir une seule fois, ensuite seule l\'administration le change', async () => {
  const s = await call(db.app, 'fn_register', '691000010', 'Sans Numéro', 'seller', 'x', 'CNI-808080');
  await call(db.app, 'fn_admin_verify_identity', w.admin, s, true);
  await call(db.app, 'fn_admin_deposit', w.admin, s, 100000, 'DEP-2');
  await expectErr(call(db.app, 'fn_withdrawal_request', s, 50000), 'payout_missing');
  await call(db.app, 'fn_set_payout', s, 'mtn_momo', '666000111');
  await expectErr(call(db.app, 'fn_set_payout', s, 'orange_money', '622000000'), 'payout_locked');
  await expectErr(call(db.app, 'fn_set_payout', w.courier, 'xxx', '622000000'), 'invalid_input');
  const wd = await call(db.app, 'fn_withdrawal_request', s, 50000);
  assert.equal((await db.app.query('SELECT account_number FROM withdrawals WHERE id=$1', [wd])).rows[0].account_number, '666000111');
  // l'administration peut le modifier ; c'est journalisé
  await call(db.app, 'fn_admin_update_user', w.admin, s, 'Sans Numéro', null, 'orange_money', '622555444');
  const u = (await db.app.query('SELECT payout_method, payout_phone FROM users WHERE id=$1', [s])).rows[0];
  assert.deepEqual(u, { payout_method: 'orange_money', payout_phone: '622555444' });
  const log = await db.app.query(`SELECT details FROM audit_log WHERE action='user_updated' AND entity_id=$1`, [s]);
  assert.equal(log.rows[0].details.payout_changed, true);
  await expectErr(call(db.app, 'fn_admin_update_user', w.seller, s, 'Pirate', null, null, null), 'forbidden');
});

test('preuves : seul l\'admin joint la capture d\'un retrait, une capture ne sert qu\'une fois', async () => {
  const s = await call(db.app, 'fn_register', '691000020', 'Vendeur Preuve', 'seller', 'x', 'CNI-707070', 'mtn_momo', '666777888');
  await call(db.app, 'fn_admin_verify_identity', w.admin, s, true);
  await call(db.app, 'fn_admin_deposit', w.admin, s, 300000, 'DEP-3');
  const mk = async () => {
    const id = await call(db.app, 'fn_withdrawal_request', s, 50000);
    assert.equal((await call(db.app, 'fn_withdrawal_confirm', s, id, await withdrawalCode())).ok, true);
    return id;
  };
  const wd1 = await mk(), wd2 = await mk();
  // types et rôles
  await expectErr(call(db.app, 'fn_proof_create', w.courier, 'withdrawal_payment', 'image/png', PNG), 'forbidden');
  await expectErr(call(db.app, 'fn_proof_create', w.admin, 'remittance', 'image/png', PNG), 'forbidden');
  await expectErr(call(db.app, 'fn_proof_create', w.admin, 'inconnu', 'image/png', PNG), 'invalid_input');
  await expectErr(call(db.app, 'fn_proof_create', w.admin, 'withdrawal_payment', 'image/png', Buffer.alloc(700001, 1)), 'invalid_input');
  await assert.rejects(call(db.app, 'fn_proof_create', w.admin, 'withdrawal_payment', 'application/pdf', PNG), /check constraint/);   // seuls JPEG, PNG et WebP
  // sans capture : refusé tant que le réglage l'exige
  await expectErr(call(db.app, 'fn_admin_pay_withdrawal', w.admin, wd1, 'OM-100'), 'proof_required');
  // capture d'un autre type / d'un autre auteur : refusée
  const ownProof = await makeProof(db, w.admin, 'withdrawal_payment');
  const courierProof = await makeProof(db, w.courier, 'remittance');
  await expectErr(call(db.app, 'fn_admin_pay_withdrawal', w.admin, wd1, 'OM-100', courierProof), 'invalid_proof');
  await call(db.app, 'fn_admin_pay_withdrawal', w.admin, wd1, 'OM-100', ownProof);
  // même capture réutilisée sur un autre retrait : refusée
  await expectErr(call(db.app, 'fn_admin_pay_withdrawal', w.admin, wd2, 'OM-101', ownProof), 'invalid_proof');
  // si l'administration désactive l'obligation, le paiement reste possible sans capture
  await call(db.app, 'fn_admin_set_setting', w.admin, 'require_payment_proof', 0);
  await call(db.app, 'fn_admin_pay_withdrawal', w.admin, wd2, 'OM-101');
  await call(db.app, 'fn_admin_set_setting', w.admin, 'require_payment_proof', 1);
  // lecture : le bénéficiaire et l'admin voient la capture, personne d'autre
  const got = (await db.app.query('SELECT * FROM fn_proof_get($1,$2)', [s, ownProof])).rows[0];
  assert.equal(got.mime, 'image/png');
  assert.deepEqual(got.data, PNG);
  assert.equal((await db.app.query('SELECT * FROM fn_proof_get($1,$2)', [w.admin, ownProof])).rows.length, 1);
  await expectErr(db.app.query('SELECT * FROM fn_proof_get($1,$2)', [w.seller, ownProof]), 'forbidden');
  await expectErr(db.app.query('SELECT * FROM fn_proof_get($1,$2)', [w.courier, ownProof]), 'forbidden');
  // les images ne sortent pas par une lecture directe de la table
  await assert.rejects(db.app.query('SELECT data FROM proofs'), /permission denied/);
  assert.equal((await db.app.query('SELECT id, kind FROM proofs')).rows.length > 0, true);
  // les preuves ne se modifient ni ne se suppriment
  await assert.rejects(db.owner.query('DELETE FROM proofs'), /ajout seul/);
});

test('livreur : paiement du client par transfert exige une capture ; une seule déclaration par commande', async () => {
  const o = await onTheWay('620100001');
  await expectErr(call(db.app, 'fn_courier_declare_payment', w.courier, o.id, 'orange_money', null, null), 'proof_required');
  await expectErr(call(db.app, 'fn_courier_declare_payment', w.courier2, o.id, 'cash', null, null), 'invalid_state');   // pas son colis
  const proof = await makeProof(db, w.courier, 'order_payment');
  await call(db.app, 'fn_courier_declare_payment', w.courier, o.id, 'orange_money', proof, 'TRX-42');
  await expectErr(call(db.app, 'fn_courier_declare_payment', w.courier, o.id, 'cash', null, null), 'already_taken');
  const pay = (await db.app.query('SELECT method, reference, proof_id FROM order_payments WHERE order_id=$1', [o.id])).rows[0];
  assert.deepEqual(pay, { method: 'orange_money', reference: 'TRX-42', proof_id: proof });
  assert.equal(await finish(o), true);                                  // la livraison fonctionne comme avant
  const o2 = await onTheWay('620100002');
  await call(db.app, 'fn_courier_declare_payment', w.courier, o2.id, 'cash', null, null);
  assert.equal((await db.app.query('SELECT proof_id FROM order_payments WHERE order_id=$1', [o2.id])).rows[0].proof_id, null);
  assert.equal(await finish(o2), true);
});

test('reversement par transfert : confirmé avec écart, puis refusé et remis en caisse', async () => {
  // le livreur 2 encaisse deux commandes de 150 000 GNF
  const a = await onTheWay('620200001', w.courier2); await finish(a, w.courier2);
  const b = await onTheWay('620200002', w.courier2); await finish(b, w.courier2);
  const outstanding = async () => Number((await db.app.query(
    `SELECT COALESCE(sum(amount),0)::bigint s FROM courier_cash_entries WHERE courier_id=$1 AND count_id IS NULL AND remittance_id IS NULL`, [w.courier2])).rows[0].s);
  assert.equal(await outstanding(), 300000);

  // il reverse seulement la première commande
  const p1 = await makeProof(db, w.courier2, 'remittance');
  await expectErr(call(db.app, 'fn_courier_remit', w.courier2, 'orange_money', p1, null, [a.id, '00000000-0000-0000-0000-0000000000aa']), 'invalid_state');
  const r = await call(db.app, 'fn_courier_remit', w.courier2, 'orange_money', p1, 'TRX-A', [a.id]);
  assert.equal(r.amount, 150000);
  assert.equal(await outstanding(), 150000);                             // la 2e commande reste à compter en espèces
  await expectErr(call(db.app, 'fn_courier_remit', w.courier2, 'orange_money', p1, null, [b.id]), 'invalid_proof');   // capture déjà utilisée
  await expectErr(call(db.app, 'fn_admin_confirm_remittance', w.courier, r.id, 150000), 'forbidden');

  // l'admin compte les espèces : seule la part hors reversement est attendue
  const cash = await call(db.app, 'fn_admin_count_cash', w.admin, w.courier2, 150000);
  assert.deepEqual([cash.expected, cash.shortage], [150000, 0]);

  // l'admin ne reçoit que 140 000 GNF sur son téléphone : 10 000 GNF de manque débités au livreur
  const before = await sum(w.courier2, 'cash_shortage');
  const ok = await call(db.app, 'fn_admin_confirm_remittance', w.admin, r.id, 140000);
  assert.deepEqual([ok.expected, ok.received, ok.shortage], [150000, 140000, 10000]);
  assert.equal(await sum(w.courier2, 'cash_shortage') - before, -10000);
  await expectErr(call(db.app, 'fn_admin_confirm_remittance', w.admin, r.id, 150000), 'invalid_state');   // déjà traité
  assert.equal((await db.app.query('SELECT status, received FROM remittances WHERE id=$1', [r.id])).rows[0].status, 'confirmed');

  // un reversement refusé libère les encaissements
  const c = await onTheWay('620200003', w.courier2); await finish(c, w.courier2);
  const p2 = await makeProof(db, w.courier2, 'remittance');
  const r2 = await call(db.app, 'fn_courier_remit', w.courier2, 'mtn_momo', p2, null);
  assert.equal(await outstanding(), 0);
  await expectErr(call(db.app, 'fn_admin_reject_remittance', w.admin, r2.id, 'x'), 'invalid_input');
  await call(db.app, 'fn_admin_reject_remittance', w.admin, r2.id, 'transfert non reçu');
  assert.equal(await outstanding(), 150000);
  const left = await call(db.app, 'fn_admin_count_cash', w.admin, w.courier2, 150000);
  assert.equal(left.shortage, 0);

  // les comptes restent cohérents
  assert.equal((await db.app.query('SELECT count(*)::int n FROM fn_ledger_check()')).rows[0].n, 0);
  assert.equal(await sum(PLATFORM, 'cash_shortage'), 10000);
});

test('administration : mot de passe réinitialisé (sessions coupées) et compte déverrouillé', async () => {
  const target = w.seller2;
  await db.owner.query(`UPDATE users SET locked_until = now() + interval '10 minutes', failed_attempts = 3 WHERE id = $1`, [target]);
  await db.app.query('SELECT fn_session_create($1, $2)', [target, 'hash-de-session']);
  await call(db.app, 'fn_admin_unlock_user', w.admin, target);
  assert.equal((await db.owner.query('SELECT locked_until, failed_attempts FROM users WHERE id=$1', [target])).rows[0].failed_attempts, 0);
  await call(db.app, 'fn_admin_reset_password', w.admin, target, 'pbkdf2$nouveau');
  assert.equal((await db.owner.query('SELECT password_hash FROM users WHERE id=$1', [target])).rows[0].password_hash, 'pbkdf2$nouveau');
  assert.equal((await db.owner.query('SELECT count(*)::int n FROM sessions WHERE user_id=$1', [target])).rows[0].n, 0);
  await expectErr(call(db.app, 'fn_admin_reset_password', w.seller, target, 'x'), 'forbidden');
  await expectErr(call(db.app, 'fn_admin_reset_password', w.admin, '00000000-0000-0000-0000-000000000001', 'x'), 'not_found');
});

test('messages : un code réellement envoyé n\'est plus conservé en clair', async () => {
  const s = await call(db.app, 'fn_register', '691000030', 'Vendeur Code', 'seller', 'x', 'CNI-606060', 'orange_money', '622000303');
  await call(db.app, 'fn_password_reset_request', '691000030');
  const m = (await db.app.query(`SELECT id, body FROM messages WHERE template='password_reset' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.match(m.body, /est \d{6}\./);
  await call(db.app, 'fn_message_mark', m.id, 'simulated', null);       // mode test : le code reste lisible
  assert.match((await db.app.query('SELECT body FROM messages WHERE id=$1', [m.id])).rows[0].body, /est \d{6}\./);
  await call(db.app, 'fn_message_mark', m.id, 'sent', null);            // envoi réel : le code est masqué
  assert.match((await db.app.query('SELECT body FROM messages WHERE id=$1', [m.id])).rows[0].body, /est ••••\./);
  assert.ok(s);
});
