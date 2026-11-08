// 049 : Plan financier (budgets, objectif du mois, récurrents, prévision), formule Pro, droits, retour arrière.
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
  db = await freshDb('wld_pfp'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_pfp', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
  s = await login(w.seller); s2 = await login(w.seller2); courier = await login(w.courier);
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });


const acc = (c, body) => c.post('/api/pf/accounts', body);
const tx = (c, body) => c.post('/api/pf/transactions', { kind: 'expense', category: 'food', occurred_on: dayStr(0), ...body });
const plan = async (c) => (await c.get('/api/pf/plan')).json;
const setPrice = (m) => db.owner.query(`UPDATE settings SET value = $1 WHERE key = 'pf_price_monthly'`, [m]);
const rec = (extra = {}) => ({ label: 'Loyer', kind: 'expense', category: 'housing', amount: 500000, frequency: 'monthly', anchor_on: dayStr(5), ...extra });
let accId;

test('éteint : le plan n\'est pas disponible', async () => {
  assert.equal((await s.get('/api/pf/plan')).json.enabled, false);
  assert.equal((await s.post('/api/pf/budgets', { category: 'food', amount: 1000 })).status, 403);
  await db.owner.query(`UPDATE settings SET value = 1 WHERE key = 'feature_finances_perso'`);
  accId = (await acc(s, { name: 'Espèces', kind: 'cash', opening_balance: 1000000 })).json.id;
});

test('budgets : suivi du mois, retrait, validation, isolation', async () => {
  assert.equal((await s.post('/api/pf/budgets', { category: 'food', amount: 100000 })).status, 200);
  await tx(s, { account_id: accId, amount: 30000 });
  await tx(s, { account_id: accId, amount: 5000, category: 'transport' });
  const p = await plan(s);
  assert.deepEqual(p.budgets, [{ category: 'food', amount: 100000, spent: 30000 }]);
  assert.equal((await s.post('/api/pf/budgets', { category: 'sales', amount: 10 })).status, 400);
  assert.equal((await s.post('/api/pf/budgets', { category: 'food', amount: -5 })).status, 400);
  assert.equal((await plan(courier)).budgets.length, 0);
  assert.equal((await s.post('/api/pf/budgets', { category: 'food', amount: null })).status, 200);
  assert.equal((await plan(s)).budgets.length, 0);
});

test('objectif du mois : épargné = revenus - dépenses du mois', async () => {
  assert.equal((await s.post('/api/pf/goal', { target: 200000 })).status, 200);
  await tx(s, { account_id: accId, amount: 80000, kind: 'income', category: 'salary' });
  const p = await plan(s);
  assert.equal(p.goal.target, 200000);
  assert.equal(p.goal.saved, 80000 - 35000);
  assert.equal((await s.post('/api/pf/goal', { target: 0 })).status, 400);
  assert.equal((await s.post('/api/pf/goal', {})).status, 200); assert.equal((await plan(s)).goal, null);
});

test('récurrents : création, validation, prévision à 30 jours, arrêt, limite', async () => {
  const r = await s.post('/api/pf/recurring', rec());
  assert.equal(r.status, 201);
  await s.post('/api/pf/recurring', rec({ label: 'Salaire', kind: 'income', category: 'salary', amount: 900000, frequency: 'weekly', anchor_on: dayStr(1) }));
  const p = await plan(s);
  assert.equal(p.recurring.length, 2);
  assert.equal(p.forecast.income, 900000 * p.forecast.upcoming.filter((u) => u.kind === 'income').length);
  assert.ok(p.forecast.upcoming.length >= 5);
  assert.equal(p.forecast.projected, p.forecast.balance + p.forecast.income - p.forecast.expense);
  assert.equal((await s.post('/api/pf/recurring', rec({ category: 'sales' }))).status, 400);
  assert.equal((await s.post('/api/pf/recurring', rec({ frequency: 'yearly' }))).status, 400);
  assert.equal((await s.post('/api/pf/recurring', rec({ anchor_on: '2026-03-31' }))).status, 400, 'mensuel : jour 1 à 28');
  assert.equal((await s.post('/api/pf/recurring', rec({ label: 'x' }))).status, 400);
  assert.equal((await s.post('/api/pf/recurring', { ...rec({ label: 'Loyer 2' }), id: r.json.id })).status, 200);
  assert.equal((await courier.post('/api/pf/recurring', { ...rec(), id: r.json.id })).status, 404, 'pas celui d\'un autre');
  assert.equal((await courier.post(`/api/pf/recurring/${r.json.id}/stop`)).status, 404);
  assert.equal((await s.post(`/api/pf/recurring/${r.json.id}/stop`)).status, 200);
  assert.equal((await plan(s)).recurring.length, 1);
  for (let i = 0; i < 29; i++) assert.equal((await s.post('/api/pf/recurring', rec({ label: `Abo ${i}` }))).status, 201);
  assert.equal((await s.post('/api/pf/recurring', rec({ label: 'De trop' }))).status, 409);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM wallet_entries WHERE kind LIKE 'pf%'`))[0].n, 0, 'aucune écriture du portefeuille');
});

test('formule Pro : prix fixé et pas d\'abonnement = écritures refusées, données gardées ; abonné = rétabli', async () => {
  await setPrice(5000);
  await db.owner.query(`DELETE FROM pf_access`);
  assert.equal((await s.get('/api/pf/status')).json.tier, 'free');
  const r = await s.post('/api/pf/budgets', { category: 'food', amount: 1 });
  assert.equal(r.status, 403); assert.equal(r.json.error, 'pro_required');
  assert.equal((await s.post('/api/pf/goal', { target: 5 })).status, 403);
  assert.equal((await s.post('/api/pf/recurring', rec({ label: 'Autre' }))).status, 403);
  assert.ok((await plan(s)).recurring.length >= 1, 'lecture conservée');
  const one = (await plan(s)).recurring[0];
  assert.equal((await s.post(`/api/pf/recurring/${one.id}/stop`)).status, 200, 'arrêter reste possible');
  await db.owner.query(`INSERT INTO pf_access(owner_id, paid_until) VALUES ($1, now() + interval '30 days') ON CONFLICT (owner_id) DO UPDATE SET paid_until = EXCLUDED.paid_until`, [w.seller]);
  assert.equal((await s.post('/api/pf/budgets', { category: 'food', amount: 1 })).status, 200);
  await setPrice(0);
});

test('droits : l\'application ne peut pas appeler _pf_pro ni toucher les tables en direct', async () => {
  await assert.rejects(db.app.query(`SELECT _pf_pro($1)`, [w.seller]), /permission denied/i);
  await assert.rejects(db.app.query(`INSERT INTO pf_budgets(owner_id, category, amount) VALUES ($1,'food',1)`, [w.seller]), /permission denied/i);
  await assert.rejects(db.app.query(`DELETE FROM pf_recurring`), /permission denied/i);
});

test('anonymisation du compte : le plan disparaît avec lui', async () => {
  await db.owner.query(`INSERT INTO pf_budgets(owner_id, category, amount) VALUES ($1,'food',1)`, [w.seller2]);
  await db.owner.query(`INSERT INTO pf_goals(owner_id, month, amount_placeholder) VALUES ($1, date_trunc('month', now())::date, 1)`.replace('amount_placeholder', 'target'), [w.seller2]);
  await db.owner.query(`INSERT INTO pf_recurring(owner_id, label, kind, category, amount, frequency, anchor_on) VALUES ($1,'Loyer','expense','housing',1,'daily',current_date)`, [w.seller2]);
  await db.owner.query(`UPDATE users SET deleted_at = now() WHERE id = $1`, [w.seller2]);
  for (const t of ['pf_budgets', 'pf_goals', 'pf_recurring']) assert.equal((await rows(`SELECT count(*)::int AS n FROM ${t} WHERE owner_id = $1`, [w.seller2]))[0].n, 0, t);
});

test('retour arrière 049 : refusé s\'il existe des données, accepté sinon ; le registre est nettoyé', async () => {
  const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-049.sql'), 'utf8');
  const run = async () => { await db.owner.query('BEGIN'); try { for (const q of splitSql(rb)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT'); } catch (e) { await db.owner.query('ROLLBACK'); throw e; } };
  await assert.rejects(run, /des données du Plan financier existent/);
  for (const t of ['pf_budgets', 'pf_goals', 'pf_recurring']) await db.owner.query(`DELETE FROM ${t}`);
  await run();
  assert.equal((await rows(`SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('_pf_pro','fn_pf_budget_set','fn_pf_goal_set','fn_pf_recurring_save','fn_pf_recurring_stop')`))[0].n, 0);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '049_plan_financier.sql'`))[0].n, 0);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM pf_accounts`))[0].n, 1, 'Mes finances de base reste intact');
});
