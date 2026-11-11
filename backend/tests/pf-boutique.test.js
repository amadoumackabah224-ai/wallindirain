// 061 : boutique — produits et stock, vente rapide, annulation, clôture de caisse, marges.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshDb, TEST_DB, APP_PW, world } from './helpers.js';
import { splitSql } from '../src/migrate.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';

const PW = 'Secret123';
const root = path.resolve(import.meta.dirname, '..', '..');
let db, w, srv, base;
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
const rows = async (sql, p) => (await db.owner.query(sql, p)).rows;
const login = async (id) => { const c = new Client(); const ph = (await rows('SELECT phone FROM users WHERE id = $1', [id]))[0].phone; assert.equal((await c.post('/api/auth/login', { identifier: ph, password: PW })).status, 200); return c; };
const today = new Date().toISOString().slice(0, 10);
const month = today.slice(0, 7);
let admin, seller, acc, rice, oil;

before(async () => {
  db = await freshDb('wld_pfb'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  await db.owner.query(`UPDATE settings SET value = 1 WHERE key = 'feature_finances_perso'`);
  await db.owner.query(`UPDATE settings SET value = 5000 WHERE key = 'pf_price_monthly'`);
  await db.owner.query(`UPDATE settings SET value = 0 WHERE key = 'pf_trial_days'`);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_pfb', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
  admin = await login(w.admin); seller = await login(w.seller);
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });


const total = async (id) => (await admin.get('/api/pf/accounts')).json.accounts.find((a) => a.id === id).balance;

test('réservé à la formule Pro ; l\'administrateur y a droit', async () => {
  assert.equal((await seller.post('/api/pf/shop/items', { name: 'Riz', price: 1000 })).status, 403);
  assert.equal((await seller.post('/api/pf/shop/sales', { account_id: '00000000-0000-4000-8000-000000000000', lines: [] })).status, 400);
  acc = (await admin.post('/api/pf/accounts', { name: 'Caisse', kind: 'cash', color: 'teal', opening_balance: 100000 })).json.id;
  rice = (await admin.post('/api/pf/shop/items', { name: 'Riz 25kg', price: 50000, cost: 40000, stock: 10, low_stock: 3 })).json.id;
  oil = (await admin.post('/api/pf/shop/items', { name: 'Huile', price: 15000, cost: 12000 })).json.id;
  assert.ok(rice && oil);
  assert.equal((await admin.post('/api/pf/shop/items', { name: 'X', price: 10 })).status, 400);
  assert.equal((await admin.post('/api/pf/shop/items', { name: 'Zéro', price: 0 })).status, 400);
});

test('vente : total, stock qui baisse, transaction de revenu, stock insuffisant refusé', async () => {
  const r = await admin.post('/api/pf/shop/sales', { account_id: acc, lines: [{ item_id: rice, qty: 2 }, { item_id: oil, qty: 3 }] });
  assert.equal(r.status, 201); assert.equal(r.json.total, 2 * 50000 + 3 * 15000);
  let s = (await admin.get('/api/pf/shop')).json;
  assert.equal(s.items.find((i) => i.id === rice).stock, 8);
  assert.equal(s.items.find((i) => i.id === oil).stock, null, 'stock non suivi : reste vide');
  assert.deepEqual([s.today.count, s.today.total, s.today.margin], [1, 145000, 145000 - (2 * 40000 + 3 * 12000)]);
  assert.equal(await total(acc), 100000 + 145000);
  const tx = await rows(`SELECT category, kind, note FROM pf_transactions WHERE owner_id = $1 AND voided_at IS NULL`, [w.admin]);
  assert.deepEqual([tx[0].category, tx[0].kind], ['sales_product', 'income']); assert.match(tx[0].note, /2× Riz 25kg/);
  const bad = await admin.post('/api/pf/shop/sales', { account_id: acc, lines: [{ item_id: rice, qty: 9 }] });
  assert.equal(bad.status, 409); assert.match(bad.json.message, /Stock insuffisant/);
  assert.equal((await admin.post('/api/pf/shop/sales', { account_id: acc, lines: [{ item_id: rice, qty: 1 }, { item_id: rice, qty: 1 }] })).status, 400, 'doublon de produit');
  assert.equal((await admin.post('/api/pf/shop/sales', { account_id: acc, lines: [{ item_id: rice, qty: 0 }] })).status, 400);
  assert.equal((await admin.post('/api/pf/shop/sales', { account_id: acc, lines: [{ item_id: '00000000-0000-4000-8000-000000000000', qty: 1 }] })).status, 404);
  assert.equal((await seller.post('/api/pf/shop/sales', { account_id: acc, lines: [{ item_id: rice, qty: 1 }] })).status, 403);
  s = (await admin.get('/api/pf/shop')).json; assert.equal(s.items.find((i) => i.id === rice).stock, 8, 'rien n\'a changé après les refus');
});

test('annuler une vente remet le stock et le solde ; réapprovisionnement ; alerte de stock bas', async () => {
  const sale = (await admin.get('/api/pf/shop')).json.sales[0].id;
  assert.equal((await admin.post(`/api/pf/shop/sales/${sale}/void`)).status, 200);
  let s = (await admin.get('/api/pf/shop')).json;
  assert.equal(s.items.find((i) => i.id === rice).stock, 10); assert.equal(s.today.count, 0); assert.equal(await total(acc), 100000);
  assert.equal((await admin.post(`/api/pf/shop/sales/${sale}/void`)).status, 404);
  await admin.post('/api/pf/shop/sales', { account_id: acc, lines: [{ item_id: rice, qty: 8 }] });
  assert.equal((await admin.get('/api/pf/shop')).json.low_stock, 1, 'il reste 2 ≤ seuil 3');
  assert.equal((await admin.post(`/api/pf/shop/items/${rice}/restock`, { qty: 5, unit_cost: 41000, account_id: acc })).status, 200);
  s = (await admin.get('/api/pf/shop')).json; const r = s.items.find((i) => i.id === rice);
  assert.deepEqual([r.stock, r.cost], [7, 41000]); assert.equal(s.low_stock, 0);
  const exp = await rows(`SELECT amount::int a, category FROM pf_transactions WHERE owner_id = $1 AND kind = 'expense' AND voided_at IS NULL`, [w.admin]);
  assert.deepEqual([exp[0].a, exp[0].category], [5 * 41000, 'goods']);
  assert.equal((await admin.post(`/api/pf/shop/items/${rice}/restock`, { qty: 0 })).status, 400);
  const m = (await admin.get('/api/pf/shop/margins?days=30')).json.products;
  assert.equal(m[0].name, 'Riz 25kg'); assert.equal(m[0].margin, 8 * (50000 - 40000));
});

test('clôture de caisse : attendu, compté, écart ; refaire le même jour remplace', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const exp = await total(acc);
  const r = await admin.post('/api/pf/shop/close', { account_id: acc, counted: exp - 2000, note: 'monnaie rendue' });
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.deepEqual([r.json.expected, r.json.diff], [exp, -2000]);
  assert.equal((await admin.post('/api/pf/shop/close', { account_id: acc, counted: exp })).json.diff, 0);
  const l = (await admin.get('/api/pf/shop/closes')).json.closes;
  assert.equal(l.length, 1); assert.deepEqual([l[0].day, l[0].diff], [today, 0]);
  assert.equal((await admin.post('/api/pf/shop/close', { account_id: acc, counted: -1 })).status, 400);
  assert.equal((await admin.post('/api/pf/shop/close', { account_id: acc, day: '2999-01-01', counted: 1 })).status, 400);
  assert.equal((await seller.post('/api/pf/shop/close', { account_id: acc, counted: 1 })).status, 403);
});

test('effacement des données et retour arrière', async () => {
  const sql = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-061.sql'), 'utf8');
  await assert.rejects(async () => { for (const st of splitSql(sql)) await db.owner.query(st); });
  assert.equal((await admin.post('/api/pf/erase', { confirm: 'EFFACER' })).status, 200);
  for (const t of ['pf_items', 'pf_sales', 'pf_cash_close']) assert.equal((await rows(`SELECT count(*)::int n FROM ${t} WHERE owner_id = $1`, [w.admin]))[0].n, 0, t);
  for (const st of splitSql(sql)) await db.owner.query(st);
  assert.equal((await rows(`SELECT count(*)::int n FROM pg_proc WHERE proname = 'fn_pf_sale_add'`))[0].n, 0);
});
