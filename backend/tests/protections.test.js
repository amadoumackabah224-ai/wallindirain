// Étape 0 : protections (migration 017) — doubles commandes, doubles règlements, garde-fou de paie, droits, retour arrière.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshDb, TEST_DB, APP_PW, world, approvedProduct, deliver, call, expectErr, makeProof } from './helpers.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';
import { Pool } from '../src/pg.js';
import { migrate, splitSql } from '../src/migrate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const PW = 'Secret123';
const VER = '2026-10-24';
const KEY = (n) => `prot-test-key-${String(n).padStart(8, '0')}`;
let db, w, product, srv, base, n = 0;
const setting = (k, v) => db.owner.query('UPDATE settings SET value = $2 WHERE key = $1', [k, v]);
const count = async (sql, p = []) => (await db.owner.query(sql, p)).rows[0].n;
const phone = () => `6${String(++n).padStart(8, '0')}`;
const create = (seller, key, over = {}) => call(db.app, 'fn_seller_create_order_once', seller, key, product, null, null, over.qty ?? 1, over.name ?? 'Client Test', over.phone ?? phone(), over.commune ?? 'Kaloum', over.address ?? 'Rue 1 Kaloum', null, over.pre ?? false);

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

before(async () => {
  db = await freshDb('wld_protect'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  product = await approvedProduct(db, w, { price: 60000, qty: 80 });
  for (const s of [w.seller, w.seller2]) await call(db.app, 'fn_seller_set_price', s, product, 120000);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_protect', user: 'wld_app', password: APP_PW, max: 8 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });

// ---------------------------------------------------------------- doubles commandes
test('formulaire vendeur : même clé deux fois = même commande, sans second stock ni second message', async () => {
  const ph = phone();
  const before = { orders: await count('SELECT count(*)::int AS n FROM orders'), msgs: await count('SELECT count(*)::int AS n FROM messages'),
    reserved: await count('SELECT reserved_qty AS n FROM products WHERE id = $1', [product]) };
  const a = await create(w.seller, KEY(1), { phone: ph, pre: true });                      // pré-confirmée : un message client est mis en file
  const b = await create(w.seller, KEY(1), { phone: ph, pre: true });
  assert.equal(a.replayed, false); assert.equal(b.replayed, true);
  assert.equal(b.id, a.id); assert.equal(b.ref, a.ref); assert.equal(b.sale_total, a.sale_total);
  assert.equal(await count('SELECT count(*)::int AS n FROM orders') - before.orders, 1);
  assert.equal(await count('SELECT reserved_qty AS n FROM products WHERE id = $1', [product]) - before.reserved, 1);       // stock réservé une seule fois
  assert.equal(await count('SELECT count(*)::int AS n FROM messages') - before.msgs, 1);                                    // un seul message envoyé
});

test('même clé envoyée 6 fois en même temps : une seule commande', async () => {
  const ph = phone(); const before = await count('SELECT count(*)::int AS n FROM orders');
  const res = await Promise.all(Array.from({ length: 6 }, () => create(w.seller, KEY(2), { phone: ph })));
  assert.equal(new Set(res.map((r) => r.id)).size, 1);
  assert.equal(res.filter((r) => r.replayed === false).length, 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM orders') - before, 1);
});

test('deux clés différentes : même client et produit = refus existant ; clients différents = deux commandes', async () => {
  const ph = phone();
  await create(w.seller, KEY(3), { phone: ph });
  await expectErr(create(w.seller, KEY(4), { phone: ph }), 'duplicate_order');
  const a = await create(w.seller, KEY(5)); const b = await create(w.seller, KEY(6));
  assert.notEqual(a.id, b.id);
});

test('même clé avec un contenu différent : refusée, aucune commande ; clé absente ou mal formée : refusée', async () => {
  const ph = phone(); await create(w.seller, KEY(7), { phone: ph });
  const before = await count('SELECT count(*)::int AS n FROM orders');
  await expectErr(create(w.seller, KEY(7), { phone: ph, qty: 2 }), 'key_reused');
  await expectErr(create(w.seller, KEY(7), { phone: ph, address: 'Autre adresse' }), 'key_reused');
  assert.equal(await count('SELECT count(*)::int AS n FROM orders'), before);
  await expectErr(create(w.seller, null), 'key_required');
  await expectErr(create(w.seller, 'trop-court'), 'key_required');
  await expectErr(create(w.seller, 'a'.repeat(65)), 'key_required');
  await expectErr(create(w.seller, "k'; DROP TABLE orders; --xx"), 'key_required');
});

test('une clé ne sert pas à un autre vendeur ; une commande échouée ne consomme pas la clé', async () => {
  const k = KEY(8);
  const a = await create(w.seller, k); const b = await create(w.seller2, k);
  assert.notEqual(a.id, b.id);
  assert.equal((await db.owner.query(`SELECT scope FROM order_requests WHERE req_key = $1 ORDER BY scope`, [k])).rowCount, 2);
  const ph = phone(); await create(w.seller, KEY(9), { phone: ph });
  await expectErr(create(w.seller, KEY(10), { phone: ph }), 'duplicate_order');                // refus métier : rien n'est enregistré
  assert.equal(await count(`SELECT count(*)::int AS n FROM order_requests WHERE req_key = $1`, [KEY(10)]), 0);
  await expectErr(call(db.app, 'fn_seller_create_order_once', w.supplier, KEY(11), product, null, null, 1, 'Cli', phone(), 'Kaloum', 'Rue 1', null, false), 'forbidden');   // réservé aux vendeurs
});

test('lien public : même clé = même référence et même jeton ; autre contenu ou autre lien refusés ; clé obligatoire', async () => {
  const code = await call(db.app, 'fn_seller_create_link', w.seller, product);
  const code2 = await call(db.app, 'fn_seller_create_link', w.seller2, product);
  const ph = phone(); const before = await count('SELECT count(*)::int AS n FROM orders');
  const pub = (link, key, over = {}) => call(db.app, 'fn_public_order_once', link, key, 1, 'Mariama Diallo', over.phone ?? ph, 'Kaloum', over.address ?? 'Marché de Kaloum', VER);
  const a = await pub(code, KEY(20)); const b = await pub(code, KEY(20));
  assert.equal(b.ref, a.ref); assert.equal(b.track_token, a.track_token); assert.equal(a.replayed, false); assert.equal(b.replayed, true);
  assert.ok(a.track_token);
  assert.equal(await count('SELECT count(*)::int AS n FROM orders') - before, 1);
  await expectErr(pub(code, KEY(20), { phone: phone() }), 'key_reused');                       // le jeton n'est pas rendu à un autre contenu
  const c = await pub(code2, KEY(20), { phone: phone() });                                       // même clé, autre lien : commande distincte
  assert.notEqual(c.ref, a.ref);
  await expectErr(pub(code, null), 'key_required');
  await expectErr(pub('inconnu', KEY(21)), 'not_found');
  const ph5 = phone();
  const par = await Promise.all(Array.from({ length: 5 }, () => call(db.app, 'fn_public_order_once', code2, KEY(22), 1, 'Abdoulaye Bah', ph5, 'Kaloum', 'Rue 3', VER)));
  assert.equal(new Set(par.map((r) => r.ref)).size, 1);                                                            // contenus identiques sauf téléphone : une seule passe, les autres sont refusées
});

test('parcours HTTP : sans clé 400 ; avec clé 201 puis rejeu 200 ; formulaire vendeur et lien public', async () => {
  const code = await call(db.app, 'fn_seller_create_link', w.seller, product);
  const anon = new Client();
  const body = { qty: 1, name: 'Client Web', phone: phone(), commune: 'Kaloum', address: 'Rue 9 Kaloum', accepted: true };
  const noKey = await anon.post(`/api/public/link/${code}/order`, body);
  assert.equal(noKey.status, 400); assert.equal(noKey.json.error, 'key_required'); assert.match(noKey.json.message, /Rechargez la page/);
  const consentsBefore = await count(`SELECT count(*)::int AS n FROM consents WHERE kind = 'order'`);
  assert.equal((await anon.post(`/api/public/link/${code}/order`, { ...body, accepted: true })).status, 400);
  assert.equal(await count(`SELECT count(*)::int AS n FROM consents WHERE kind = 'order'`), consentsBefore);       // sans clé, aucun consentement enregistré
  const ok = await anon.post(`/api/public/link/${code}/order`, { ...body, request_key: KEY(30) });
  assert.equal(ok.status, 201); const again = await anon.post(`/api/public/link/${code}/order`, { ...body, request_key: KEY(30) });
  assert.equal(again.status, 200); assert.equal(again.json.ref, ok.json.ref); assert.equal(again.json.replayed, true);
  assert.equal((await anon.post(`/api/public/link/${code}/order`, { ...body, phone: phone(), request_key: KEY(30) })).status, 409);

  const login = new Client();
  const sp = (await db.owner.query('SELECT phone FROM users WHERE id = $1', [w.seller])).rows[0].phone;
  assert.equal((await login.post('/api/auth/login', { identifier: sp, password: PW })).status, 200);
  const ord = { product_id: product, qty: 1, customer_name: 'Client Form', customer_phone: phone(), commune: 'Kaloum', address: 'Rue 5 Kaloum' };
  const sNo = await login.post('/api/seller/orders', ord); assert.equal(sNo.status, 400); assert.equal(sNo.json.error, 'key_required');
  const s1 = await login.post('/api/seller/orders', { ...ord, request_key: KEY(31) }); assert.equal(s1.status, 201);
  const s2 = await login.post('/api/seller/orders', { ...ord, request_key: KEY(31) }); assert.equal(s2.status, 200);
  assert.equal(s2.json.id, s1.json.id); assert.equal(s2.json.replayed, true);
  assert.equal((await login.post('/api/seller/orders', { ...ord, qty: 2, request_key: KEY(31) })).status, 409);
});

test('import de tableur : même ligne en parallèle = une commande, réponse « doublon » propre', async () => {
  const hash = 'ab'.repeat(32); const ph = phone(); const before = await count('SELECT count(*)::int AS n FROM orders');
  const res = await Promise.all(Array.from({ length: 5 }, () => call(db.app, 'fn_seller_import_order', w.seller, hash, product, null, null, 1, 'Client Import', ph, 'Kaloum', 'Rue 7', null, false)));
  assert.equal(res.filter((r) => r.duplicate).length, 4); assert.equal(res.filter((r) => r.id).length, 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM orders') - before, 1);
  assert.deepEqual(await call(db.app, 'fn_seller_import_order', w.seller, hash, product, null, null, 1, 'Client Import', ph, 'Kaloum', 'Rue 7', null, false), { duplicate: true });
});

// ---------------------------------------------------------------- écritures financières
test('règlement : une livraison normale écrit tout (dont les 2 écritures négatives team_pay de la plateforme) ; un rejeu est refusé', async () => {
  const o = await create(w.seller, KEY(40));
  await call(db.app, 'fn_agent_take_order', w.agent1, o.id);
  await call(db.app, 'fn_agent_log_call', w.agent1, o.id, 'confirmed', 'OK');
  await call(db.app, 'fn_chief_assign', w.chief, o.id, w.courier);
  await call(db.app, 'fn_courier_pickup', w.courier, o.id); await call(db.app, 'fn_courier_depart', w.courier, o.id);
  const code = (await db.app.query(`SELECT code FROM order_secrets WHERE order_id = $1`, [o.id]).catch(() => ({ rows: [] }))).rows[0]?.code
    ?? (await db.owner.query(`SELECT code FROM order_secrets WHERE order_id = $1`, [o.id])).rows[0].code;
  await call(db.app, 'fn_courier_deliver', w.courier, o.id, code);
  const neg = await count(`SELECT count(*)::int AS n FROM wallet_entries WHERE order_id = $1 AND kind = 'team_pay' AND amount < 0`, [o.id]);
  assert.equal(neg, 2);                                                                          // agent + livreur : légitime, non bloqué par l'index
  const total = await count(`SELECT count(*)::int AS n FROM wallet_entries WHERE order_id = $1`, [o.id]);
  await assert.rejects(db.owner.query(`SELECT _settle_delivery(o) FROM orders o WHERE o.id = $1`, [o.id]), (e) => e.code === '23505');
  assert.equal(await count(`SELECT count(*)::int AS n FROM wallet_entries WHERE order_id = $1`, [o.id]), total);          // rien d'ajouté
  assert.equal(await count('SELECT count(*)::int AS n FROM fn_ledger_check()'), 0);
});

test('retours : les trois causes (refus du client, défectueux, abîmé) fonctionnent toujours et ne s\'écrivent qu\'une fois', async () => {
  for (const cause of ['customer_refusal', 'defective', 'damaged_transport']) {
    const o = await create(w.seller, KEY(50 + ['customer_refusal', 'defective', 'damaged_transport'].indexOf(cause)));
    await call(db.app, 'fn_agent_take_order', w.agent1, o.id); await call(db.app, 'fn_agent_log_call', w.agent1, o.id, 'confirmed', 'OK');
    await call(db.app, 'fn_chief_assign', w.chief, o.id, w.courier); await call(db.app, 'fn_courier_pickup', w.courier, o.id);
    await call(db.app, 'fn_courier_fail', w.courier, o.id, 'customer_refusal');
    await call(db.app, 'fn_chief_return_to_warehouse', w.chief, o.id);
    await call(db.app, 'fn_warehouse_receive_return', w.warehouse, o.id, cause);
    await expectErr(call(db.app, 'fn_warehouse_receive_return', w.warehouse, o.id, cause), 'invalid_state');                  // un second rejeu est refusé
    const dup = await count(`SELECT count(*)::int AS n FROM (SELECT 1 FROM wallet_entries WHERE order_id = $1 GROUP BY user_id, kind HAVING count(*) > 1) d`, [o.id]);
    assert.equal(dup, 0, cause);
  }
  assert.equal(await count('SELECT count(*)::int AS n FROM fn_ledger_check()'), 0);
});

test('retrait : un paiement rejoué en parallèle ne débite qu\'une fois', async () => {
  const s = w.seller2;
  await db.owner.query(`UPDATE users SET identity_verified = true, payout_method = 'orange_money', payout_phone = '622334455' WHERE id = $1`, [s]);
  await call(db.app, 'fn_admin_deposit', w.admin, s, 500000, 'DEP-PROT');
  const wd = await call(db.app, 'fn_withdrawal_request', s, 120000);
  const sum = async () => count(`SELECT COALESCE(sum(amount),0)::int AS n FROM wallet_entries WHERE user_id = $1 AND kind = 'withdrawal'`, [s]);
  const before = await sum(); const proof = await makeProof(db, w.admin, 'withdrawal_payment');
  const res = await Promise.allSettled(Array.from({ length: 4 }, () => call(db.app, 'fn_admin_pay_withdrawal', w.admin, wd, 'REF-PAIEMENT-1', proof)));
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(res.map((r) => r.reason?.message)));
  assert.equal(before - await sum(), 120000);
});

// ---------------------------------------------------------------- garde-fou de paie
test('garde-fou : paie fixe supérieure aux frais = création refusée sur les trois parcours, sans commande ni stock réservé', async () => {
  const code = await call(db.app, 'fn_seller_create_link', w.seller, product);
  await setting('courier_share_bps', 0); await setting('courier_pay', 30000);                    // Kaloum = 25 000 : paie trop haute (état forcé par le propriétaire)
  const snap = async () => ({ orders: await count('SELECT count(*)::int AS n FROM orders'), reserved: await count('SELECT reserved_qty AS n FROM products WHERE id = $1', [product]),
    reqs: await count('SELECT count(*)::int AS n FROM order_requests'), msgs: await count('SELECT count(*)::int AS n FROM messages') });
  const before = await snap();
  await expectErr(create(w.seller, KEY(60)), 'courier_pay_exceeds_fee');
  await expectErr(call(db.app, 'fn_public_order_once', code, KEY(61), 1, 'Client Public', phone(), 'Kaloum', 'Rue 2', VER), 'courier_pay_exceeds_fee');
  await expectErr(call(db.app, 'fn_seller_import_order', w.seller, 'cd'.repeat(32), product, null, null, 1, 'Client Imp', phone(), 'Kaloum', 'Rue 8', null, false), 'courier_pay_exceeds_fee');
  assert.deepEqual(await snap(), before);
  const r = await new Client().post(`/api/public/link/${code}/order`, { qty: 1, name: 'Client Web', phone: phone(), commune: 'Kaloum', address: 'Rue 9 Kaloum', accepted: true, request_key: KEY(62) });
  assert.equal(r.status, 409); assert.match(r.json.message, /tarif de la zone est en cours de révision/); assert.doesNotMatch(r.json.message, /30\s?000/);
  await setting('courier_pay', 25000);                                                           // égalité : acceptée
  assert.ok((await create(w.seller, KEY(63))).id);
  await setting('courier_pay', 5000);
});

test('pourcentage : 7 500 et 9 000 acceptés sur toutes les zones actives ; paie = frais x pourcentage, fige à la création', async () => {
  for (const bps of [7500, 9000]) {
    await setting('courier_share_bps', bps);
    for (const z of (await db.owner.query('SELECT commune, fee FROM delivery_rates WHERE active ORDER BY commune')).rows) {
      const o = await create(w.seller, `prot-pct-${bps}-${z.commune.replace(/\W/g, '')}-0001`, { commune: z.commune });
      const row = (await db.owner.query('SELECT courier_pay, delivery_fee FROM orders WHERE id = $1', [o.id])).rows[0];
      assert.equal(Number(row.delivery_fee), Number(z.fee));
      assert.equal(Number(row.courier_pay), Math.floor((Number(z.fee) * bps + 5000) / 10000));
      assert.ok(Number(row.courier_pay) <= Number(row.delivery_fee));
    }
  }
  await setting('courier_share_bps', 0);
});

// ---------------------------------------------------------------- contrôles préventifs de l'administrateur
test('administrateur : zone à tarif nul, tarif sous la paie fixe, paie fixe trop haute, plafond de 90 %', async () => {
  await setting('courier_share_bps', 0); await setting('courier_pay', 5000);
  await expectErr(call(db.app, 'fn_admin_set_delivery_rate', w.admin, 'Zone Test', 0, true), 'invalid_input');                // tarif nul : activation refusée
  await call(db.app, 'fn_admin_set_delivery_rate', w.admin, 'Zone Test', 0, false);                                             // créée à 0 et désactivée : permis
  await expectErr(call(db.app, 'fn_admin_set_delivery_rate', w.admin, 'Zone Test', 4000, true), 'zone_fee_below_courier_pay');
  await expectErr(call(db.app, 'fn_admin_set_delivery_rate', w.admin, 'Kaloum', 4999, true), 'zone_fee_below_courier_pay');
  await call(db.app, 'fn_admin_set_delivery_rate', w.admin, 'Zone Test', 4000, false);                                          // désactivée : pas de contrôle
  await call(db.app, 'fn_admin_set_delivery_rate', w.admin, 'Zone Test', 5000, true);                                           // égal à la paie : accepté
  await expectErr(call(db.app, 'fn_admin_set_setting', w.admin, 'courier_pay', 5001), 'courier_pay_exceeds_fee');             // plus cher que la zone la moins chère
  await call(db.app, 'fn_admin_set_delivery_rate', w.admin, 'Zone Test', 5000, false);
  await call(db.app, 'fn_admin_set_setting', w.admin, 'courier_pay', 20000);                                                   // zones actives >= 25 000 : accepté
  await expectErr(call(db.app, 'fn_admin_set_setting', w.admin, 'courier_pay', 26000), 'courier_pay_exceeds_fee');
  await call(db.app, 'fn_admin_set_setting', w.admin, 'courier_pay', 5000);
  await expectErr(call(db.app, 'fn_admin_set_setting', w.admin, 'courier_share_bps', 9001), 'invalid_input');
  await expectErr(call(db.app, 'fn_admin_set_setting', w.admin, 'courier_share_bps', 10000), 'invalid_input');
  await call(db.app, 'fn_admin_set_setting', w.admin, 'courier_share_bps', 9000);                                              // plafond atteint : accepté
  await setting('courier_pay', 30000);                                                                                          // inutilisé en mode pourcentage : pas de contrôle
  await expectErr(call(db.app, 'fn_admin_set_setting', w.admin, 'courier_share_bps', 0), 'courier_pay_exceeds_fee');         // retour au fixe refusé
  await setting('courier_pay', 5000); await setting('courier_share_bps', 0);
  assert.equal(Number((await db.owner.query(`SELECT value FROM settings WHERE key = 'courier_share_bps'`)).rows[0].value), 0);   // le plafond n'est pas une valeur
  assert.match((await db.owner.query(`SELECT label FROM settings WHERE key = 'courier_share_bps'`)).rows[0].label, /maximum 9000/);
  assert.equal(await count('SELECT count(*)::int AS n FROM fn_ledger_check()'), 0);
});

// ---------------------------------------------------------------- consentement : pas de doublon au rejeu
const consentState = async () => (await db.owner.query(`SELECT count(*)::int AS n, COALESCE(md5(string_agg(c::text, ',' ORDER BY id)), '') AS h FROM consents c WHERE kind = 'order'`)).rows[0];
test('consentement : un seul par commande publique créée ; rejeu, refus et clé réutilisée n\'en ajoutent pas ; l\'existant est intact', async () => {
  const code = await call(db.app, 'fn_seller_create_link', w.seller, product);
  const anon = new Client(); const ph = phone();
  const body = { qty: 1, name: 'Client Consent', phone: ph, commune: 'Kaloum', address: 'Rue 11 Kaloum', accepted: true };
  const s0 = await consentState();
  assert.equal((await anon.post(`/api/public/link/${code}/order`, { ...body, request_key: KEY(70) })).status, 201);
  const s1 = await consentState(); assert.equal(s1.n, s0.n + 1);
  for (let i = 0; i < 3; i++) assert.equal((await anon.post(`/api/public/link/${code}/order`, { ...body, request_key: KEY(70) })).status, 200);   // rejeux
  assert.equal((await consentState()).h, s1.h);                                                          // ni ajout ni modification
  assert.equal((await anon.post(`/api/public/link/${code}/order`, { ...body, phone: phone(), request_key: KEY(70) })).status, 409);   // clé réutilisée
  assert.equal((await consentState()).h, s1.h);
  assert.equal((await anon.post(`/api/public/link/${code}/order`, { ...body, accepted: false, request_key: KEY(71) })).status, 400);       // case non cochée
  assert.equal((await consentState()).h, s1.h);
  srv.resetLimits(); const phPar = phone();
  const par = await Promise.all(Array.from({ length: 5 }, () => anon.post(`/api/public/link/${code}/order`, { ...body, phone: phPar, request_key: KEY(72), name: 'Client Parallele' })));
  assert.ok(par.every((r) => [200, 201, 409].includes(r.status)));
  assert.equal((await consentState()).n, s1.n + 1);                                                       // 5 envois simultanés : un consentement
  const h = (await db.owner.query(`SELECT subject_hash FROM consents WHERE kind = 'order' ORDER BY id DESC LIMIT 1`)).rows[0].subject_hash;
  assert.match(h, /^[0-9a-f]{64}$/); assert.ok(!h.includes(ph));                                          // empreinte, jamais le numéro
  await assert.rejects(db.owner.query(`UPDATE consents SET version = 'x' WHERE kind = 'order'`), /append|immuable|interdit|not allowed/i);   // toujours en ajout seul
});
test('consentement : un refus du garde-fou ou un lien inconnu n\'en laisse aucun', async () => {
  const code = await call(db.app, 'fn_seller_create_link', w.seller, product);
  const s0 = await consentState();
  await expectErr(call(db.app, 'fn_public_order_once', 'inconnu', KEY(73), 1, 'Client X', phone(), 'Kaloum', 'Rue 1', VER), 'not_found');
  await expectErr(call(db.app, 'fn_public_order_once', code, KEY(74), 1, 'Client X', phone(), 'Kaloum', 'Rue 1', null), 'invalid_input');   // version absente
  await setting('courier_share_bps', 0); await setting('courier_pay', 30000);
  await expectErr(call(db.app, 'fn_public_order_once', code, KEY(75), 1, 'Client X', phone(), 'Kaloum', 'Rue 1', VER), 'courier_pay_exceeds_fee');
  await setting('courier_pay', 5000);
  assert.deepEqual(await consentState(), s0);
});

// ---------------------------------------------------------------- journal des refus du garde-fou
let since = 0;                                                                                              // le journal est en ajout seul : on compte à partir d'un repère
const mark = async () => { since = Number((await db.owner.query('SELECT COALESCE(max(id), 0) AS m FROM audit_log')).rows[0].m); };
const refusals = async () => (await db.owner.query(`SELECT actor_id, entity, entity_id, details::text AS d FROM audit_log WHERE action = 'order_refused_pay_guard' AND id > $1 ORDER BY id`, [since])).rows;
test('journal du garde-fou : refus journalisé sur les trois parcours, sans la paie, sans doublon rapproché, sans effet financier', async (t) => {
  t.after(() => setting('courier_pay', 5000));
  const code = await call(db.app, 'fn_seller_create_link', w.seller, product);
  await mark();
  await setting('courier_share_bps', 0); await setting('courier_pay', 30000);                           // état forcé : Dixinn 25 000 < 30 000
  const fin = async () => (await db.owner.query(`SELECT (SELECT count(*) FROM wallet_entries)::text || (SELECT count(*) FROM orders) || (SELECT count(*) FROM order_requests) || (SELECT reserved_qty FROM products WHERE id = $1) AS x,
    (SELECT md5(string_agg(key || value::text, ',' ORDER BY key)) FROM settings) AS s, (SELECT md5(string_agg(commune || fee::text, ',' ORDER BY commune)) FROM delivery_rates) AS z`, [product])).rows[0];
  const before = await fin();
  const anon = new Client(); const login = new Client();
  const sp = (await db.owner.query('SELECT phone FROM users WHERE id = $1', [w.seller])).rows[0].phone;
  assert.equal((await login.post('/api/auth/login', { identifier: sp, password: PW })).status, 200);
  const pub = await anon.post(`/api/public/link/${code}/order`, { qty: 1, name: 'Client Web', phone: phone(), commune: 'Dixinn', address: 'Rue 9 Kaloum', accepted: true, request_key: KEY(80) });
  assert.equal(pub.status, 409); assert.equal(pub.json.error, 'courier_pay_exceeds_fee');
  const sel = await login.post('/api/seller/orders', { product_id: product, qty: 1, customer_name: 'Client Form', customer_phone: phone(), commune: 'Dixinn', address: 'Rue 5 Kaloum', request_key: KEY(81) });
  assert.equal(sel.status, 409);
  const csv = `nom,telephone,quartier,adresse,produit\nClient Imp,${phone()},Dixinn,Rue 8 Kaloum,Montre connectée\n`;
  const imp = await login.post('/api/seller/import', { csv }); assert.equal(imp.status, 200); assert.equal(imp.json.created, 0); assert.equal(imp.json.errors.length, 1);
  const rows = await refusals();
  assert.deepEqual(rows.map((r) => JSON.parse(r.d).source).sort(), ['import', 'lien', 'vendeur']);
  assert.ok(rows.every((r) => r.entity === 'delivery_rate' && r.entity_id === 'Dixinn'));
  assert.equal(rows.find((r) => JSON.parse(r.d).source === 'lien').actor_id, null);                       // client anonyme
  assert.equal(rows.find((r) => JSON.parse(r.d).source === 'vendeur').actor_id, w.seller);
  for (const r of rows) assert.doesNotMatch(r.d + r.entity_id, /30\s?000|25\s?000|\d{4,}/);               // ni paie, ni tarif, ni montant, ni numéro
  assert.doesNotMatch(JSON.stringify([pub.json, sel.json]), /30000|30\s000/);                              // pas non plus dans la réponse
  // même refus dans la minute : pas de ligne en plus
  await anon.post(`/api/public/link/${code}/order`, { qty: 1, name: 'Client Web', phone: phone(), commune: 'Dixinn', address: 'Rue 9 Kaloum', accepted: true, request_key: KEY(82) });
  assert.equal((await refusals()).length, 3);
  assert.deepEqual(await fin(), before);                                                                   // aucun écriture, commande, stock, réglage ni tarif modifié
});
test('journal du garde-fou : autres refus non journalisés ; appel direct borné ; l\'application n\'écrit pas dans le journal', async () => {
  await mark();
  const ph = phone(); await create(w.seller, KEY(90), { phone: ph });
  await expectErr(create(w.seller, KEY(91), { phone: ph }), 'duplicate_order');
  const anon = new Client();
  await anon.post(`/api/public/link/inconnu/order`, { qty: 1, name: 'Client', phone: phone(), commune: 'Kaloum', address: 'Rue 1 Kaloum', accepted: true, request_key: KEY(92) });
  assert.equal((await refusals()).length, 0);                                                              // seuls les refus du garde-fou sont journalisés
  await call(db.app, 'fn_audit_guard_refusal', null, 'autre', 'Kaloum');                                    // source inconnue : ignoré
  await call(db.app, 'fn_audit_guard_refusal', null, 'lien', 'Zone <script>inventée</script>');             // zone inconnue : aucun texte libre dans le journal
  await call(db.app, 'fn_audit_guard_refusal', w.supplier, 'vendeur', 'Kaloum');                            // acteur non vendeur : enregistré sans acteur
  const r = await refusals(); assert.equal(r.length, 1); assert.equal(r[0].actor_id, null);
  await assert.rejects(db.app.query(`INSERT INTO audit_log(action) VALUES ('x')`), /permission denied/);
  const f = (await db.owner.query(`SELECT prosecdef, proconfig::text AS c, has_function_privilege('wld_app', oid, 'EXECUTE') AS e FROM pg_proc WHERE proname = 'fn_audit_guard_refusal'`)).rows[0];
  assert.equal(f.prosecdef, true); assert.match(f.c, /search_path=public, pg_temp/); assert.equal(f.e, true);
});

// ---------------------------------------------------------------- droits
test('droits : l\'application ne lit ni n\'écrit order_requests ; propriétaire, sécurité et exécution des fonctions', async () => {
  for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES']) {
    assert.equal((await db.owner.query(`SELECT has_table_privilege('wld_app', 'order_requests', $1) AS p`, [priv])).rows[0].p, false, priv);
  }
  assert.equal((await db.owner.query(`SELECT has_any_column_privilege('wld_app', 'order_requests', 'SELECT') AS p`)).rows[0].p, false);
  await assert.rejects(db.app.query('SELECT * FROM order_requests'), /permission denied/);
  await assert.rejects(db.app.query(`INSERT INTO order_requests(scope, req_key, order_id, fingerprint) VALUES ('x', 'abcdefghijklmnop', gen_random_uuid(), 'x')`), /permission denied/);
  await assert.rejects(db.app.query(`DELETE FROM order_requests`), /permission denied/);
  const fns = (await db.owner.query(`SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig::text AS cfg,
      has_function_privilege('wld_app', p.oid, 'EXECUTE') AS app_exec, p.oid::regprocedure::text AS sig
    FROM pg_proc p WHERE p.proname IN ('fn_seller_create_order_once','fn_public_order_once','_request_key_ok','_orders_courier_guard','fn_seller_import_order',
      'fn_admin_reset_activity','fn_admin_set_delivery_rate','fn_admin_set_setting','fn_ledger_check') ORDER BY 1`)).rows;
  assert.equal(fns.length, 9);
  const me = (await db.owner.query('SELECT current_user AS u')).rows[0].u;
  for (const f of fns) {
    assert.equal(f.owner, me, f.proname);                                                      // propriétaire = rôle des migrations, jamais l'application
    assert.equal(f.prosecdef, true, `${f.proname} doit être SECURITY DEFINER`);
    assert.match(f.cfg, /search_path=public, pg_temp/, f.proname);
    assert.equal(f.app_exec, !f.proname.startsWith('_'), `${f.proname} : exécution par l'application`);
  }
  await assert.rejects(db.app.query(`SELECT _request_key_ok('abcdefghijklmnop')`), /permission denied/);
  await assert.rejects(db.app.query(`SELECT 1 FROM wallet_entries LIMIT 1 FOR UPDATE`), /permission denied/);
  const idx = (await db.owner.query(`SELECT indexname FROM pg_indexes WHERE indexname IN ('wallet_settle_once_uq','wallet_team_pay_once_uq')`)).rowCount;
  assert.equal(idx, 2);
});

// ---------------------------------------------------------------- rapport de production
test('rapport de production : 7 requêtes en lecture seule, valides, sans résultat anormal sur la base de test', async () => {
  const sql = fs.readFileSync(path.join(root, 'docs', 'rapport-production-017.sql'), 'utf8');
  const stmts = splitSql(sql);
  assert.equal(stmts.length, 7);
  assert.ok(stmts.every((s) => /^select/i.test(s)), 'uniquement des SELECT');
  assert.doesNotMatch(sql, /\b(insert|update|delete|truncate|drop|alter|create)\b\s/i);
  const rows = [];
  for (const s of stmts) rows.push((await db.owner.query(s)).rows);
  for (const i of [0, 1, 2, 3, 4]) assert.equal(rows[i].length, 0, `requête ${i + 1}`);
  assert.equal(rows[5].length, 1); assert.ok(rows[6].length > 0 && rows[6].every((r) => r.name >= '017'));   // les migrations suivantes (018…) s'ajoutent après
});

// ---------------------------------------------------------------- remise à zéro (à la fin : elle vide l'activité)
test('remise à zéro de l\'activité avec des clés enregistrées : réussit et vide aussi les clés', async () => {
  assert.ok(await count('SELECT count(*)::int AS n FROM order_requests') > 0);
  await call(db.app, 'fn_admin_reset_activity', w.admin, 'REINITIALISER');
  assert.equal(await count('SELECT count(*)::int AS n FROM order_requests'), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM orders'), 0);
});

// ---------------------------------------------------------------- migration et retour arrière sur une base à l'état 016
test('migration 017 puis retour arrière : données financières intactes, fonctions et droits restaurés, comportement antérieur retrouvé', async () => {
  const name = 'wld_protect_mig';
  const adm = new Pool({ ...TEST_DB, database: 'postgres' });
  await adm.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await adm.query(`CREATE DATABASE ${name}`); await adm.end();
  const ownerOpts = { ...TEST_DB, database: name };
  const owner = new Pool(ownerOpts);
  const dir = path.join(root, 'backend', 'migrations');
  await owner.query(`CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql') && x < '017').sort()) {                  // état de production actuel : jusqu'à 016
    await owner.tx(async (tx) => { for (const s of splitSql(fs.readFileSync(path.join(dir, f), 'utf8'))) await tx.query(s); await tx.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]); });
  }
  await owner.query(`UPDATE settings SET value = 1 WHERE key = 'require_delivery_code'`); await owner.query(`UPDATE settings SET value = 0 WHERE key = 'kyc_images_required'`);
  await owner.query(`ALTER ROLE wld_app LOGIN PASSWORD '${APP_PW}'`); await owner.query(`GRANT CONNECT ON DATABASE ${name} TO wld_app`);
  const app = new Pool({ ...ownerOpts, user: 'wld_app', password: APP_PW });
  const d = { owner, app }; const ww = await world(d); const prod = await approvedProduct(d, ww, { price: 60000, qty: 30 });
  await call(app, 'fn_seller_set_price', ww.seller, prod, 120000);
  const mk = (ph) => call(app, 'fn_seller_create_order', ww.seller, prod, null, null, 1, 'Client', ph, 'Kaloum', 'Rue 1', null, false);
  const o1 = await mk('620111111'); await deliver(d, ww, o1.id, o1.ref);
  const o2 = await mk('620222222'); await call(app, 'fn_staff_cancel_order', ww.chief, o2.id, 'Test annulation');
  await mk('620333333');

  const data = async () => (await owner.query(`SELECT
      (SELECT count(*) FROM wallet_entries)::text || '/' || (SELECT COALESCE(sum(amount),0) FROM wallet_entries)::text || '/' ||
      (SELECT md5(string_agg(w::text, ',' ORDER BY id)) FROM wallet_entries w) AS ecritures,
      (SELECT md5(string_agg((to_jsonb(o) - 'pickup_detail')::text, ',' ORDER BY id)) FROM orders o) AS commandes,
      (SELECT md5(string_agg(key || '=' || value::text, ',' ORDER BY key)) FROM settings WHERE key NOT IN ('mission_offer_minutes','mission_max_offers','courier_max_open','tour_bonus_per_extra_order')) AS valeurs,
      (SELECT md5(string_agg(commune || '=' || fee::text || active::text, ',' ORDER BY commune)) FROM delivery_rates) AS zones`)).rows[0];
  const funcs = async () => (await owner.query(`SELECT p.proname || ':' || md5(pg_get_functiondef(p.oid)) || ':' || p.prosecdef::text || ':' || COALESCE(p.proconfig::text, '') || ':' || COALESCE(p.proacl::text, '') AS f
      FROM pg_proc p WHERE p.proname IN ('fn_seller_import_order','fn_admin_reset_activity','fn_admin_set_delivery_rate','fn_admin_set_setting','fn_ledger_check','fn_seller_create_order','fn_public_order')
      ORDER BY 1`)).rows.map((r) => r.f);
  const tablePrivs = async () => (await owner.query(`SELECT string_agg(table_name || '.' || column_name, ',' ORDER BY table_name, column_name) AS g FROM information_schema.column_privileges WHERE grantee = 'wld_app' AND privilege_type = 'SELECT' AND table_name NOT IN ('courier_profiles','courier_zones')`)).rows[0].g;
  const labelOf = async () => (await owner.query(`SELECT label FROM settings WHERE key = 'courier_share_bps'`)).rows[0].label;

  const A = { data: await data(), funcs: await funcs(), privs: await tablePrivs(), label: await labelOf() };
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '017_protections.sql'`)).rows[0].n, 0);

  // 1) migration 017 par le lanceur normal
  await migrate(ownerOpts, APP_PW, () => {});
  const B = { data: await data() };
  assert.deepEqual(B.data.ecritures, A.data.ecritures); assert.equal(B.data.commandes, A.data.commandes);          // aucune écriture ni commande modifiée
  assert.equal(B.data.valeurs, A.data.valeurs); assert.equal(B.data.zones, A.data.zones);                           // aucune valeur de réglage, aucun tarif modifié
  assert.notEqual(await labelOf(), A.label);                                                                        // seul le texte de l'étiquette change
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '017_protections.sql'`)).rows[0].n, 1);
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM fn_ledger_check()`)).rows[0].n, 0);

  // 2) retour arrière (dans l'ordre inverse des migrations : 019, 018 — appliquées par migrate() — puis 017)
  for (const f of ['retour-arriere-025.sql', 'retour-arriere-024.sql', 'retour-arriere-023.sql', 'retour-arriere-022.sql', 'retour-arriere-021.sql', 'retour-arriere-020.sql', 'retour-arriere-019.sql', 'retour-arriere-018.sql', 'retour-arriere-017.sql']) {
    const rb = fs.readFileSync(path.join(root, 'docs', f), 'utf8');
    await owner.tx(async (tx) => { for (const s of splitSql(rb)) { if (/^(begin|commit)$/i.test(s.trim())) continue; await tx.query(s); } });
  }
  const C = { data: await data(), funcs: await funcs(), privs: await tablePrivs(), label: await labelOf() };
  assert.deepEqual(C.data, A.data);                                                                                  // données financières identiques à l'état d'avant
  assert.deepEqual(C.funcs, A.funcs);                                                                                // texte, sécurité, configuration et droits des fonctions identiques
  assert.equal(C.privs, A.privs);                                                                                    // droits de lecture identiques
  assert.equal(C.label, A.label);
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '017_protections.sql'`)).rows[0].n, 0);
  const gone = (await owner.query(`SELECT (SELECT count(*) FROM pg_class WHERE relname = 'order_requests') + (SELECT count(*) FROM pg_trigger WHERE tgname = 'orders_courier_guard')
      + (SELECT count(*) FROM pg_indexes WHERE indexname IN ('wallet_settle_once_uq','wallet_team_pay_once_uq')) + (SELECT count(*) FROM pg_proc WHERE proname IN ('fn_seller_create_order_once','fn_public_order_once','_request_key_ok','_orders_courier_guard')) AS n`)).rows[0].n;
  assert.equal(Number(gone), 0);
  // comportement antérieur : pourcentage 10 000 accepté, commande sans clé acceptée, import sans verrou, remise à zéro sans la table
  await call(app, 'fn_admin_set_setting', ww.admin, 'courier_share_bps', 10000);
  await call(app, 'fn_admin_set_setting', ww.admin, 'courier_share_bps', 0);
  assert.ok((await mk('620444444')).id);
  assert.equal((await call(app, 'fn_seller_import_order', ww.seller, 'ef'.repeat(32), prod, null, null, 1, 'Client Imp', '620555555', 'Kaloum', 'Rue 3', null, false)).ref !== undefined, true);
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM fn_ledger_check()`)).rows[0].n, 0);

  // 3) on peut réappliquer 017 ensuite (le cycle est rejouable)
  await migrate(ownerOpts, APP_PW, () => {});
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '017_protections.sql'`)).rows[0].n, 1);
  assert.equal((await owner.query(`SELECT has_table_privilege('wld_app', 'order_requests', 'SELECT') AS p`)).rows[0].p, false);
  await owner.end(); await app.end();
});

test('migration 017 : s\'arrête sans rien modifier si des écritures en double existent déjà', async () => {
  const name = 'wld_protect_dup';
  const adm = new Pool({ ...TEST_DB, database: 'postgres' });
  await adm.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await adm.query(`CREATE DATABASE ${name}`); await adm.end();
  const ownerOpts = { ...TEST_DB, database: name };
  const owner = new Pool(ownerOpts);
  const dir = path.join(root, 'backend', 'migrations');
  await owner.query(`CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql') && x < '017').sort()) {
    await owner.tx(async (tx) => { for (const s of splitSql(fs.readFileSync(path.join(dir, f), 'utf8'))) await tx.query(s); await tx.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]); });
  }
  await owner.query(`UPDATE settings SET value = 1 WHERE key = 'require_delivery_code'`); await owner.query(`UPDATE settings SET value = 0 WHERE key = 'kyc_images_required'`);
  await owner.query(`ALTER ROLE wld_app LOGIN PASSWORD '${APP_PW}'`);
  const d = { owner, app: new Pool({ ...ownerOpts, user: 'wld_app', password: APP_PW }) }; const ww = await world(d); const prod = await approvedProduct(d, ww, { price: 60000, qty: 10 });
  await call(d.app, 'fn_seller_set_price', ww.seller, prod, 120000);
  const o = await call(d.app, 'fn_seller_create_order', ww.seller, prod, null, null, 1, 'Client', '620666666', 'Kaloum', 'Rue 1', null, false);
  await deliver(d, ww, o.id, o.ref);
  await owner.query(`INSERT INTO wallet_entries(user_id, kind, amount, order_id) SELECT user_id, kind, amount, order_id FROM wallet_entries WHERE kind = 'seller_gain' LIMIT 1`);   // doublon fabriqué
  const before = (await owner.query('SELECT count(*)::int AS n FROM wallet_entries')).rows[0].n;
  await assert.rejects(migrate(ownerOpts, APP_PW, () => {}), /écritures en double/);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM wallet_entries')).rows[0].n, before);                              // aucune donnée touchée ni corrigée
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '017_protections.sql'`)).rows[0].n, 0);   // rien d'appliqué
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM pg_class WHERE relname = 'order_requests'`)).rows[0].n, 0);
  await owner.end(); await d.app.end();
});
