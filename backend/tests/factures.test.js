// Migration 033 : factures et documents numérotés. Émission à la demande, numérotation sans trou, figés ; aucun argent créé ni modifié.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { splitSql } from '../src/migrate.js';
import { freshDb, world, approvedProduct, call, expectErr, deliver, makeProof } from './helpers.js';

let db, w, product, n = 0;
const root = path.resolve(import.meta.dirname, '..', '..');
const ph = () => `64${String(++n + 7000000).padStart(7, '0')}`;
const money = async () => (await db.owner.query(`SELECT count(*)::int AS c, COALESCE(sum(amount),0)::text AS s, md5(string_agg(w::text, ',' ORDER BY id)) AS h FROM wallet_entries w`)).rows[0];
const mk = (qty = 1) => call(db.app, 'fn_seller_create_order', w.seller, product, null, null, qty, 'Cliente Test', ph(), 'Kaloum', 'Rue 7', null, false);
const delivered = async (qty = 1) => { const o = await mk(qty); await deliver(db, w, o.id, o.ref); return o; };
const inv = async (id) => (await db.owner.query('SELECT * FROM invoices WHERE id = $1', [id])).rows[0];
const backdate = async (days) => {                                   // le relevé ne porte que sur des journées terminées : on recule les dates des opérations de test
  await db.owner.query('ALTER TABLE wallet_entries DISABLE TRIGGER USER');
  await db.owner.query(`UPDATE wallet_entries SET created_at = created_at - make_interval(days => $1)`, [days]);
  await db.owner.query('ALTER TABLE wallet_entries ENABLE TRIGGER USER');
  await db.owner.query(`UPDATE orders SET delivered_at = delivered_at - make_interval(days => $1) WHERE delivered_at IS NOT NULL`, [days]);
};
const iso = (d) => d.toISOString().slice(0, 10);
const ago = (k) => iso(new Date(Date.now() - k * 86400_000));

before(async () => { db = await freshDb('wld_factures'); w = await world(db); product = await approvedProduct(db, w, { price: 60000, qty: 60 }); await call(db.app, 'fn_seller_set_price', w.seller, product, 120000); });
after(async () => { await db.owner.end(); await db.app.end(); });

test('facture de livraison : seulement commande livrée, une seule par commande, numéro sans trou, montants = ceux de la commande, rien de confidentiel', async () => {
  const o = await mk();
  await expectErr(call(db.app, 'fn_invoice_issue_delivery', w.seller, o.id), 'invalid_state');            // pas encore livrée
  await deliver(db, w, o.id, o.ref);
  const m0 = await money();
  const id = await call(db.app, 'fn_invoice_issue_delivery', w.seller, o.id);
  const i = await inv(id);
  assert.match(i.number, new RegExp(`^FAC-${new Date().getFullYear()}-000001$`));
  const ord = (await db.owner.query('SELECT sale_total, delivery_fee, qty FROM orders WHERE id = $1', [o.id])).rows[0];
  assert.equal(String(i.total), String(ord.sale_total));
  const lines = i.data.lines; assert.equal(lines.reduce((s, l) => s + Number(l.amount), 0), Number(ord.sale_total));
  assert.equal(lines[1].amount, Number(ord.delivery_fee));
  assert.equal(i.data.recipient.name, 'Cliente Test'); assert.equal(i.data.order_ref, o.ref);
  assert.doesNotMatch(JSON.stringify(i.data), /margin|supplier|call_fee|platform|courier/i);
  assert.equal(await call(db.app, 'fn_invoice_issue_delivery', w.seller, o.id), id);                        // idempotent : même document
  assert.equal(await call(db.app, 'fn_invoice_issue_delivery', w.admin, o.id), id);
  await expectErr(call(db.app, 'fn_invoice_issue_delivery', w.seller2, o.id), 'not_found');                 // le vendeur d'un autre ne peut pas
  await expectErr(call(db.app, 'fn_invoice_issue_delivery', w.courier, o.id), 'forbidden');
  assert.deepEqual(await money(), m0);                                                                      // aucune écriture d'argent
  const o2 = await delivered();
  const i2 = await inv(await call(db.app, 'fn_invoice_issue_delivery', w.seller, o2.id));
  assert.match(i2.number, /-000002$/);
});

test('numérotation sans trou : une émission annulée ne consomme pas de numéro', async () => {
  const o = await delivered();
  const last = (await db.owner.query(`SELECT last FROM invoice_counters WHERE prefix = 'FAC'`)).rows[0].last;
  await db.owner.query('BEGIN');
  await db.owner.query(`SELECT fn_invoice_issue_delivery($1, $2)`, [w.seller, o.id]);
  await db.owner.query('ROLLBACK');
  assert.equal((await db.owner.query(`SELECT last FROM invoice_counters WHERE prefix = 'FAC'`)).rows[0].last, last);
  const id = await call(db.app, 'fn_invoice_issue_delivery', w.seller, o.id);
  assert.match((await inv(id)).number, new RegExp(`-${String(last + 1).padStart(6, '0')}$`));
});

test('documents figés : ni modification ni suppression ; les informations de l\'entreprise sont copiées à l\'émission', async () => {
  await call(db.app, 'fn_admin_set_company', w.admin, 'Wallindirain SARL', 'Kaloum, Conakry', '620000000', null, 'NIF-123', '', 'Merci de votre confiance');
  const o = await delivered();
  const id = await call(db.app, 'fn_invoice_issue_delivery', w.admin, o.id);
  const i = await inv(id);
  assert.deepEqual(i.data.issuer, { name: 'Wallindirain SARL', address: 'Kaloum, Conakry', phone: '620000000', nif: 'NIF-123', footer: 'Merci de votre confiance' });   // vides non imprimés
  await assert.rejects(db.owner.query(`UPDATE invoices SET total = 1 WHERE id = $1`, [id]));
  await assert.rejects(db.owner.query(`DELETE FROM invoices WHERE id = $1`, [id]));
  await call(db.app, 'fn_admin_set_company', w.admin, 'Autre nom', null, null, null, null, null, null);
  assert.equal((await inv(id)).data.issuer.name, 'Wallindirain SARL');                                       // l'ancien document ne change pas
  await expectErr(call(db.app, 'fn_admin_set_company', w.seller, 'X Y', null, null, null, null, null, null), 'forbidden');
  await assert.rejects(db.app.query('SELECT data FROM invoices'), /permission denied/);                      // le contenu n'est lisible que par les fonctions contrôlées
});

test('relevés de période : vendeur (frais de service) et fournisseur (ventes) = somme exacte de ce qui existe ; chevauchement, période en cours et période vide refusés', async () => {
  await backdate(10);
  const m0 = await money();
  const fees = (await db.owner.query(`SELECT COALESCE(sum(delivery_fee + call_fee + platform_fee), 0)::text AS f, count(*)::int AS c FROM orders WHERE seller_id = $1 AND status = 'delivered'`, [w.seller])).rows[0];
  const sup = (await db.owner.query(`SELECT COALESCE(sum(amount), 0)::text AS s FROM wallet_entries WHERE user_id = $1 AND kind IN ('supplier_payment','return_fee_supplier','transport_loss')`, [w.supplier])).rows[0].s;
  assert.ok(Number(fees.c) >= 3);
  const from = ago(20), to = ago(1);
  const sid = await call(db.app, 'fn_invoice_issue_statement', w.seller, null, from, to);
  const si = await inv(sid);
  assert.equal(si.kind, 'seller_services'); assert.match(si.number, /^FSV-/);
  assert.equal(String(si.total), fees.f);
  assert.equal(si.data.lines.filter((l) => l.ref).length, fees.c);
  const pid = await call(db.app, 'fn_invoice_issue_statement', w.supplier, null, from, to);
  const pi = await inv(pid);
  assert.equal(pi.kind, 'supplier_statement'); assert.match(pi.number, /^REL-/); assert.equal(String(pi.total), sup);
  assert.equal(await call(db.app, 'fn_invoice_issue_statement', w.seller, null, from, to), sid);              // même période : même document
  await expectErr(call(db.app, 'fn_invoice_issue_statement', w.seller, null, ago(15), ago(5)), 'invalid_state');   // chevauche
  await expectErr(call(db.app, 'fn_invoice_issue_statement', w.seller, null, ago(5), iso(new Date())), 'invalid_state');   // période non terminée
  await expectErr(call(db.app, 'fn_invoice_issue_statement', w.seller, null, ago(60), ago(50)), 'invalid_state');   // aucune activité
  await expectErr(call(db.app, 'fn_invoice_issue_statement', w.seller, null, to, from), 'invalid_input');
  await expectErr(call(db.app, 'fn_invoice_issue_statement', w.seller, w.seller2, ago(60), ago(50)), 'forbidden');   // le vendeur ne demande que pour lui
  await expectErr(call(db.app, 'fn_invoice_issue_statement', w.courier, null, from, to), 'forbidden');
  await expectErr(call(db.app, 'fn_invoice_issue_statement', w.admin, w.courier, from, to), 'invalid_input');
  const aid = await call(db.app, 'fn_invoice_issue_statement', w.admin, w.supplier, ago(40), ago(30)).catch((e) => e.message);
  assert.match(String(aid), /Aucune activité/);
  assert.deepEqual(await money(), m0);
});

test('reçu de retrait : seulement un retrait payé, numéro de compte masqué, une fois par retrait', async () => {
  await call(db.app, 'fn_admin_verify_identity', w.admin, w.seller, true);
  await call(db.app, 'fn_admin_deposit', w.admin, w.seller, 300000, 'DEP-F1');
  const wd = await call(db.app, 'fn_withdrawal_request', w.seller, 50000, 'orange_money', '622123456');
  await expectErr(call(db.app, 'fn_invoice_issue_withdrawal', w.seller, wd), 'invalid_state');                // pas encore payé
  await call(db.app, 'fn_admin_pay_withdrawal', w.admin, wd, 'OM-998877', await makeProof(db, w.admin, 'withdrawal_payment'));
  const id = await call(db.app, 'fn_invoice_issue_withdrawal', w.seller, wd);
  const i = await inv(id);
  assert.match(i.number, /^REC-/); assert.equal(String(i.total), '50000');
  assert.doesNotMatch(JSON.stringify(i.data), /622123456/);
  assert.match(i.data.lines[0].label, /622••••56/); assert.equal(i.data.payment_ref, 'OM-998877');
  assert.equal(await call(db.app, 'fn_invoice_issue_withdrawal', w.admin, wd), id);
  await expectErr(call(db.app, 'fn_invoice_issue_withdrawal', w.seller2, wd), 'not_found');
});

test('lecture et liste : chacun ne voit que ses documents, l\'administrateur voit tout ; filtres', async () => {
  const mine = (await db.app.query('SELECT * FROM fn_invoice_list($1)', [w.seller])).rows;
  const sup = (await db.app.query('SELECT * FROM fn_invoice_list($1)', [w.supplier])).rows;
  const all = (await db.app.query('SELECT * FROM fn_invoice_list($1)', [w.admin])).rows;
  assert.ok(mine.length >= 4 && sup.length === 1 && sup[0].kind === 'supplier_statement' && all.length >= mine.length + sup.length);
  assert.ok(mine.every((r) => r.user_name === 'Vendeur Un'));
  assert.equal((await db.app.query(`SELECT * FROM fn_invoice_list($1, 'withdrawal_receipt')`, [w.admin])).rows.length, 1);
  assert.equal((await db.app.query(`SELECT * FROM fn_invoice_list($1, NULL, NULL, NULL, 'FSV')`, [w.admin])).rows.length, 1);
  assert.equal((await db.app.query('SELECT * FROM fn_invoice_list($1)', [w.seller2])).rows.length, 0);
  const one = (await call(db.app, 'fn_invoice_get', w.supplier, sup[0].id));
  assert.equal(one.number, sup[0].number);
  await expectErr(call(db.app, 'fn_invoice_get', w.seller, sup[0].id), 'not_found');
  await expectErr(call(db.app, 'fn_invoice_get', w.warehouse, sup[0].id), 'forbidden');
});

test('vue d\'ensemble finance : les totaux correspondent exactement aux commandes, portefeuilles, retraits et documents', async () => {
  const s = await call(db.app, 'fn_admin_finance_summary', w.admin, ago(30), iso(new Date()));
  const d = (await db.owner.query(`SELECT count(*)::int AS c, COALESCE(sum(sale_total),0)::bigint AS t, COALESCE(sum(delivery_fee),0)::bigint AS df, COALESCE(sum(call_fee),0)::bigint AS cf, COALESCE(sum(platform_fee),0)::bigint AS pf FROM orders WHERE status = 'delivered'`)).rows[0];
  assert.equal(s.deliveries.count, d.c); assert.equal(String(s.deliveries.sale_total), String(d.t)); assert.equal(String(s.deliveries.delivery_fees), String(d.df));
  assert.equal(String(s.deliveries.call_fees), String(d.cf)); assert.equal(String(s.deliveries.platform_fees), String(d.pf));
  const led = (await db.owner.query(`SELECT COALESCE(sum(amount) FILTER (WHERE kind = 'seller_gain'),0)::text AS g, COALESCE(sum(amount) FILTER (WHERE kind = 'supplier_payment'),0)::text AS sp FROM wallet_entries`)).rows[0];
  assert.equal(String(s.ledger.seller_gain), led.g); assert.equal(String(s.ledger.supplier_payment), led.sp);
  assert.equal(s.withdrawals_paid.count, 1); assert.equal(Number(s.withdrawals_paid.total), 50000);
  const nInv = (await db.owner.query('SELECT count(*)::int AS n FROM invoices')).rows[0].n;
  assert.equal(Object.values(s.invoices).reduce((a, x) => a + x.count, 0), nInv);
  await expectErr(call(db.app, 'fn_admin_finance_summary', w.seller, ago(30), iso(new Date())), 'forbidden');
  await expectErr(call(db.app, 'fn_admin_finance_summary', w.admin, ago(1), ago(30)), 'invalid_input');
  assert.equal((await db.owner.query('SELECT count(*)::int AS n FROM fn_ledger_check()')).rows[0].n, 0);
});

test('retour arrière 033 : refusé tant qu\'un document a été émis', async () => {
  const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-033.sql'), 'utf8');
  await db.owner.query('BEGIN');
  try { for (const s of splitSql(rb)) { if (/^(begin|commit)$/i.test(s.trim())) continue; await db.owner.query(s); } await db.owner.query('COMMIT'); assert.fail('aurait dû refuser'); }
  catch (e) { await db.owner.query('ROLLBACK'); assert.match(e.message, /Retour arrière refusé/); }
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'fn_invoice_issue_delivery'`)).rows[0].n, 1);
});
