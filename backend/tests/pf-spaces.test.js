// 057 : espaces de groupe (rôles, isolation, lecture seule si le propriétaire n'est plus Pro, journal, retour arrière).
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
const login = async (id) => { const c = new Client(); const ph = (await db.owner.query('SELECT phone FROM users WHERE id = $1', [id])).rows[0].phone; assert.equal((await c.post('/api/auth/login', { identifier: ph, password: PW })).status, 200); return c; };
const rows = async (sql, p) => (await db.owner.query(sql, p)).rows;
const today = new Date().toISOString().slice(0, 10);
const setPrice = (m) => db.owner.query(`UPDATE settings SET value = $1 WHERE key = 'pf_price_monthly'`, [m]);
const phoneOf = async (id) => (await rows('SELECT phone FROM users WHERE id = $1', [id]))[0].phone;
let owner, acct, contrib, viewer, outsider, sid, a1, a2;

before(async () => {
  db = await freshDb('wld_pfs'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_pfs', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
  owner = await login(w.seller); acct = await login(w.seller2); contrib = await login(w.courier); viewer = await login(w.supplier);
  outsider = await login(w.admin);
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });

test('éteint : rien ; allumé mais formule gratuite : création refusée (pro_required)', async () => {
  assert.equal((await owner.get('/api/pf/spaces')).json.enabled, false);
  await db.owner.query(`UPDATE settings SET value = 1 WHERE key = 'feature_finances_perso'`);
  await db.owner.query(`UPDATE settings SET value = 0 WHERE key = 'pf_trial_days'`);
  await setPrice(5000);
  assert.equal((await owner.get('/api/pf/spaces')).json.spaces_enabled, false);
  assert.equal((await owner.post('/api/pf/spaces', { name: 'Boutique' })).status, 403);
  await db.owner.query(`UPDATE settings SET value = 1 WHERE key = 'pf_spaces'`);
  const r = await owner.post('/api/pf/spaces', { name: 'Boutique' });
  assert.equal(r.status, 403); assert.equal(r.json.error, 'pro_required');
  assert.equal((await owner.get('/api/pf/spaces')).json.can_create, false);
});

test('Pro : création, limite, invitations par téléphone, acceptation', async () => {
  await setPrice(0); // tout le monde est Pro quand la formule est gratuite
  assert.equal((await owner.post('/api/pf/spaces', { name: 'x' })).status, 400);
  const r = await owner.post('/api/pf/spaces', { name: 'Boutique Kaloum' });
  assert.equal(r.status, 201); sid = r.json.id;
  const inv = async (c, id, role) => c.post(`/api/pf/spaces/${sid}/invite`, { phone: await phoneOf(id), role });
  assert.equal((await inv(owner, w.seller2, 'accountant')).status, 200);
  assert.equal((await inv(owner, w.courier, 'contributor')).status, 200);
  assert.equal((await inv(owner, w.supplier, 'viewer')).status, 200);
  assert.equal((await owner.post(`/api/pf/spaces/${sid}/invite`, { phone: '699999999', role: 'viewer' })).status, 404, 'inconnu');
  assert.equal((await owner.post(`/api/pf/spaces/${sid}/invite`, { phone: await phoneOf(w.courier), role: 'owner' })).status, 400);
  assert.equal((await outsider.post(`/api/pf/spaces/${sid}/invite`, { phone: await phoneOf(w.warehouse ?? w.agent), role: 'viewer' })).status, 404);
  const list = (await acct.get('/api/pf/spaces')).json;
  assert.equal(list.invitations.length, 1); assert.equal(list.spaces.length, 0);
  assert.equal((await acct.get(`/api/pf/spaces/${sid}`)).status, 404, 'pas encore membre');
  for (const c of [acct, contrib, viewer]) assert.equal((await c.post(`/api/pf/spaces/${sid}/respond`, { accept: true })).status, 200);
  assert.equal((await acct.get('/api/pf/spaces')).json.spaces[0].role, 'accountant');
  for (let i = 0; i < 2; i++) assert.equal((await owner.post('/api/pf/spaces', { name: `E${i}` })).status, 201);
  assert.equal((await owner.post('/api/pf/spaces', { name: 'E4' })).json.error, 'limit');
});

test('rôles : propriétaire/comptable/contributeur écrivent, lecteur lit ; non-membre ne voit rien', async () => {
  a1 = (await owner.post(`/api/pf/spaces/${sid}/accounts`, { name: 'Caisse', kind: 'cash', color: 'teal', opening_balance: 100000 })).json.id;
  a2 = (await acct.post(`/api/pf/spaces/${sid}/accounts`, { name: 'Orange Money', kind: 'mobile_money', color: 'orange', opening_balance: 0 })).json.id;
  assert.ok(a1 && a2);
  assert.equal((await contrib.post(`/api/pf/spaces/${sid}/accounts`, { name: 'X', kind: 'cash', color: 'teal' })).status, 403);
  const t = { account_id: a1, kind: 'expense', amount: 20000, category: 'food', occurred_on: today };
  assert.equal((await viewer.post(`/api/pf/spaces/${sid}/transactions`, t)).status, 403);
  assert.equal((await outsider.post(`/api/pf/spaces/${sid}/transactions`, t)).status, 404);
  assert.equal((await outsider.get(`/api/pf/spaces/${sid}`)).status, 404);
  const own = await owner.post(`/api/pf/spaces/${sid}/transactions`, { ...t, amount: 30000 });
  const mine = await contrib.post(`/api/pf/spaces/${sid}/transactions`, { ...t, amount: 10000 });
  assert.equal(own.status, 201); assert.equal(mine.status, 201);
  assert.equal((await contrib.post(`/api/pf/spaces/${sid}/transactions/${own.json.id}/void`)).status, 403, 'le contributeur ne touche pas aux écritures des autres');
  assert.equal((await contrib.post(`/api/pf/spaces/${sid}/transactions/${mine.json.id}`, { ...t, amount: 11000 })).status, 200);
  assert.equal((await acct.post(`/api/pf/spaces/${sid}/transactions/${own.json.id}/void`)).status, 200, 'le comptable corrige tout');
  assert.equal((await owner.post(`/api/pf/spaces/${sid}/transactions`, { ...t, category: 'nimporte' })).status, 400);
  assert.equal((await owner.post(`/api/pf/spaces/${sid}/transfers`, { from: a1, to: a2, amount: 5000, occurred_on: today })).status, 201);
  const d = (await viewer.get(`/api/pf/spaces/${sid}`)).json;
  assert.equal(d.role, 'viewer'); assert.equal(d.can_write, false);
  assert.equal(d.accounts.find((a) => a.id === a1).balance, 100000 - 11000 - 5000);
  assert.equal(d.accounts.find((a) => a.id === a2).balance, 5000);
  assert.equal(d.expense, 11000); assert.deepEqual(d.log, [], 'journal réservé');
  assert.ok((await acct.get(`/api/pf/spaces/${sid}`)).json.log.length > 3);
  assert.equal(d.members.every((m) => m.phone == null), true);
  assert.equal((await owner.get(`/api/pf/spaces/${sid}`)).json.members.some((m) => m.phone), true);
});

test('isolation avec les finances personnelles ; lecture seule si le propriétaire n\'est plus Pro', async () => {
  assert.equal((await rows('SELECT count(*)::int AS n FROM pf_all_tx WHERE owner_id = $1', [w.seller]))[0].n, 0);
  await setPrice(5000);
  const d = (await owner.get(`/api/pf/spaces/${sid}`)).json;
  assert.equal(d.writable, false);
  const r = await owner.post(`/api/pf/spaces/${sid}/transactions`, { account_id: a1, kind: 'expense', amount: 100, category: 'food', occurred_on: today });
  assert.equal(r.status, 403); assert.equal(r.json.error, 'pro_required');
  assert.equal((await owner.get(`/api/pf/spaces/${sid}`)).json.recent.length, 3, 'données conservées et lisibles');
  await setPrice(0);
});

test('retrait, départ, archivage, droits de la base', async () => {
  assert.equal((await contrib.post(`/api/pf/spaces/${sid}/members/${w.supplier}/remove`)).status, 403);
  assert.equal((await owner.post(`/api/pf/spaces/${sid}/members/${w.supplier}/remove`)).status, 200);
  assert.equal((await viewer.get(`/api/pf/spaces/${sid}`)).status, 404);
  assert.equal((await contrib.post(`/api/pf/spaces/${sid}/leave`)).status, 200);
  assert.equal((await owner.post(`/api/pf/spaces/${sid}/leave`)).status, 404, 'le propriétaire ne part pas (il archive)');
  assert.equal((await owner.post(`/api/pf/spaces/${sid}/archive`, { archived: true })).status, 200);
  assert.equal((await owner.post(`/api/pf/spaces/${sid}/transactions`, { account_id: a1, kind: 'expense', amount: 100, category: 'food', occurred_on: today })).status, 409);
  await assert.rejects(db.app.query(`INSERT INTO pf_space_tx(space_id, account_id, kind, amount, author_id, occurred_on) VALUES ($1,$2,'income',1,$3,current_date)`, [sid, a1, w.seller]));
  await assert.rejects(db.app.query('SELECT _space_on()'));
  await assert.rejects(db.owner.query('UPDATE pf_space_log SET detail = $1', ['x']));
});

test('retour arrière 057 : refusé s\'il existe des espaces', async () => {
  const sql = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-057.sql'), 'utf8');
  await assert.rejects(async () => { for (const st of splitSql(sql)) await db.owner.query(st); });
});
