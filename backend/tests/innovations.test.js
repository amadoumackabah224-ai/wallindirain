// Suivi client, parrainage (comptabilité), tableaux de bord vendeur et administrateur, alertes de fiabilité du client.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, TEST_DB, APP_PW, call, expectErr, world, approvedProduct, deliver } from './helpers.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';

let db, w, prod, srv, base, zone;
const PW = 'Secret123';
let n = 0;
const ph = () => `66${String(4000000 + ++n)}`;

class Client {
  constructor() { this.cookie = ''; }
  async req(method, path, body) {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}), ...(method !== 'GET' ? { 'x-wld': '1' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    for (const c of res.headers.getSetCookie?.() ?? []) { const kv = c.split(';')[0]; this.cookie = kv.endsWith('=') ? '' : kv; }
    let json = null; try { json = await res.json(); } catch { /* vide */ }
    return { status: res.status, json };
  }
  get(p) { return this.req('GET', p); }
  post(p, b = {}) { return this.req('POST', p, b); }
}
const phoneOf = async (id) => (await db.owner.query('SELECT phone FROM users WHERE id = $1', [id])).rows[0].phone;
const loginAs = async (id) => { const c = new Client(); const r = await c.post('/api/auth/login', { identifier: await phoneOf(id), password: PW }); assert.equal(r.status, 200); return c; };
const order = async (seller, customerPhone = ph()) => call(db.app, 'fn_seller_create_order', seller, prod, null, 150000, 1, 'Client Test', customerPhone, zone, 'Rue 1', null, false);
const balance = async (id) => Number((await db.owner.query('SELECT COALESCE(sum(amount),0) AS s FROM wallet_entries WHERE user_id = $1', [id])).rows[0].s);

beforeEach(() => srv.resetLimits());
before(async () => {
  db = await freshDb('wld_innov'); w = await world(db); prod = await approvedProduct(db, w, { qty: 100 });
  zone = (await db.owner.query(`SELECT commune FROM delivery_rates WHERE active LIMIT 1`)).rows[0].commune;
  await call(db.app, 'fn_seller_set_price', w.seller, prod, 150000);
  await call(db.app, 'fn_seller_set_price', w.seller2, prod, 150000);
  await db.owner.query(`UPDATE users SET password_hash = $1 WHERE id = ANY($2)`, [await hashPassword(PW), [w.admin, w.seller, w.seller2]]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-19' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_innov', user: 'wld_app', password: APP_PW, max: 5 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });

test('suivi client : lien secret, étapes, aucune donnée personnelle', async () => {
  const o = await order(w.seller);
  const token = (await db.owner.query('SELECT track_token FROM orders WHERE id = $1', [o.id])).rows[0].track_token;
  assert.match(token, /^[0-9a-f]{20}$/);
  const anon = new Client();
  let r = await anon.get(`/api/public/track/${token}`);
  assert.equal(r.status, 200); assert.equal(r.json.ref, o.ref); assert.equal(r.json.step, 'received'); assert.equal(r.json.qty, 1);
  const flat = JSON.stringify(r.json);
  for (const secret of ['Client Test', 'Rue 1', 'Vendeur Un', 'Fournisseur']) assert.ok(!flat.includes(secret), `fuite : ${secret}`);
  await call(db.app, 'fn_agent_take_order', w.agent1, o.id);
  await call(db.app, 'fn_agent_log_call', w.agent1, o.id, 'confirmed', 'OK');
  assert.equal((await anon.get(`/api/public/track/${token}`)).json.step, 'confirmed');
  assert.equal((await anon.get('/api/public/track/0123456789abcdef0123')).status, 404);
  assert.equal((await anon.get('/api/public/track/pas-un-jeton')).status, 404);
  // la commande publique renvoie le lien de suivi
  const link = await call(db.app, 'fn_seller_create_link', w.seller, prod);
  const pub = await anon.post(`/api/public/link/${link}/order`, { qty: 1, name: 'Client Web', phone: ph(), commune: zone, address: 'Rue 9', accepted: true, request_key: 'innov-test-key-0000001' });
  assert.equal(pub.status, 201); assert.match(pub.json.track_token, /^[0-9a-f]{20}$/);
});

test('fiabilité du client : le vendeur voit l\'alerte, jamais le motif', async () => {
  const bad = ph();
  await db.owner.query(`INSERT INTO risky_customers(customer_phone, incidents, last_reason) VALUES ($1, 2, 'Refus à la livraison')`, [bad]);
  const o = await order(w.seller, bad);
  const s = await loginAs(w.seller);
  const list = (await s.get('/api/seller/orders')).json.orders;
  const mine = list.find((x) => x.id === o.id);
  assert.equal(mine.risk_flag, true); assert.equal(mine.risk_incidents, 2);
  assert.ok(!JSON.stringify(list).includes('Refus à la livraison'));
  assert.equal(list.find((x) => x.risk_flag === false)?.risk_incidents ?? null, null);
});

test('parrainage : désactivé par défaut, bonus unique, écriture double, conservation', async () => {
  const set = (k, v) => call(db.app, 'fn_admin_set_setting', w.admin, k, v);
  const total = async () => Number((await db.owner.query('SELECT COALESCE(sum(amount),0) AS s FROM wallet_entries')).rows[0].s);
  const code = (await call(db.app, 'fn_my_referral', w.seller)).code;
  assert.match(code, /^[0-9A-F]{7}$/);
  // inscription d'un filleul via l'API, avec un mauvais puis le bon code
  const anon = new Client();
  const body = (extra) => ({ role: 'seller', name: 'Filleul Un', phone: ph(), password: PW, accept_terms: true, payout_method: 'orange_money', ...extra });
  const bad = await anon.post('/api/auth/register', body({ referral_code: 'ZZZZZZZ' }));
  assert.equal(bad.status, 201); assert.equal(bad.json.referral_applied, false);
  const reg = body({ referral_code: code.toLowerCase() });
  const ok = await anon.post('/api/auth/register', reg);
  assert.equal(ok.json.referral_applied, true);
  const filleul = ok.json.id;
  await call(db.app, 'fn_seller_set_price', filleul, prod, 150000);
  const before = await total();
  // parrainage désactivé (bonus 0) : rien n'est versé
  for (let i = 0; i < 2; i++) { const o = await call(db.app, 'fn_seller_create_order', filleul, prod, null, 150000, 1, 'Client C', ph(), zone, 'Rue du Test', null, false); await deliver(db, w, o.id, o.ref); }
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM wallet_entries WHERE kind = 'referral_bonus'`)).rows[0].n, 0);
  await set('referral_bonus', 20000); await set('referral_orders_required', 3);
  const parrainBefore = await balance(w.seller); const platBefore = await balance('00000000-0000-0000-0000-000000000001');
  for (let i = 0; i < 4; i++) { const o = await call(db.app, 'fn_seller_create_order', filleul, prod, null, 150000, 1, 'Client C', ph(), zone, 'Rue du Test', null, false); await deliver(db, w, o.id, o.ref); }
  assert.equal(await balance(w.seller) - parrainBefore, 20000);                         // versé UNE seule fois
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM wallet_entries WHERE kind = 'referral_bonus' AND user_id = $1`, [w.seller])).rows[0].n, 1);
  const ref = await call(db.app, 'fn_my_referral', w.seller);
  assert.equal(ref.referred, 1); assert.equal(ref.paid, 1); assert.equal(Number(ref.earned), 20000);
  // la plateforme est débitée du même montant : le total des portefeuilles ne bouge que par les livraisons
  assert.equal(Number((await db.owner.query(`SELECT COALESCE(sum(amount),0) AS s FROM wallet_entries WHERE kind = 'referral_bonus'`)).rows[0].s), 0);
  assert.ok(await balance('00000000-0000-0000-0000-000000000001') !== platBefore);
  assert.equal((await db.owner.query('SELECT * FROM fn_ledger_check()')).rows.length, 0);
  assert.ok(before !== undefined);
  // on ne peut pas se parrainer soi-même
  assert.equal((await call(db.app, 'fn_register_referral', w.seller, code)), false);
  // le fournisseur n'a pas de parrainage client : seuls vendeurs et fournisseurs ont un code
  await expectErr(call(db.app, 'fn_my_referral', w.courier), 'forbidden');
});

test('tableau de bord vendeur et statistiques administrateur', async () => {
  { const o = await order(w.seller); await deliver(db, w, o.id, o.ref); await order(w.seller); }
  const s = await loginAs(w.seller);
  const st = (await s.get('/api/seller/stats?days=90')).json;
  assert.ok(st.total >= 3); assert.ok(st.delivered >= 1);
  assert.equal(typeof st.delivery_rate, 'number'); assert.ok(Array.isArray(st.weeks)); assert.ok(st.products.length >= 1);
  assert.ok((await s.get('/api/seller/stats?days=abc')).json.days === 30);        // valeur inconnue : 30 jours
  assert.equal((await s.get('/api/admin/stats')).status, 403);
  assert.equal((await new Client().get('/api/seller/stats')).status, 401);
  const a = await loginAs(w.admin);
  const ad = (await a.get('/api/admin/stats?days=365')).json;
  assert.ok(ad.totals.delivered >= 1); assert.ok(ad.products.length >= 1); assert.ok(Array.isArray(ad.call_centers)); assert.ok(ad.couriers.length >= 1);
  assert.equal(ad.call_centers[0].name, 'Alpha');
  const other = await loginAs(w.seller2);
  assert.equal((await other.get('/api/seller/stats')).json.delivered, 0);          // un vendeur ne voit que ses propres chiffres
});
