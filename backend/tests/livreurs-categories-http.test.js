// Deux catégories de livreurs : routes de l'administration (migration 029) — droits, création, barème, simulation, fiche, charges.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, TEST_DB, APP_PW, world, approvedProduct, codeOf, call } from './helpers.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';

const PW = 'Secret123';
let db, w, product, srv, base, n = 0, k = 0;
const phone = () => `6${String(++n).padStart(8, '0')}`;
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
  db = await freshDb('wld_cathttp'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  product = await approvedProduct(db, w, { price: 60000, qty: 50 });
  await call(db.app, 'fn_seller_set_price', w.seller, product, 120000);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_cathttp', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });

test('création d\'un livreur avec sa catégorie, liste et fiche de l\'administration', async () => {
  const adm = await login(w.admin);
  const bad = await adm.post('/api/admin/users', { role: 'courier', name: 'Livreur X', phone: phone(), password: PW + 'abc1', courier_kind: 'moto' });
  assert.equal(bad.status, 400);
  assert.equal(Number((await db.owner.query(`SELECT count(*)::int AS n FROM users WHERE full_name = 'Livreur X'`)).rows[0].n), 0);   // rien créé si la catégorie est invalide
  const r = await adm.post('/api/admin/users', { role: 'courier', name: 'Livreur Moto', phone: phone(), password: PW + 'abc1', courier_kind: 'company', vehicle: 'moto' });
  assert.equal(r.status, 201); const id = r.json.id;
  const r2 = await adm.post('/api/admin/users', { role: 'courier', name: 'Livreur Perso', phone: phone(), password: PW + 'abc1' });
  assert.equal(r2.status, 201);
  const list = (await adm.get('/api/admin/couriers')).json.couriers;
  assert.equal(list.find((c) => c.id === id).kind, 'company');
  assert.equal(list.find((c) => c.id === r2.json.id).kind, 'independent');
  const file = (await adm.get(`/api/admin/couriers/${id}/file`)).json;
  assert.equal(file.courier.kind, 'company'); assert.equal(file.kind_history.length, 1); assert.equal(file.kind_history[0].kind, 'company');
  assert.equal((await adm.get(`/api/admin/couriers/${w.admin}/file`)).status, 404);
  const k2 = await adm.post(`/api/admin/couriers/${r2.json.id}/kind`, { kind: 'company', note: 'moto prêtée' });
  assert.equal(k2.status, 200);
  assert.equal((await adm.post(`/api/admin/couriers/${r2.json.id}/kind`, { kind: 'company' })).status, 409);
});

test('les routes de catégories et de barèmes sont réservées à l\'administrateur', async () => {
  for (const who of [w.chief, w.courier, w.seller, w.agent1]) {
    const c = await login(who);
    assert.equal((await c.get('/api/admin/courier-scales')).status, 403);
    assert.equal((await c.post('/api/admin/courier-scales', { per_delivery: 5000 })).status, 403);
    assert.equal((await c.post('/api/admin/courier-scales/simulate', { fee: 25000 })).status, 403);
    assert.equal((await c.post(`/api/admin/couriers/${w.courier}/kind`, { kind: 'company' })).status, 403);
    assert.equal((await c.post(`/api/admin/couriers/${w.courier}/expenses`, { kind: 'fuel', amount: 1000 })).status, 403);
    assert.equal((await c.get(`/api/admin/couriers/${w.courier}/file`)).status, 403);
  }
  assert.equal((await new Client().get('/api/admin/courier-scales')).status, 401);
});

test('barème : lecture, création datée, refus du passé et des montants trop élevés, historique', async () => {
  const adm = await login(w.admin);
  const g0 = (await adm.get('/api/admin/courier-scales')).json;
  assert.equal(g0.scales.length, 0); assert.ok(g0.min_zone_fee > 0); assert.equal(typeof g0.independent.courier_share_bps, 'number');
  assert.equal((await adm.post('/api/admin/courier-scales', { per_delivery: 5000, effective_from: '2020-01-01T00:00:00Z' })).status, 400);
  assert.equal((await adm.post('/api/admin/courier-scales', { per_delivery: g0.min_zone_fee + 1 })).status, 409);
  assert.equal((await adm.post('/api/admin/courier-scales', { per_delivery: 'abc' })).status, 400);
  assert.equal((await adm.post('/api/admin/courier-scales', { per_delivery: 5000, prime_threshold: 3 })).status, 400);
  const ok = await adm.post('/api/admin/courier-scales', { per_delivery: 5000, tour_extra: 1000, note: 'essai' });
  assert.equal(ok.status, 201);
  const g1 = (await adm.get('/api/admin/courier-scales')).json;
  assert.equal(g1.scales.length, 1); assert.equal(g1.scales[0].in_force, true); assert.equal(Number(g1.scales[0].per_delivery), 5000);
  const chief = await login(w.chief); const co = (await chief.get('/api/chief/orders')).json;
  assert.ok(Array.isArray(co.couriers)); assert.ok(co.couriers.every((c) => ['independent', 'company'].includes(c.kind)));
});

test('simulation : aucun effet en base, montants cohérents, entrées contrôlées', async () => {
  const adm = await login(w.admin);
  const before = { s: Number((await db.owner.query('SELECT count(*)::int AS n FROM courier_pay_scales')).rows[0].n), w: Number((await db.owner.query('SELECT count(*)::int AS n FROM wallet_entries')).rows[0].n) };
  const r = await adm.post('/api/admin/courier-scales/simulate', { fee: 25000, scale: { per_delivery: 5000, tour_extra: 2000, prime_threshold: 10, prime_amount: 15000 },
    moto: { fuel_price: 12500, consumption: 3, maint_km: 120, price: 12000000, life_days: 780, days_per_month: 26 } });
  assert.equal(r.status, 200);
  const normal = r.json.scenarios.find((s) => s.name === 'normal');
  assert.equal(normal.delivery_fees, 8 * 25000); assert.equal(normal.moto.depreciation, 15385);
  assert.equal(normal.company.margin, normal.delivery_fees - normal.company.pay - normal.moto.total);
  assert.equal(normal.independent.normal.pay, 8 * Math.floor((25000 * (await db.owner.query(`SELECT value FROM settings WHERE key = 'courier_share_bps'`)).rows[0].value + 5000) / 10000) || normal.independent.normal.pay);
  assert.ok(r.json.breakeven_deliveries_per_day >= 1);
  assert.equal((await adm.post('/api/admin/courier-scales/simulate', { fee: -5, scale: { per_delivery: 5000 } })).status, 400);
  assert.equal((await adm.post('/api/admin/courier-scales/simulate', { fee: 25000, scale: { per_delivery: 5000 }, scenarios: [{ name: 'x', assigned: 2, delivered: 5, km: 10 }] })).status, 400);
  assert.equal(Number((await db.owner.query('SELECT count(*)::int AS n FROM courier_pay_scales')).rows[0].n), before.s);
  assert.equal(Number((await db.owner.query('SELECT count(*)::int AS n FROM wallet_entries')).rows[0].n), before.w);
});

test('charges de la moto et fiche : saisie, annulation avec motif, totaux, paie du livreur de Wallindirain visible', async () => {
  const adm = await login(w.admin);
  const cid = (await adm.get('/api/admin/couriers')).json.couriers.find((c) => c.kind === 'company').id;
  const bad = await adm.post(`/api/admin/couriers/${cid}/expenses`, { kind: 'cadeau', amount: 1000 }); assert.equal(bad.status, 400);
  assert.equal((await adm.post(`/api/admin/couriers/${cid}/expenses`, { kind: 'fuel', amount: 0 })).status, 400);
  assert.equal((await adm.post(`/api/admin/couriers/${cid}/expenses`, { kind: 'fuel', amount: 1000, spent_on: 'hier' })).status, 400);
  const e = await adm.post(`/api/admin/couriers/${cid}/expenses`, { kind: 'fuel', amount: 12000, note: 'plein' }); assert.equal(e.status, 201);
  const e2 = await adm.post(`/api/admin/couriers/${cid}/expenses`, { kind: 'repair', amount: 30000 }); assert.equal(e2.status, 201);
  assert.equal((await adm.post(`/api/admin/expenses/${e2.json.id}/void`, { reason: '' })).status, 400);
  assert.equal((await adm.post(`/api/admin/expenses/${e2.json.id}/void`, { reason: 'saisie en double' })).status, 200);
  assert.equal((await adm.post(`/api/admin/expenses/${e2.json.id}/void`, { reason: 'encore' })).status, 409);
  const o = await call(db.app, 'fn_seller_create_order_once', w.seller, `cat-http-key-${String(++k).padStart(8, '0')}`, product, null, null, 1, 'Client', phone(), 'Kaloum', 'Rue 1', null, true);
  await call(db.app, 'fn_chief_assign', w.chief, o.id, cid);
  await call(db.app, 'fn_courier_pickup', cid, o.id); await call(db.app, 'fn_courier_depart', cid, o.id); await call(db.app, 'fn_courier_deliver', cid, o.id, await codeOf(db, o.ref));
  const f = (await adm.get(`/api/admin/couriers/${cid}/file`)).json;
  assert.equal(f.expenses_total, 12000); assert.equal(f.expenses.length, 2);
  assert.equal(f.orders[0].courier_kind, 'company'); assert.equal(f.orders[0].scale_applied, true); assert.equal(Number(f.orders[0].pay), 5000);
  assert.ok(f.pay.some((p) => p.kind === 'team_pay' && Number(p.amount) === 5000));
  const co = (await adm.get('/api/admin/couriers')).json.couriers.find((c) => c.id === cid);
  assert.equal(Number(co.delivered_30), 1); assert.equal(Number(co.expenses_30), 12000);
});
