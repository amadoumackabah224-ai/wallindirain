// 052-053 : compte membre (finances seulement) : inscription fermée par défaut, rôle limité à Mes finances, textes légaux, retour arrière.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshDb, TEST_DB, APP_PW, world, call, expectErr, deliver } from './helpers.js';
import { splitSql } from '../src/migrate.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';

const PW = 'Secret123';
const root = path.resolve(import.meta.dirname, '..', '..');
let db, w, srv, base, n = 0;
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
const order = (extra = {}) => ({ request_key: `r${String(++n).padStart(3, '0')}`.padEnd(20, 'x'), qty: 2, customer_name: 'Client Test', customer_phone: `62200${String(1000 + n)}`, commune: 'Ratoma', address: 'Rue 1, près du marché', unit_price: 100000, own_product_name: 'Sac', pickup_detail: 'Chez moi', ...extra });
const place = async (s, extra = {}) => { const r = await s.post('/api/seller/orders', order(extra)); assert.equal(r.status, 201); return r.json; };
const rows = async (sql, p) => (await db.owner.query(sql, p)).rows;
const dayStr = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const walletTotals = async () => (await rows('SELECT count(*)::int AS n, COALESCE(sum(amount),0)::text AS t FROM wallet_entries'))[0];
let s, s2, courier;

before(async () => {
  db = await freshDb('wld_pfm'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_pfm', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
  s = await login(w.seller); s2 = await login(w.seller2); courier = await login(w.courier);
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });


const PWD = 'Secret123x';
const reg = (c, b = {}) => { srv.resetLimits(); return c.post('/api/auth/register', { role: 'member', name: 'Ibrahima Camara', phone: '622334455', password: PWD, accept_terms: true, ...b }); };
const setting = (k, v) => db.owner.query('UPDATE settings SET value = $1 WHERE key = $2', [v, k]);
let m;

test('fermée par défaut : ni inscription ni option publique', async () => {
  const c = new Client();
  assert.equal((await c.get('/api/public/info')).json.features.member_signup, false);
  assert.equal((await reg(c)).status, 403);
  await setting('feature_finances_perso', 1);
  assert.equal((await reg(c)).status, 403, 'Mes finances allumé mais inscription non ouverte');
  await setting('feature_finances_perso', 0); await setting('pf_open_signup', 1);
  assert.equal((await reg(c)).status, 403, 'inscription ouverte mais Mes finances éteint');
  await assert.rejects(db.app.query(`SELECT fn_register('622334455','Aa Bb','member','x',NULL,NULL,NULL,'2026-10-24')`), /Inscription ouverte aux vendeurs/);
});

test('ouverte : inscription sans versement ni pièce, refus des numéros étrangers et de l\'accord manquant', async () => {
  await setting('feature_finances_perso', 1);
  const c = new Client();
  assert.equal((await c.get('/api/public/info')).json.features.member_signup, true);
  assert.equal((await reg(c, { accept_terms: false })).status, 400);
  assert.equal((await reg(c, { phone: '+33612345678' })).status, 400);
  assert.equal((await reg(c, { password: 'court' })).status, 400);
  const r = await reg(c, { payout_method: 'orange_money', payout_phone: '622334455' }); assert.equal(r.status, 201);
  assert.equal((await reg(c)).status, 409, 'numéro déjà inscrit');
  const u = (await db.owner.query(`SELECT role::text AS role, status::text AS status, payout_method, payout_phone FROM users WHERE phone = '622334455'`)).rows[0];
  assert.deepEqual(u, { role: 'member', status: 'active', payout_method: null, payout_phone: null });
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM consents WHERE user_id = (SELECT id FROM users WHERE phone = '622334455')`)).rows[0].n, 1);
});

test('le membre n\'a que Mes finances', async () => {
  m = new Client(); assert.equal((await m.post('/api/auth/login', { phone: '622334455', password: PWD })).status, 200);
  const me = (await m.get('/api/auth/me')).json.user; assert.equal(me.role, 'member');
  const st = (await m.get('/api/pf/status')).json; assert.equal(st.enabled, true); assert.equal(st.wallet.eligible, false);
  const acc = await m.post('/api/pf/accounts', { name: 'Orange Money', kind: 'mobile_money', opening_balance: 50000 }); assert.equal(acc.status, 201);
  assert.equal((await m.post('/api/pf/transactions', { account_id: acc.json.id, kind: 'expense', category: 'food', amount: 5000, occurred_on: new Date().toISOString().slice(0, 10) })).status, 201);
  assert.equal((await m.get('/api/pf/home?days=30')).json.balance, 45000);
  assert.equal((await m.post('/api/pf/contacts', { name: 'Mariama', phone: '621000001' })).status, 201);
  assert.equal((await m.post('/api/pf/budgets', { category: 'food', amount: 1000 })).status, 200, 'tout le monde est Pro tant que le prix est à 0');
  for (const [method, url] of [['get', '/api/wallet'], ['get', '/api/seller/orders'], ['get', '/api/calls/queue'], ['get', '/api/courier/orders'], ['get', '/api/admin/users'], ['get', '/api/products'], ['post', '/api/pf/wallet-link']]) {
    const r = method === 'get' ? await m.get(url) : await m.post(url, {});
    assert.ok([401, 403, 404].includes(r.status), `${url} : ${r.status}`);
  }
  assert.equal((await db.app.query(`SELECT count(*)::int AS n FROM wallet_entries WHERE user_id = (SELECT id FROM users WHERE phone = '622334455')`)).rows[0].n, 0, 'aucun portefeuille');
});

test('textes légaux du membre : lisibles avant l\'inscription, propres au membre', async () => {
  const c = new Client();
  const l = (await c.get('/api/public/legal?audience=member')).json.pages.map((p) => p.slug);
  assert.deepEqual(l, ['mentions-legales', 'cookies', 'conditions-membre', 'confidentialite-membre']);
  for (const slug of ['conditions-membre', 'confidentialite-membre']) {
    const r = await c.get(`/api/public/legal/${slug}`); assert.equal(r.status, 200);
    assert.ok(!/\{\{|include:|<script/i.test(r.json.html)); assert.ok(r.json.html.length > 1500);
  }
  assert.equal((await m.get('/api/public/legal')).json.pages.some((p) => p.slug === 'conditions-vendeur'), false, 'un membre ne voit pas les textes des vendeurs');
});

test('les autres rôles ne voient pas Mes finances de façon différente ; un vendeur ne peut pas s\'inscrire en membre sans réglage', async () => {
  await setting('pf_open_signup', 0);
  assert.equal((await reg(new Client(), { phone: '622000999' })).status, 403);
  assert.equal((await s.get('/api/pf/status')).json.wallet.eligible, true);
});

test('retour arrière 053 puis 052 : refusé avec des membres, accepté sans', async () => {
  const run = async (f) => { const rb = fs.readFileSync(path.join(root, 'docs', f), 'utf8'); await db.owner.query('BEGIN'); try { for (const q of splitSql(rb)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT'); } catch (e) { await db.owner.query('ROLLBACK'); throw e; } };
  await assert.rejects(() => run('retour-arriere-053.sql'), /des comptes membres existent/);
  await db.owner.query(`UPDATE users SET role = 'seller' WHERE role::text = 'member'`);
  await run('retour-arriere-053.sql'); await run('retour-arriere-052.sql');
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM settings WHERE key = 'pf_open_signup'`)).rows[0].n, 0);
  await assert.rejects(db.app.query(`SELECT fn_register('622334455','Aa Bb','seller','x',NULL,NULL,NULL,'2026-10-24')`), /duplicate|déjà|phone_taken|Ce numéro/i);
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE name IN ('052_role_membre.sql','053_compte_finances_seul.sql')`)).rows[0].n, 0);
});
