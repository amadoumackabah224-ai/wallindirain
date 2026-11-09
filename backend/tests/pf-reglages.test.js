// 055 : réglages de Mes finances (décimales, période par défaut, blocs du tableau de bord, seuils des jauges), périodes, jauges par rapport.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshDb, TEST_DB, APP_PW, world, call, expectErr, deliver } from './helpers.js';
import { splitSql } from '../src/migrate.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';
import { gauges, ratioPosition, periodDays } from '../src/pf.js';

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
  db = await freshDb('wld_pfr'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_pfr', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
  s = await login(w.seller); s2 = await login(w.seller2); courier = await login(w.courier);
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });


const acc = (c, body) => c.post('/api/pf/accounts', body);
const tx = (c, body) => c.post('/api/pf/transactions', { kind: 'expense', category: 'food', occurred_on: dayStr(0), ...body });
const home = async (c, qs = '') => (await c.get(`/api/pf/home${qs}`)).json;
const setPrice = (m) => db.owner.query(`UPDATE settings SET value = $1 WHERE key = 'pf_price_monthly'`, [m]);
const settings = async (c) => (await c.get('/api/pf/settings')).json;
let accId;

test('calculs purs : périodes et position de l\'aiguille', () => {
  const d = new Date('2026-11-11T10:00:00Z');   // mercredi
  assert.equal(periodDays('today', d), 1); assert.equal(periodDays('week', d), 3); assert.equal(periodDays('month', d), 11);
  assert.equal(periodDays('year', d), 315); assert.equal(periodDays('d7', d), 7); assert.equal(periodDays('w12', d), 84); assert.equal(periodDays('m6', d), 182); assert.equal(periodDays('y1', d), 365);
  assert.equal(periodDays('inconnue', d), 30);
  assert.equal(ratioPosition(0, 0.9, 1.2), 0);
  assert.ok(ratioPosition(0.5, 0.9, 1.2) < 0.33, 'sous le seuil faible : rouge');
  const mid = ratioPosition(1.0, 0.9, 1.2); assert.ok(mid > 0.33 && mid < 0.67, 'entre les deux : orange');
  assert.ok(ratioPosition(1.5, 0.9, 1.2) > 0.67, 'au-dessus du seuil élevé : vert');
  assert.ok(ratioPosition(0.5, 0.2, 0.4) > 0.67, 'seuils personnalisés : 0,5 devient élevé');
  const g = gauges({ opIncome: 100, prevOpIncome: 100, net: 0, prevNet: 0, balance: 0, balance30: 0 });
  assert.equal(g.flow, 0.5);
});

test('éteint : rien n\'est disponible ; allumé : réglages par défaut', async () => {
  assert.equal((await settings(s)).enabled, false);
  assert.equal((await s.post('/api/pf/settings', { default_period: 'd30' })).status, 403);
  await db.owner.query(`UPDATE settings SET value = 1 WHERE key = 'feature_finances_perso'`);
  await setPrice(0);
  accId = (await acc(s, { name: 'Espèces', kind: 'cash', opening_balance: 1000000 })).json.id;
  const d = await settings(s);
  assert.equal(d.decimals, false); assert.equal(d.default_period, 'd30');
  assert.deepEqual(d.widgets, { balance_evolution: true, accounts: true, cash_flow: true, planned_payments: false, cash_forecast: false, balance: false, expenses: false, top_expense: false, exchange_rate: false, budget: false, recent_tx: true });
  assert.equal(d.gauges.income_low, null);
});

test('enregistrer : validations, valeurs conservées, isolation', async () => {
  const ok = { decimals: true, default_period: 'week', widgets: { budget: true, accounts: false }, gauges: { income_low: 0.5, income_high: 1.5, flow_low: 0.2 } };
  assert.equal((await s.post('/api/pf/settings', ok)).status, 200);
  const d = await settings(s);
  assert.equal(d.decimals, true); assert.equal(d.default_period, 'week'); assert.equal(d.widgets.budget, true); assert.equal(d.widgets.accounts, false); assert.equal(d.widgets.recent_tx, true);
  assert.equal(d.gauges.income_low, 0.5); assert.equal(d.gauges.income_high, 1.5); assert.equal(d.gauges.flow_low, 0.2); assert.equal(d.gauges.flow_high, null);
  assert.equal((await settings(courier)).default_period, 'd30');
  for (const bad of [{ default_period: 'x' }, { default_period: 'd30', widgets: { pirate: true } }, { default_period: 'd30', widgets: { budget: 'oui' } }, { default_period: 'd30', widgets: [] },
    { default_period: 'd30', gauges: { income_low: 1.2, income_high: 0.9 } }, { default_period: 'd30', gauges: { income_low: 11 } }, { default_period: 'd30', gauges: { income_low: -1 } },
    { default_period: 'd30', gauges: { inconnu: 1 } }, { default_period: 'd30', gauges: { income_low: 'a' } }]) assert.equal((await s.post('/api/pf/settings', bad)).status, 400, JSON.stringify(bad));
  assert.equal((await settings(s)).default_period, 'week', 'un refus ne change rien');
  assert.equal((await s.post('/api/pf/settings', { decimals: false, default_period: 'd30' })).status, 200);
  assert.equal((await settings(s)).gauges.income_low, null, 'seuils vides = valeurs par défaut');
});

test('tableau de bord : périodes, période par défaut, limite de la formule gratuite', async () => {
  for (const [p, n] of [['today', 1], ['d7', 7], ['d30', 30], ['w12', 84], ['m6', 182], ['y1', 365]]) assert.equal((await home(s, `?period=${p}`)).days, n, p);
  assert.equal((await home(s, '?period=month')).days, new Date().getUTCDate());
  await s.post('/api/pf/settings', { default_period: 'm6' });
  assert.equal((await home(s)).days, 182, 'période par défaut');
  assert.equal((await home(s, '?days=90')).days, 90, 'ancien paramètre toujours accepté');
  await s.post('/api/pf/settings', { default_period: 'd30' });
  await setPrice(5000); await db.owner.query(`UPDATE settings SET value = 0 WHERE key = 'pf_trial_days'`);
  await db.owner.query(`DELETE FROM pf_access WHERE owner_id = $1`, [w.seller]);
  const h = await home(s, '?period=y1');
  assert.equal(h.days, 30); assert.equal(h.clamped, true);
  assert.ok(h.series.length >= 7);
  await setPrice(0);
});

test('jauges : 30 derniers jours contre les 30 d\'avant ; financements exclus des revenus ; seuils personnels', async () => {
  const income = (amount, offset, category = 'sales') => tx(s2, { account_id: acc2, kind: 'income', amount, category, occurred_on: dayStr(offset) });
  const acc2 = (await acc(s2, { name: 'Caisse', kind: 'cash' })).json.id;
  assert.equal((await home(s2)).gauges.income, 0, 'aucun revenu : aiguille en bas');
  await income(100000, -40); await income(100000, -5);                       // même niveau : ratio 1
  let g = (await home(s2)).gauges;
  assert.ok(Math.abs(g.ratios.income - 1) < 1e-9);
  assert.ok(g.income > 0.33 && g.income < 0.67, 'ratio 1 : zone orange avec 0,9 / 1,2');
  await income(900000, -3, 'financing');                                     // un prêt reçu ne compte pas comme revenu d'exploitation
  g = (await home(s2)).gauges;
  assert.ok(Math.abs(g.ratios.income - 1) < 1e-9, 'financement exclu');
  await income(150000, -2);                                                  // ratio 2,5 : élevé
  g = (await home(s2)).gauges; assert.ok(g.income > 0.67, 'élevé');
  await s2.post('/api/pf/settings', { default_period: 'd30', gauges: { income_low: 3, income_high: 4 } });
  g = (await home(s2)).gauges; assert.ok(g.income < 0.33, 'avec « faible » à 3, un ratio de 2,5 est faible');
});

test('droits : fonction accessible, l\'application ne modifie pas la table directement', async () => {
  await assert.rejects(db.app.query(`UPDATE pf_prefs SET decimals = true`), /permission denied/);
  await db.app.query(`SELECT fn_pf_settings_set($1, false, 'd30', NULL, NULL)`, [w.seller]);
});

test('retour arrière 055 : refusé s\'il existe des réglages, accepté sinon', async () => {
  const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-055.sql'), 'utf8');
  const run = async () => { await db.owner.query('BEGIN'); try { for (const q of splitSql(rb)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT'); } catch (e) { await db.owner.query('ROLLBACK'); throw e; } };
  await s2.post('/api/pf/settings', { default_period: 'week' });
  await assert.rejects(run, /réglages personnalisés existent/);
  await s2.post('/api/pf/settings', { default_period: 'd30' });
  await run();
  assert.equal((await rows(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'pf_prefs' AND column_name IN ('decimals','widgets','default_period')`))[0].n, 0);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '055_reglages_finances.sql'`))[0].n, 0);
});
