// 038 : canal d'origine des commandes (fonction éteinte par défaut).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshDb, TEST_DB, APP_PW, world, approvedProduct, call } from './helpers.js';
import { splitSql } from '../src/migrate.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';

const PW = 'Secret123';
const root = path.resolve(import.meta.dirname, '..', '..');
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
const setFlag = (v) => db.owner.query(`UPDATE settings SET value = $1 WHERE key = 'feature_order_channel'`, [v]);
let n = 0;
const order = (extra = {}) => ({ request_key: `k${String(++n).padStart(3, '0')}`.padEnd(20, 'x'), qty: 1, customer_name: 'Client Test', customer_phone: '621000001', commune: 'Ratoma', address: 'Rue 1, près du marché', product_id: product, ...extra });

before(async () => {
  db = await freshDb('wld_canal'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  product = await approvedProduct(db, w, { price: 60000, qty: 50 });
  await call(db.app, 'fn_seller_set_price', w.seller, product, 120000);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_canal', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });

test('éteint par défaut : le canal est ignoré et la commande est créée comme avant', async () => {
  assert.equal(Number((await db.owner.query(`SELECT value FROM settings WHERE key = 'feature_order_channel'`)).rows[0].value), 0);
  const info = (await new Client().get('/api/public/info')).json;
  assert.equal(info.features.order_channel, false);
  const s = await login(w.seller);
  const r = await s.post('/api/seller/orders', order({ channel: 'facebook' }));
  assert.equal(r.status, 201);
  assert.equal((await db.owner.query('SELECT channel FROM orders WHERE id = $1', [r.json.id])).rows[0].channel, null);
  assert.equal((await s.post(`/api/seller/orders/${r.json.id}/channel`, { channel: 'tiktok' })).status, 404);
  assert.equal((await s.get('/api/seller/stats?days=30')).json.by_channel, null);
});

test('allumé : le canal est enregistré, filtré et compté ; un autre vendeur ne peut pas le changer', async () => {
  await setFlag(1);
  assert.equal((await new Client().get('/api/public/info')).json.features.order_channel, true);
  const s = await login(w.seller);
  const a = await s.post('/api/seller/orders', order({ channel: 'whatsapp', customer_phone: '621000010' }));
  const b = await s.post('/api/seller/orders', order({ channel: 'facebook', customer_phone: '621000002' }));
  const c = await s.post('/api/seller/orders', order({ customer_phone: '621000003' }));
  for (const x of [a, b, c]) assert.equal(x.status, 201);
  const list = (await s.get('/api/seller/orders')).json.orders;
  assert.equal(list.find((o) => o.id === a.json.id).channel, 'whatsapp');
  assert.equal(list.find((o) => o.id === c.json.id).channel, null);
  const onlyFb = (await s.get('/api/seller/orders?channel=facebook')).json.orders;
  assert.deepEqual(onlyFb.map((o) => o.id), [b.json.id]);
  assert.equal((await s.post(`/api/seller/orders/${c.json.id}/channel`, { channel: 'tiktok' })).status, 200);
  const by = (await s.get('/api/seller/stats?days=30')).json.by_channel;
  assert.equal(by.find((x) => x.channel === 'tiktok').total, 1);
  assert.equal(by.find((x) => x.channel === 'whatsapp').total, 1);
  assert.equal((await s.post('/api/seller/orders', order({ channel: 'telegram', customer_phone: '621000004' }))).status, 400);
  assert.equal((await s.post(`/api/seller/orders/${a.json.id}/channel`, { channel: 'inconnu' })).status, 400);
  // un autre vendeur ne peut pas modifier cette commande ; la base le refuse aussi
  await assert.rejects(() => call(db.app, 'fn_seller_set_channel', w.seller2 ?? w.agent, a.json.id, 'site'));
  // les montants n'ont pas bougé
  const o = (await db.owner.query('SELECT sale_total, delivery_fee FROM orders WHERE id = $1', [a.json.id])).rows[0];
  assert.equal(Number(o.sale_total), 120000);
});

test('retour arrière : refusé si des canaux sont enregistrés, accepté sinon', async () => {
  const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-038.sql'), 'utf8');
  const run = async () => { await db.owner.query('BEGIN'); try { for (const q of splitSql(rb)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT'); } catch (e) { await db.owner.query('ROLLBACK'); throw e; } };
  await assert.rejects(run, /canal enregistré/);
  await db.owner.query('UPDATE orders SET channel = NULL');
  await run();
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'channel'`)).rows[0].n, 0);
});
