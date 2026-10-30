// 037 : comptes de vendeurs de l'étranger (numéro international, versement manuel).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, TEST_DB, APP_PW, world, approvedProduct, call, deliver } from './helpers.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';

const PW = 'Secret123';
let db, w, product, srv, base;
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
const login = async (id) => { const c = new Client(); const ph = (await db.owner.query('SELECT phone FROM users WHERE id = $1', [id])).rows[0].phone; assert.equal((await c.post('/api/auth/login', { identifier: ph, password: PW })).status, 200); return c; };

before(async () => {
  db = await freshDb('wld_etrangerhttp'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  product = await approvedProduct(db, w, { price: 60000, qty: 50 });
  await call(db.app, 'fn_seller_set_price', w.seller, product, 120000);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_etrangerhttp', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });



const PWD = 'Secret123';
test('vendeur de l\'étranger : inscription, validation par l\'administration, connexion avec le numéro international', async () => {
  const c = new Client(); const adm = await login(w.admin);
  const reg = (b) => { srv.resetLimits(); return c.post('/api/auth/register', { role: 'seller', name: 'Awa Diop', password: PWD, accept_terms: true, ...b }); };
  // numéros étrangers : vendeurs seulement ; format international obligatoire
  srv.resetLimits();
  assert.equal((await c.post('/api/auth/register', { role: 'supplier', name: 'Four Nisseur', phone: '+33612345678', password: PWD, accept_terms: true, payout_method: 'other', payout_phone: 'Wave Sénégal 771234567' })).status, 400);
  assert.equal((await reg({ phone: '+3361', payout_method: 'other', payout_phone: 'Wave Sénégal 771234567' })).status, 400);
  assert.equal((await reg({ phone: '+33612345678', payout_method: 'other', payout_phone: 'ab' })).status, 400);              // coordonnées trop courtes
  assert.equal((await reg({ phone: '+33612345678', payout_method: 'orange_money' })).status, 400);                          // numéro guinéen obligatoire pour Orange / MTN
  const r = await reg({ phone: '0033612345678', payout_method: 'other', payout_phone: 'Wave Sénégal 771234567' });
  assert.equal(r.status, 201, JSON.stringify(r.json)); assert.equal(r.json.pending_validation, true);
  assert.equal((await reg({ phone: '+33 6 12 34 56 78', payout_method: 'other', payout_phone: 'Autre' + '1234' })).status, 409);   // déjà inscrit (même numéro normalisé)
  const phone = '+33612345678';
  assert.equal((await c.post('/api/auth/login', { phone, password: PWD })).status, 403);                                       // en attente
  await call(db.app, 'fn_admin_set_user_status', w.admin, r.json.id, 'active');
  const s = new Client(); assert.equal((await s.post('/api/auth/login', { phone, password: PWD })).status, 200);
  const me = (await s.get('/api/wallet')).json;
  assert.equal(me.foreign, true); assert.equal(me.payout.method, 'other'); assert.equal(me.payout.phone, 'Wave Sénégal 771234567');
  // +224… = numéro guinéen : normalisé sur 9 chiffres, compte actif tout de suite
  const g = await reg({ phone: '+224 621 00 00 99', payout_method: 'orange_money' });
  assert.equal(g.status, 201); assert.equal(g.json.pending_validation, false);
  assert.equal((await db.owner.query('SELECT phone FROM users WHERE id = $1', [g.json.id])).rows[0].phone, '621000099');
  // un client reste guinéen : une commande ne prend pas de numéro étranger
  const sel = await login(w.seller);
  assert.equal((await sel.post('/api/seller/orders', { request_key: 'k'.repeat(20), qty: 1, customer_name: 'Client', customer_phone: '+33612345679', commune: 'Ratoma', address: 'Rue 1', product_id: product })).status, 400);
  // demande de données avec un numéro étranger
  assert.equal((await c.post('/api/public/data-request', { kind: 'access', name: 'Awa Diop', phone })).status, 201);
});

test('retrait d\'un compte étranger : coordonnées écrites, payé à la main par l\'administrateur', async () => {
  const adm = await login(w.admin);
  const id = (await db.owner.query(`SELECT id FROM users WHERE phone = '+33612345678'`)).rows[0].id;
  await db.owner.query(`UPDATE users SET identity_verified = true WHERE id = $1`, [id]);
  await call(db.app, 'fn_admin_deposit', w.admin, id, 300000, 'DEP-ETR');
  const s = new Client(); await s.post('/api/auth/login', { phone: '+33612345678', password: PWD });
  const wd = await s.post('/api/withdrawals', { amount: 100000 });
  assert.ok([200, 201].includes(wd.status), JSON.stringify(wd.json));
  const list = (await adm.get('/api/admin/withdrawals')).json.withdrawals;
  const row = list.find((x) => x.method === 'other');
  assert.ok(row); assert.equal(row.account_number, 'Wave Sénégal 771234567');
  // changement des coordonnées : mot de passe demandé, mode « autre » accepté pour un compte étranger seulement
  assert.equal((await s.post('/api/me/payout/change', { method: 'other', phone: 'Orange Côte d\'Ivoire 0701020304', password: 'faux' })).status, 403);
  const guinean = await login(w.seller);
  assert.equal((await guinean.post('/api/me/payout/change', { method: 'other', phone: 'Wave Sénégal 771234567', password: PWD })).status, 400);
});
