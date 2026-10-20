// Frais de plateforme, part du livreur, zones, commande déjà confirmée, abonnement, import Google Sheet.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, call, expectErr, world, approvedProduct, deliver, codeOf, TEST_DB, APP_PW } from './helpers.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';
import { parseSheetUrl, parseCsv, mapRows, phone9 } from '../src/sheets.js';

let db, w, prod, srv, base;
const PW = 'Secret123';
let n = 0;
const ph = () => `64${String(2000000 + ++n)}`;
const set = (k, v) => call(db.app, 'fn_admin_set_setting', w.admin, k, v);
const mk = (price = 150000, over = {}) => call(db.app, 'fn_seller_create_order', w.seller, prod, null, price, over.qty ?? 1, 'Client Test', ph(), over.zone ?? 'Ratoma', 'Rue 1', null, over.pre ?? false);
const sum = async (u, kind) => Number((await db.owner.query(`SELECT COALESCE(sum(amount),0)::bigint s FROM wallet_entries WHERE user_id=$1 ${kind ? 'AND kind=$2' : ''}`, kind ? [u, kind] : [u])).rows[0].s);
const platform = '00000000-0000-0000-0000-000000000001';

class Client {
  constructor() { this.cookie = ''; }
  async req(method, path, body) {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}), ...(method !== 'GET' ? { 'x-wld': '1' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie?.() ?? []) { const kv = c.split(';')[0]; this.cookie = kv.endsWith('=') ? '' : kv; }
    let json = null; try { json = await res.json(); } catch { /* vide */ }
    return { status: res.status, json };
  }
  get(p) { return this.req('GET', p); }
  post(p, b = {}) { return this.req('POST', p, b); }
  async login(phone) { const r = await this.post('/api/auth/login', { phone, password: PW }); assert.equal(r.status, 200, JSON.stringify(r.json)); return this; }
}

before(async () => {
  db = await freshDb('wld_fees');
  w = await world(db);
  prod = await approvedProduct(db, w, { qty: 50 });
  await call(db.app, 'fn_seller_set_price', w.seller, prod, 150000);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  await db.owner.query(`UPDATE users SET identity_verified = true`);
  await call(db.app, 'fn_admin_set_setting', w.admin, 'unlock_hours', 0);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-19' }, trustProxy: false,
    db: { ...TEST_DB, database: 'wld_fees', user: 'wld_app', password: APP_PW, max: 5 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });
beforeEach(() => srv.resetLimits());

test('frais de plateforme : % par commande + montant par produit, prélevés au vendeur, figés à la création', async () => {
  const base0 = await mk();                                       // sans frais : gain habituel de 46 000
  await deliver(db, w, base0.id, base0.ref);
  assert.equal(await sum(w.seller, 'seller_gain'), 46000);
  await set('fee_order_bps', 500); await set('fee_unit', 2000);    // 5 % de 300 000 = 15 000 + 2 × 2 000 = 19 000
  const o = await mk(150000, { qty: 2 });
  assert.equal(Number((await db.owner.query('SELECT platform_fee FROM orders WHERE id=$1', [o.id])).rows[0].platform_fee), 19000);
  await set('fee_order_bps', 0); await set('fee_unit', 0);          // un changement ultérieur ne touche pas la commande déjà créée
  const gainBefore = await sum(w.seller, 'seller_gain'), revBefore = await sum(platform, 'platform_revenue');
  await deliver(db, w, o.id, o.ref);
  assert.equal(await sum(w.seller, 'seller_gain') - gainBefore, 300000 - 30000 - 5000 - 138000 - 19000);
  assert.equal(await sum(platform, 'platform_revenue') - revBefore, 30000 + 5000 + 19000 + 18000);   // livraison + call + frais + marge 2 × 9 000
  assert.equal((await db.app.query('SELECT count(*)::int n FROM fn_ledger_check()')).rows[0].n, 0);
  await expectErr(set('fee_order_bps', 10001), 'invalid_input');
  await set('fee_order_bps', 1000);
  await expectErr(mk(60000), 'price_below_minimum');                // les frais comptent dans le prix minimum
  await set('fee_order_bps', 0);
});

test('part du livreur : pourcentage des frais de livraison, le reste revient à Wallindirain', async () => {
  const fixed = await mk();
  assert.equal(Number((await db.owner.query('SELECT courier_pay FROM orders WHERE id=$1', [fixed.id])).rows[0].courier_pay), 5000);   // montant fixe par défaut
  await set('courier_share_bps', 8000);
  const o = await mk();                                              // livraison Ratoma 30 000 → livreur 24 000
  assert.equal(Number((await db.owner.query('SELECT courier_pay FROM orders WHERE id=$1', [o.id])).rows[0].courier_pay), 24000);
  const before = await sum(w.courier, 'team_pay');
  await deliver(db, w, o.id, o.ref);
  assert.equal(await sum(w.courier, 'team_pay') - before, 24000);
  await set('courier_share_bps', 0);
});

test('zones : quartier ou ville, zone désactivée refusée, « Autre quartier / ville » disponible', async () => {
  const zones = (await db.owner.query(`SELECT commune FROM delivery_rates WHERE active`)).rows.map((r) => r.commune);
  assert.ok(zones.includes('Autre quartier / ville'));
  await call(db.app, 'fn_admin_set_delivery_rate', w.admin, 'Kipé', 28000, true);
  assert.ok((await mk(150000, { zone: 'Kipé' })).id);
  await call(db.app, 'fn_admin_set_delivery_rate', w.admin, 'Kipé', 28000, false);
  await expectErr(mk(150000, { zone: 'Kipé' }), 'invalid_input');
  const o = await mk(150000, { zone: 'Autre quartier / ville' });
  assert.ok(o.id);
});

test('commande déjà confirmée par le vendeur : sans call center, directement affectable', async () => {
  const before = await sum(w.seller, 'seller_gain');
  const o = await mk(150000, { pre: true });
  assert.equal(o.status, 'confirmed');
  const row = (await db.owner.query('SELECT status, call_fee, agent_pay, confirmed_by FROM orders WHERE id=$1', [o.id])).rows[0];
  assert.equal(Number(row.call_fee), 0); assert.equal(Number(row.agent_pay), 0); assert.equal(row.confirmed_by, w.seller);
  assert.equal((await db.owner.query(`SELECT count(*)::int n FROM calls WHERE order_id=$1`, [o.id])).rows[0].n, 0);
  assert.ok((await db.owner.query(`SELECT 1 FROM messages WHERE order_id=$1`, [o.id])).rowCount === 1);   // le client est prévenu
  // le chef l'affecte directement, le livreur livre ; pas de rémunération d'agent
  await call(db.app, 'fn_chief_assign', w.chief, o.id, w.courier);
  await call(db.app, 'fn_courier_pickup', w.courier, o.id); await call(db.app, 'fn_courier_depart', w.courier, o.id);
  const agentBefore = await sum(w.agent1, 'team_pay');
  await call(db.app, 'fn_courier_deliver', w.courier, o.id, await codeOf(db, o.ref));
  assert.equal(await sum(w.agent1, 'team_pay'), agentBefore);
  assert.equal(await sum(w.seller, 'seller_gain') - before, 150000 - 30000 - 0 - 69000);   // pas de frais de call center
  // le vendeur peut annuler sa propre commande confirmée tant qu'elle n'est pas ramassée
  const o2 = await mk(150000, { pre: true });
  await call(db.app, 'fn_seller_cancel_order', w.seller, o2.id);
  assert.equal((await db.owner.query('SELECT status FROM orders WHERE id=$1', [o2.id])).rows[0].status, 'cancelled');
  // jamais pour une commande de lien public
  await expectErr(call(db.owner, '_create_order', w.seller, prod, null, null, 1, 'X Y', ph(), 'Ratoma', 'Rue', null, 'public_link', null, true), 'invalid_input');
  assert.equal((await db.app.query('SELECT count(*)::int n FROM fn_ledger_check()')).rows[0].n, 0);
});

test('abonnement : essai gratuit, blocage à l\'expiration, encaissement par portefeuille ou hors plateforme', async () => {
  await set('subscription_monthly', 50000); await set('subscription_required', 1); await set('subscription_trial_days', 30);
  assert.ok((await mk()).id);                                          // dans la période d'essai
  await set('subscription_trial_days', 0);
  await expectErr(mk(), 'subscription_required');
  await call(db.app, 'fn_admin_charge_subscription', w.admin, w.seller, 1, 'external', 'Orange Money réf. 123');
  assert.ok((await mk()).id);                                          // abonné
  await expectErr(call(db.app, 'fn_admin_charge_subscription', w.admin, w.seller, 1, 'external', ''), 'invalid_input');
  const bal = await sum(w.seller), plat = await sum(platform, 'subscription');
  await call(db.app, 'fn_admin_charge_subscription', w.admin, w.seller, 2, 'wallet');
  assert.equal(await sum(w.seller), bal - 100000); assert.equal(await sum(platform, 'subscription') - plat, 100000);
  await expectErr(call(db.app, 'fn_admin_charge_subscription', w.admin, w.seller2, 1, 'wallet'), 'insufficient_funds');
  await set('subscription_required', 0);
});

test('import : lignes du tableau → commandes, doublons ignorés, erreurs ligne par ligne', async () => {
  const s = await new Client().login((await db.owner.query('SELECT phone FROM users WHERE id=$1', [w.seller])).rows[0].phone);
  const csv = [
    'Nom;Téléphone;Quartier ou ville;Adresse;Produit;Quantité;Prix;Confirmé',
    `Aïssatou Diallo;+224 ${ph()};Ratoma;Kipé près de la pharmacie;Montre connectée;1;150000;oui`,
    `Mamadou Sow;${ph()};Quartier inconnu;Rue 5;Montre connectée;1;150000;non`,
    `Fatou Camara;${ph()};Kaloum;Marché;Sac en cuir;1;80000;`,
    `Sans Téléphone;abc;Kaloum;Marché;Montre connectée;1;150000;`,
    `Produit Inconnu;${ph()};Kaloum;Marché;Chose rare;1;;`
  ].join('\n');
  const r1 = await s.post('/api/seller/import', { csv });
  assert.equal(r1.status, 200, JSON.stringify(r1.json));
  assert.equal(r1.json.created, 3); assert.equal(r1.json.errors.length, 2);
  assert.deepEqual(r1.json.errors.map((e) => e.line), [5, 6]);
  const orders = (await db.owner.query(`SELECT status, commune, address, own_product_name FROM orders WHERE customer_name IN ('Aïssatou Diallo','Mamadou Sow','Fatou Camara') ORDER BY customer_name`)).rows;
  assert.equal(orders.find((o) => o.address.includes('Kipé')).status, 'confirmed');                    // « oui » : saute le call center
  assert.equal(orders.find((o) => o.commune === 'Autre quartier / ville').address, 'Quartier inconnu, Rue 5');
  assert.equal(orders.find((o) => o.own_product_name === 'Sac en cuir').own_product_name, 'Sac en cuir');
  const r2 = await s.post('/api/seller/import', { csv });                                              // même fichier : rien de plus
  assert.equal(r2.json.created, 0); assert.equal(r2.json.duplicates, 3);
  assert.equal((await s.post('/api/seller/import', { csv: 'a,b\n1,2' })).status, 400);                 // colonnes manquantes
  assert.equal((await s.post('/api/seller/import', {})).status, 400);                                  // pas de lien enregistré
  assert.equal((await new Client().post('/api/seller/import', { csv })).status, 401);
  const other = await new Client().login((await db.owner.query('SELECT phone FROM users WHERE id=$1', [w.supplier])).rows[0].phone);
  assert.equal((await other.post('/api/seller/import', { csv })).status, 403);                         // réservé aux vendeurs
});

test('Google Sheet : seul un lien docs.google.com est accepté ; CSV et colonnes lus correctement', async () => {
  const ok = parseSheetUrl('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit?gid=42#gid=42');
  assert.deepEqual(ok, { id: '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', gid: '42' });
  for (const bad of ['http://169.254.169.254/latest', 'https://evil.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', 'https://docs.google.com.evil.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', 'javascript:alert(1)', '']) {
    assert.throws(() => parseSheetUrl(bad), /Collez le lien/);
  }
  assert.deepEqual(parseCsv('a,b\n"x, y","il dit ""oui"""\n'), [['a', 'b'], ['x, y', 'il dit "oui"']]);
  const rows = mapRows(parseCsv('Nom,Tel,Ville,Adresse,Article\nA B,620000001,Kaloum,Rue 1,Montre'));
  assert.equal(rows[0].phone, '620000001'); assert.equal(rows[0].zone, 'Kaloum');
  assert.equal(phone9('+224 620 00 00 01'), '620000001');
  const s = await new Client().login((await db.owner.query('SELECT phone FROM users WHERE id=$1', [w.seller])).rows[0].phone);
  assert.equal((await s.post('/api/seller/sheet', { url: 'http://localhost:5432/x' })).status, 400);
  assert.equal((await s.post('/api/seller/sheet', { url: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit' })).status, 200);
  assert.match((await s.get('/api/seller/sheet')).json.sheet.url, /1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/);
});
