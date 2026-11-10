// 060 : l'administrateur est toujours Pro ; paie des employés (payer, annuler, un seul paiement par mois).
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
let admin, seller, acc, emp;

before(async () => {
  db = await freshDb('wld_pfp'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  await db.owner.query(`UPDATE settings SET value = 1 WHERE key = 'feature_finances_perso'`);
  await db.owner.query(`UPDATE settings SET value = 5000 WHERE key = 'pf_price_monthly'`);
  await db.owner.query(`UPDATE settings SET value = 0 WHERE key = 'pf_trial_days'`);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_pfp', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
  admin = await login(w.admin); seller = await login(w.seller);
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });

test('administrateur : toujours Pro, profil entreprise par défaut ; un vendeur reste en gratuit', async () => {
  const h = (await admin.get('/api/pf/home')).json;
  assert.equal(h.tier, 'pro'); assert.equal((await admin.get('/api/pf/categories')).json.profile, 'business');
  assert.equal((await seller.get('/api/pf/home')).json.tier, 'free');
  assert.equal((await seller.post('/api/pf/payroll', { name: 'Awa', monthly_amount: 1000 })).status, 403);
});

test('paie : ajouter, payer, un seul paiement par mois, annuler', async () => {
  acc = (await admin.post('/api/pf/accounts', { name: 'Caisse', kind: 'cash', color: 'teal', opening_balance: 1000000 })).json.id;
  emp = (await admin.post('/api/pf/payroll', { name: 'Mamadou Diallo', job: 'Agent call center', monthly_amount: 300000, user_id: w.agent ?? null })).json.id;
  assert.ok(emp);
  assert.equal((await admin.post('/api/pf/payroll', { name: 'X', monthly_amount: 1000 })).status, 400);
  let p = (await admin.get(`/api/pf/payroll?month=${month}`)).json;
  assert.equal(p.due, 300000); assert.equal(p.unpaid, 300000); assert.equal(p.paid, 0);
  assert.equal((await admin.post(`/api/pf/payroll/${emp}/pay`, { month, account_id: acc, paid_on: today })).status, 201);
  p = (await admin.get(`/api/pf/payroll?month=${month}`)).json;
  assert.equal(p.paid, 300000); assert.equal(p.unpaid, 0); assert.equal(p.employees[0].paid_on, today);
  assert.equal((await admin.post(`/api/pf/payroll/${emp}/pay`, { month, account_id: acc, paid_on: today })).status, 409);
  const tx = await rows(`SELECT category, kind, amount::int a, note FROM pf_transactions WHERE owner_id = $1 AND voided_at IS NULL`, [w.admin]);
  assert.deepEqual([tx[0].category, tx[0].kind, tx[0].a], ['employees', 'expense', 300000]);
  assert.match(tx[0].note, /Salaire .*Mamadou Diallo/);
  assert.equal((await admin.get('/api/pf/accounts')).json.accounts.find((a) => a.id === acc).balance, 700000);
  assert.equal((await admin.post(`/api/pf/payroll/${emp}/unpay`, { month })).status, 200);
  assert.equal((await admin.get('/api/pf/accounts')).json.accounts.find((a) => a.id === acc).balance, 1000000);
  assert.equal((await admin.post(`/api/pf/payroll/${emp}/unpay`, { month })).status, 404);
});

test('paie : montant personnalisé, mois suivant libre, compte étranger refusé, archivage', async () => {
  const next = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 7);
  assert.equal((await admin.post(`/api/pf/payroll/${emp}/pay`, { month: next, account_id: acc, amount: 250000, paid_on: today })).status, 201);
  assert.equal((await admin.get(`/api/pf/payroll?month=${next}`)).json.paid, 250000);
  assert.equal((await admin.post(`/api/pf/payroll/${emp}/pay`, { month, account_id: '00000000-0000-4000-8000-000000000000', paid_on: today })).status, 400);
  assert.equal((await seller.post(`/api/pf/payroll/${emp}/pay`, { month, account_id: acc, paid_on: today })).status, 403);
  assert.equal((await admin.post(`/api/pf/payroll/${emp}/archive`, { archived: true })).status, 200);
  assert.equal((await admin.get(`/api/pf/payroll?month=${month}`)).json.employees.length, 0, 'archivé et sans paiement ce mois : masqué');
  assert.equal((await admin.get(`/api/pf/payroll?month=${next}`)).json.employees.length, 1, 'mais visible là où il a été payé');
  assert.equal((await admin.get('/api/pf/payroll/staff')).status, 200);
  assert.equal((await seller.get('/api/pf/payroll/staff')).status, 403);
});

test('effacement des données et retour arrière', async () => {
  const sql = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-060.sql'), 'utf8');
  await assert.rejects(async () => { for (const st of splitSql(sql)) await db.owner.query(st); });
  assert.equal((await admin.post('/api/pf/erase', { confirm: 'EFFACER' })).status, 200);
  assert.equal((await rows('SELECT count(*)::int n FROM pf_payroll WHERE owner_id = $1', [w.admin]))[0].n, 0);
  for (const st of splitSql(sql)) await db.owner.query(st);
  assert.equal((await rows(`SELECT count(*)::int n FROM pg_proc WHERE proname = 'fn_pf_payroll_pay'`))[0].n, 0);
});
