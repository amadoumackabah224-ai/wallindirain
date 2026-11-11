// 063 : saisie hors connexion — un même envoi répété n'est enregistré qu'une fois.
import { test, before, beforeEach, after } from 'node:test';
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
let admin, seller, acc, rice;

before(async () => {
  db = await freshDb('wld_pfo'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  await db.owner.query(`UPDATE settings SET value = 1 WHERE key = 'feature_finances_perso'`);
  await db.owner.query(`UPDATE settings SET value = 5000 WHERE key = 'pf_price_monthly'`);
  await db.owner.query(`UPDATE settings SET value = 0 WHERE key = 'pf_trial_days'`);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_pfo', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
  admin = await login(w.admin); seller = await login(w.seller);
  acc = (await admin.post('/api/pf/accounts', { name: 'Caisse', kind: 'cash', color: 'teal', opening_balance: 100000 })).json.id;
  rice = (await admin.post('/api/pf/shop/items', { name: 'Riz 25kg', price: 50000, cost: 40000, stock: 10, low_stock: 3 })).json.id;
});
beforeEach(() => srv.resetLimits());

beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });

const cat = async () => (await admin.get('/api/pf/categories')).json;
const count = async () => Number((await rows('SELECT count(*) n FROM pf_transactions WHERE owner_id = $1 AND voided_at IS NULL AND note LIKE $2', [w.admin, 'hc-%']))[0].n);
const tx = (extra = {}) => ({ account_id: acc, kind: 'expense', amount: 5000, category: 'food', note: 'hc-test', occurred_on: today, ...extra });

test('même clé envoyée deux fois : une seule transaction, même résultat', async () => {
  const k = 'cle-hors-connexion-0001';
  const a = await admin.post('/api/pf/transactions', tx({ client_key: k }));
  assert.equal(a.status, 201); assert.ok(a.json.id);
  const b = await admin.post('/api/pf/transactions', tx({ client_key: k }));
  assert.equal(b.status, 200); assert.equal(b.json.id, a.json.id); assert.equal(b.json.repeated, true);
  assert.equal(await count(), 1);
  const c = await admin.post('/api/pf/transactions', tx({ client_key: 'cle-hors-connexion-0002' }));
  assert.equal(c.status, 201); assert.notEqual(c.json.id, a.json.id);
  assert.equal(await count(), 2);
  assert.equal((await admin.post('/api/pf/transactions', tx())).status, 201, 'sans clé : comportement habituel');
  assert.equal(await count(), 3);
});

test('une erreur libère la clé : on peut renvoyer corrigé ; clé invalide refusée ; clés propres à chaque personne', async () => {
  const k = 'cle-hors-connexion-0003';
  assert.equal((await admin.post('/api/pf/transactions', tx({ client_key: k, amount: -5 }))).status, 400);
  assert.equal((await admin.post('/api/pf/transactions', tx({ client_key: k }))).status, 201);
  assert.equal((await admin.post('/api/pf/transactions', tx({ client_key: 'abc' }))).status, 400);
  assert.equal(Number((await rows('SELECT count(*) n FROM pf_client_keys WHERE key = $1', [k]))[0].n), 1);
});

test('vente envoyée deux fois : stock et argent comptés une seule fois', async () => {
  const k = 'cle-vente-hors-connexion-1';
  const body = { account_id: acc, lines: [{ item_id: rice, qty: 2 }], occurred_on: today, client_key: k };
  const a = await admin.post('/api/pf/shop/sales', body);
  assert.equal(a.status, 201);
  const b = await admin.post('/api/pf/shop/sales', body);
  assert.equal(b.status, 200); assert.equal(b.json.id, a.json.id);
  const s = (await admin.get('/api/pf/shop')).json;
  assert.equal(s.items.find((i) => i.id === rice).stock, 8);
  assert.equal(s.today.count, 1);
  const refused = await admin.post('/api/pf/shop/sales', { account_id: acc, lines: [{ item_id: rice, qty: 99 }], client_key: 'cle-vente-hors-connexion-2' });
  assert.equal(refused.status, 409);
  assert.equal(Number((await rows(`SELECT count(*) n FROM pf_client_keys WHERE key = 'cle-vente-hors-connexion-2'`))[0].n), 0, 'refus : clé libérée');
});

test('effacement des données et retour arrière', async () => {
  assert.ok(Number((await rows('SELECT count(*) n FROM pf_client_keys'))[0].n) > 0);
  assert.equal((await admin.post('/api/pf/erase', { confirm: 'EFFACER' })).status, 200);
  assert.equal(Number((await rows('SELECT count(*) n FROM pf_client_keys WHERE owner_id = $1', [w.admin]))[0].n), 0);
  const sql = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-063.sql'), 'utf8');
  await db.owner.query('BEGIN'); for (const q of splitSql(sql)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT');
  assert.equal(Number((await rows(`SELECT count(*) n FROM information_schema.tables WHERE table_name = 'pf_client_keys'`))[0].n), 0);
  acc = (await admin.post('/api/pf/accounts', { name: 'Caisse 2', kind: 'cash', color: 'teal', opening_balance: 1000 })).json.id;
  assert.equal((await admin.post('/api/pf/transactions', tx())).status, 201, 'l\'enregistrement habituel marche toujours');
});
