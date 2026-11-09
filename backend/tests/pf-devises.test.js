// 056 : devises (base GNF, taux saisis à la main), comptes en devise, totaux convertis, retour arrière.
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
  db = await freshDb('wld_pfd'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_pfd', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
  s = await login(w.seller); s2 = await login(w.seller2); courier = await login(w.courier);
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });


const acc = (c, body) => c.post('/api/pf/accounts', body);
const tx = (c, body) => c.post('/api/pf/transactions', { kind: 'expense', category: 'food', occurred_on: dayStr(0), ...body });
const home = async (c, qs = '') => (await c.get(`/api/pf/home${qs}`)).json;
const cur = async (c) => (await c.get('/api/pf/currencies')).json;
const setPrice = (m) => db.owner.query(`UPDATE settings SET value = $1 WHERE key = 'pf_price_monthly'`, [m]);
let gnf, usd;

test('éteint : rien n\'est disponible ; allumé : GNF en base, aucune autre devise', async () => {
  assert.equal((await cur(s)).enabled, false);
  assert.equal((await s.post('/api/pf/currencies', { code: 'USD', name: 'Dollar', decimals: 2, rate: 9000 })).status, 403);
  await db.owner.query(`UPDATE settings SET value = 1 WHERE key = 'feature_finances_perso'`);
  await setPrice(5000); await db.owner.query(`UPDATE settings SET value = 0 WHERE key = 'pf_trial_days'`);
  const c = await cur(s);
  assert.equal(c.base.code, 'GNF'); assert.deepEqual(c.currencies, []); assert.equal(c.rates_auto, false); assert.equal(c.free_currencies, 1);
  gnf = (await acc(s, { name: 'Espèces', kind: 'cash', opening_balance: 100000 })).json.id;
});

test('ajouter une devise : validations, doublon = mise à jour du taux, limite gratuite, Pro illimité', async () => {
  for (const bad of [{ code: 'GNF', name: 'x', rate: 1 }, { code: 'us', name: 'x', rate: 1 }, { code: 'USD', name: '', rate: 1 }, { code: 'USD', name: 'x', rate: 0 }, { code: 'USD', name: 'x', rate: 'abc' }, { code: 'USD', name: 'x', rate: -5 }, { code: 'USD', name: 'x', decimals: 4, rate: 1 }])
    assert.equal((await s.post('/api/pf/currencies', bad)).status, 400, JSON.stringify(bad));
  assert.equal((await s.post('/api/pf/currencies', { code: 'usd', name: 'Dollar américain', decimals: 2, rate: '8 600'.replace(' ', '') })).status, 200);
  assert.equal((await cur(s)).currencies[0].rate, 8600);
  assert.equal((await s.post('/api/pf/currencies', { code: 'USD', name: 'Dollar américain', decimals: 2, rate: '8700,5' })).status, 200);
  assert.equal((await cur(s)).currencies[0].rate, 8700.5);
  const second = await s.post('/api/pf/currencies', { code: 'EUR', name: 'Euro', decimals: 2, rate: 9500 });
  assert.equal(second.status, 409); assert.equal(second.json.error, 'limit');
  assert.equal((await cur(courier)).currencies.length, 0, 'isolation');
  await setPrice(0);
  assert.equal((await s.post('/api/pf/currencies', { code: 'EUR', name: 'Euro', decimals: 2, rate: 9500 })).status, 200);
  await setPrice(5000);
});

test('compte en devise : montants dans la devise, solde converti dans les totaux, virement entre devises refusé', async () => {
  await setPrice(0);
  assert.equal((await acc(s, { name: 'Coffre XXX', kind: 'cash', opening_balance: 100, currency: 'XXX' })).status, 400, 'devise non ajoutée');
  const r = await acc(s, { name: 'Compte USD', kind: 'bank', opening_balance: 10000, currency: 'USD' });   // 100,00 USD au taux 8 700,5
  assert.equal(r.status, 201); usd = r.json.id;
  const list = (await s.get('/api/pf/accounts')).json.accounts;
  const u = list.find((a) => a.id === usd);
  assert.equal(u.currency, 'USD'); assert.equal(u.decimals, 2); assert.equal(u.balance, 10000); assert.equal(u.balance_base, 870050);
  assert.equal(list.find((a) => a.id === gnf).currency, 'GNF');
  const h = await home(s);
  assert.equal(h.balance, 100000 + 870050, 'le total est en GNF');
  // une dépense de 10,00 USD = 1 000 en minor : le solde du compte baisse de 1000, le total de 87 005 GNF
  assert.equal((await tx(s, { account_id: usd, amount: 1000 })).status, 201);
  const u2 = (await s.get('/api/pf/accounts')).json.accounts.find((a) => a.id === usd);
  assert.equal(u2.balance, 9000);
  const h2 = await home(s);
  assert.equal(h2.expense, 87005); assert.equal(h2.balance, 100000 + 783045);
  const t = (await s.get('/api/pf/transactions')).json.transactions[0];
  assert.equal(t.amount, 1000); assert.equal(t.currency, 'USD', 'la liste montre le montant du compte');
  // virements : même devise seulement
  assert.equal((await s.post('/api/pf/transfers', { from: gnf, to: usd, amount: 100, occurred_on: dayStr(0) })).status, 400);
  const usd2 = (await acc(s, { name: 'Autre USD', kind: 'cash', currency: 'USD' })).json.id;
  assert.equal((await s.post('/api/pf/transfers', { from: usd, to: usd2, amount: 500, occurred_on: dayStr(0) })).status, 201);
  assert.equal((await home(s)).expense, 87005, 'un virement ne change pas les dépenses');
  // la devise d'un compte ne change pas ; son nom, si
  assert.equal((await acc(s, { id: usd, name: 'Compte USD', kind: 'bank', opening_balance: 10000, currency: 'EUR' })).status, 409);
  assert.equal((await acc(s, { id: usd, name: 'Compte dollars', kind: 'bank', opening_balance: 10000, currency: 'USD' })).status, 200);
});

test('changer un taux recalcule les totaux, pas les soldes des comptes', async () => {
  assert.equal((await s.post('/api/pf/currencies', { code: 'USD', name: 'Dollar américain', decimals: 2, rate: 10000 })).status, 200);
  const u = (await s.get('/api/pf/accounts')).json.accounts.find((a) => a.id === usd);
  assert.equal(u.balance, 8500); assert.equal(u.balance_base, 850000);
  assert.equal((await home(s)).expense, 100000);
  assert.equal((await s.post('/api/pf/currencies', { code: 'USD', name: 'Dollar américain', decimals: 0, rate: 10000 })).status, 409, 'les décimales ne changent plus après un compte');
});

test('retirer une devise : refusé si un compte l\'utilise ; réglage automatique conservé', async () => {
  assert.equal((await s.post('/api/pf/currencies/USD/remove', {})).status, 409);
  assert.equal((await s.post('/api/pf/currencies/EUR/remove', {})).status, 200);
  assert.equal((await s.post('/api/pf/currencies/EUR/remove', {})).status, 404);
  assert.equal((await s.post('/api/pf/rates-auto', { on: true })).status, 200);
  assert.equal((await cur(s)).rates_auto, true);
  assert.equal((await cur(courier)).rates_auto, false);
});

test('le compte qui reçoit les mouvements Wallindirain doit être en GNF', async () => {
  assert.equal((await s.post('/api/pf/wallet-link', { account_id: usd })).status, 400);
});

test('anonymisation : les devises disparaissent', async () => {
  await db.owner.query(`UPDATE users SET deleted_at = now() WHERE id = $1`, [w.seller]);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM pf_currencies WHERE owner_id = $1`, [w.seller]))[0].n, 0);
});

test('droits : tables et fonctions', async () => {
  try { const r = await db.app.query(`INSERT INTO pf_currencies(owner_id, code, name, decimals, rate) VALUES ($1,'EUR','x',2,1)`, [w.seller2]); console.log('DBG insert ok', JSON.stringify(r).slice(0,100)); } catch (e) { console.log('DBG', e.message); }
  await assert.rejects(db.app.query(`INSERT INTO pf_currencies(owner_id, code, name, decimals, rate) VALUES ($1,'EUR','x',2,1)`, [w.seller2]), /permission denied/);
  await assert.rejects(db.app.query(`SELECT _pf_account_save_base($1, NULL, 'abc', 'cash', 'blue', 0)`, [w.seller2]), /permission denied/);
  for (const sql of [`SELECT * FROM pf_all_tx_raw`, `SELECT _pf_account_save_base($1, NULL, 'abc', 'cash', 'blue', 0)`]) { let err = null; try { await db.app.query(sql, sql.includes('$1') ? [w.seller2] : []); } catch (e) { err = e; } console.log('DBG', sql.slice(0, 40), err?.message); }
  await db.app.query(`SELECT count(*) FROM pf_all_tx`);
});

test('retour arrière 056 : refusé s\'il existe des devises ou des comptes en devise, accepté sinon', async () => {
  const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-056.sql'), 'utf8');
  const run = async () => { await db.owner.query('BEGIN'); try { for (const q of splitSql(rb)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT'); } catch (e) { await db.owner.query('ROLLBACK'); throw e; } };
  const c2 = (await acc(s2, { name: 'Caisse', kind: 'cash', opening_balance: 500 })).json.id;
  await s2.post('/api/pf/currencies', { code: 'EUR', name: 'Euro', decimals: 2, rate: 9500 });
  await assert.rejects(run, /devises ou des comptes en devise existent/);
  await db.owner.query(`DELETE FROM pf_currencies`); await db.owner.query(`UPDATE pf_prefs SET rates_auto = false`);
  await db.owner.query(`UPDATE pf_accounts SET currency = 'GNF'`);
  await run();
  assert.equal((await rows(`SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('fn_pf_currency_save','_pf_account_save_base')`))[0].n, 0);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'pf_all_tx' AND column_name = 'currency'`))[0].n, 0);
  await db.app.query(`SELECT fn_pf_account_save($1, NULL, 'Autre caisse', 'cash', 'blue', 0)`, [w.seller2]);   // l'ancienne fonction à 6 paramètres est revenue
});
