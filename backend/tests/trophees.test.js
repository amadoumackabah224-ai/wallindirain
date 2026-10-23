// Trophées et classement mensuel des vendeurs.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, TEST_DB, APP_PW, call, expectErr, world, approvedProduct, deliver } from './helpers.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';

let db, w, prod, srv, base, zone;
const PW = 'Secret123';
let n = 0;
const ph = () => `66${String(6000000 + ++n)}`;

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
  db = await freshDb('wld_trophy'); w = await world(db); prod = await approvedProduct(db, w, { qty: 100 });
  zone = (await db.owner.query(`SELECT commune FROM delivery_rates WHERE active LIMIT 1`)).rows[0].commune;
  await call(db.app, 'fn_seller_set_price', w.seller, prod, 150000);
  await call(db.app, 'fn_seller_set_price', w.seller2, prod, 150000);
  await db.owner.query(`UPDATE users SET password_hash = $1 WHERE id = ANY($2)`, [await hashPassword(PW), [w.admin, w.seller, w.seller2]]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-19' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_trophy', user: 'wld_app', password: APP_PW, max: 5 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });


const setSetting = (k, v) => db.owner.query('UPDATE settings SET value = $2 WHERE key = $1', [k, v]);

test('trophées : seuils sur les ventes livrées, classement sans montants des autres', async () => {
  await setSetting('trophy_bronze', 150000); await setSetting('trophy_silver', 450000); await setSetting('trophy_gold', 900000);
  const s = await loginAs(w.seller);
  const first = await s.get('/api/seller/ranking'); let r = first.json;
  assert.equal(r.tier, 'none'); assert.equal(r.rank, null); assert.equal(r.next_tier, 'bronze');
  for (let i = 0; i < 2; i++) { const o = await order(w.seller); await deliver(db, w, o.id, o.ref); }
  const pending = await order(w.seller);                                   // non livrée : ne compte pas
  const o2 = await order(w.seller2); await deliver(db, w, o2.id, o2.ref);
  r = (await s.get('/api/seller/ranking')).json;
  assert.equal(Number(r.lifetime), 300000); assert.equal(r.tier, 'bronze'); assert.equal(r.next_tier, 'silver');
  assert.equal(r.rank, 1); assert.equal(r.participants, 2); assert.equal(r.my_delivered, 2);
  assert.equal(r.top.length, 2); assert.equal(r.top[0].me, true); assert.equal(r.top[1].me, false);
  // les autres ne voient ni montants, ni nom complet, ni téléphone
  const flat = JSON.stringify(r.top);
  assert.ok(!/sales|amount|phone|gain/i.test(Object.keys(r.top[0]).join()));
  assert.ok(!flat.includes(await phoneOf(w.seller2)));
  assert.ok(pending.id);
  for (let i = 0; i < 4; i++) { const o = await order(w.seller); await deliver(db, w, o.id, o.ref); }
  r = (await s.get('/api/seller/ranking')).json;
  assert.equal(r.tier, 'gold'); assert.equal(r.next_tier, null);
});

test('trophées : retrait du classement, droits et mois', async () => {
  const s = await loginAs(w.seller);
  assert.equal((await s.post('/api/seller/ranking-visibility', { hidden: true })).status, 200);
  let r = (await s.get('/api/seller/ranking')).json;
  assert.equal(r.hidden, true); assert.equal(r.rank, null);
  assert.ok(r.top.every((t) => !t.me));                                       // masqué : absent du classement pour tous
  const other = (await (await loginAs(w.seller2)).get('/api/seller/ranking')).json;
  assert.equal(other.top.length, 1);
  assert.equal((await s.post('/api/seller/ranking-visibility', { hidden: false })).status, 200);
  assert.equal((await s.get('/api/seller/ranking')).json.hidden, false);
  // une commande livrée le mois dernier ne compte pas dans le classement du mois
  await db.owner.query('ALTER TABLE orders DISABLE TRIGGER USER');
  await db.owner.query(`UPDATE orders SET delivered_at = now() - interval '45 days' WHERE seller_id = $1 AND status = 'delivered'`, [w.seller2]);
  await db.owner.query('ALTER TABLE orders ENABLE TRIGGER USER');
  assert.equal((await (await loginAs(w.seller2)).get('/api/seller/ranking')).json.rank, null);
  // réservé aux vendeurs
  const a = await loginAs(w.admin);
  assert.equal((await a.get('/api/seller/ranking')).status, 403);
  assert.equal((await a.post('/api/seller/ranking-visibility', { hidden: true })).status, 403);
  assert.equal((await new Client().get('/api/seller/ranking')).status, 401);
});
