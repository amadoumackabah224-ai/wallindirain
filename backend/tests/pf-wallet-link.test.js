// 051 : Mes finances reliées automatiquement au compte Wallindirain (Pro), lecture seule, droits, retour arrière.
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
  db = await freshDb('wld_pfw'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_pfw', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
  s = await login(w.seller); s2 = await login(w.seller2); courier = await login(w.courier);
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });


const SYS = '00000000-0000-0000-0000-000000000001';
const entry = (user, kind, amount, extra = '') => db.owner.query(`INSERT INTO wallet_entries(user_id, kind, amount, description${extra ? ', available_at' : ''}) VALUES ($1, $2, $3, $4${extra ? ', ' + extra : ''})`, [user, kind, amount, 'test']);
const pair = async (user, kind, amount) => { await entry(user, kind, amount); await entry(SYS, kind, -amount); };
const home = async (c) => (await c.get('/api/pf/home?days=30')).json;
const setPrice = (m) => db.owner.query(`UPDATE settings SET value = $1 WHERE key = 'pf_price_monthly'`, [m]);
let cash, snap;

test('avant liaison : rien du portefeuille dans les totaux ; éteint = rien', async () => {
  assert.equal((await s.get('/api/pf/status')).json.enabled, false);
  assert.equal((await s.post('/api/pf/wallet-link', {})).status, 403);
  await db.owner.query(`UPDATE settings SET value = 1 WHERE key = 'feature_finances_perso'`);
  cash = (await s.post('/api/pf/accounts', { name: 'Espèces', kind: 'cash', opening_balance: 100000 })).json.id;
  await pair(w.seller, 'seller_gain', 500000); await pair(w.seller, 'stock_purchase', -120000);
  const h = await home(s); assert.equal(h.balance, 100000); assert.equal(h.income, 0);
  const st = (await s.get('/api/pf/status')).json.wallet; assert.deepEqual(st, { eligible: true, linked: false, account: null });
  assert.equal((await courier.get('/api/pf/status')).json.wallet.eligible, true);
  assert.equal((await rows('SELECT count(*)::int AS n FROM pf_all_tx WHERE owner_id = $1', [w.seller]))[0].n, 0);
  snap = (await rows('SELECT count(*)::int AS n, COALESCE(sum(amount),0)::text AS t FROM wallet_entries'))[0];
});

test('relier : compte Mobile Money créé, gains et achats arrivent seuls, totaux justes', async () => {
  const r = await s.post('/api/pf/wallet-link', {}); assert.equal(r.status, 200);
  const h = await home(s);
  assert.equal(h.balance, 100000 + 380000, 'Espèces + portefeuille');
  assert.equal(h.income, 500000); assert.equal(h.expense, 120000);
  const wa = h.accounts.find((a) => a.id === 'wallindirain'); assert.equal(wa.balance, 380000); assert.equal(wa.writable, false); assert.equal(wa.auto, true);
  assert.ok(h.accounts.some((a) => a.name === 'Mobile Money' && a.id === r.json.account_id));
  assert.ok(h.income_by_category.some((c) => c.category === 'sales'));
  assert.ok(h.expense_by_category.some((c) => c.category === 'business'));
  const tx = (await s.get('/api/pf/transactions?account=wallindirain')).json.transactions;
  assert.equal(tx.length, 2); assert.ok(tx.every((t) => t.source === 'wallindirain' && t.account_name === 'Wallindirain'));
  assert.equal((await s.post(`/api/pf/transactions/${tx[0].id}/void`)).status, 400, 'une ligne automatique ne se modifie pas');
  assert.equal(h.series.at(-1).balance, h.balance, 'la courbe finit sur le solde');
});

test('dépôts et retraits : virements avec Mobile Money, jamais un revenu ni une dépense', async () => {
  await pair(w.seller, 'withdrawal', -200000);
  let h = await home(s);
  assert.equal(h.balance, 100000 + 380000, 'le total ne bouge pas : l\'argent change de compte');
  assert.equal(h.income, 500000); assert.equal(h.expense, 120000);
  const mm = h.accounts.find((a) => a.name === 'Mobile Money'); assert.equal(mm.balance, 200000);
  assert.equal(h.accounts.find((a) => a.id === 'wallindirain').balance, 180000);
  await pair(w.seller, 'deposit', 50000);
  h = await home(s); assert.equal(h.accounts.find((a) => a.name === 'Mobile Money').balance, 150000);
  assert.equal(h.balance, 480000);
  await pair(w.seller, 'withdrawal_refund', 50000);   // retrait refusé : l'argent revient
  h = await home(s); assert.equal(h.balance, 480000);
});

test('budgets et plan comptent les dépenses automatiques ; une entrée pas encore disponible n\'apparaît pas', async () => {
  await s.post('/api/pf/budgets', { category: 'business', amount: 200000 });
  assert.equal((await s.get('/api/pf/plan')).json.budgets[0].spent, 120000);
  await db.owner.query(`INSERT INTO wallet_entries(user_id, kind, amount, description, available_at) VALUES ($1,'seller_gain',77000,'plus tard', now() + interval '3 days')`, [w.seller]);
  await db.owner.query(`INSERT INTO wallet_entries(user_id, kind, amount, description) VALUES ($1,'seller_gain',-77000,'annule plus tard')`, [SYS]);
  assert.equal((await home(s)).income, 500000, 'en attente : pas encore compté');
});

test('isolation : chacun ne voit que son activité ; le portefeuille n\'est jamais modifié', async () => {
  await pair(w.seller2, 'seller_gain', 999000);
  assert.equal((await home(s2)).balance, 0, 'seller2 n\'a rien relié');
  assert.equal((await s2.post('/api/pf/wallet-link', {})).status, 200);
  assert.equal((await home(s2)).balance, 999000);
  assert.equal((await home(s)).balance, 480000);
  assert.equal((await s.post('/api/pf/wallet-link', { account_id: (await home(s2)).accounts[0].id })).status, 404, 'pas le compte d\'un autre');
  const after = (await rows('SELECT count(*)::int AS n, COALESCE(sum(amount),0)::text AS t FROM wallet_entries'))[0];
  assert.ok(Number(after.n) >= Number(snap.n));
  assert.equal((await rows('SELECT count(*)::int AS n FROM fn_ledger_check()'))[0].n, 0, 'grand livre équilibré');
});

test('rôle sans portefeuille refusé ; formule gratuite refusée ; délier retire le compte automatique', async () => {
  const wh = await login(w.warehouse);
  assert.equal((await wh.post('/api/pf/wallet-link', {})).status, 403);
  await setPrice(5000); await db.owner.query('DELETE FROM pf_access');
  const r = await courier.post('/api/pf/wallet-link', {}); assert.equal(r.status, 403); assert.equal(r.json.error, 'pro_required');
  assert.equal((await home(s)).accounts.some((a) => a.id === 'wallindirain'), true, 'déjà relié : continue');
  await setPrice(0);
  assert.equal((await s.post('/api/pf/wallet-unlink')).status, 200);
  const h = await home(s);
  assert.equal(h.accounts.some((a) => a.id === 'wallindirain'), false);
  assert.equal(h.balance, 100000, 'seuls les comptes et transactions saisis à la main restent : les virements automatiques disparaissent avec la liaison');
  assert.equal((await s.get('/api/pf/status')).json.wallet.linked, false);
});

test('droits : la vue est en lecture seule, les fonctions internes inaccessibles', async () => {
  await assert.rejects(db.app.query(`INSERT INTO pf_all_tx(id) VALUES ('x')`), /permission denied|cannot insert/i);
  await assert.rejects(db.app.query(`UPDATE pf_prefs SET wallet_linked = true`), /permission denied/i);
  const r = await db.app.query(`SELECT count(*)::int AS n FROM pf_all_tx WHERE owner_id = $1`, [w.seller]); assert.ok(r.rows[0].n >= 0);
});

test('retour arrière 051 : refusé si relié, accepté sinon ; le registre est nettoyé', async () => {
  const rb = ['056', '055', '054', '051'].map((n) => fs.readFileSync(path.join(root, 'docs', `retour-arriere-${n}.sql`), 'utf8')).join('\n');   // les réglages, catégories et devises se défont avant
  const run = async () => { await db.owner.query('BEGIN'); try { for (const q of splitSql(rb)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT'); } catch (e) { await db.owner.query('ROLLBACK'); throw e; } };
  await assert.rejects(run, /sont reliés à Mes finances/);
  await db.owner.query('UPDATE pf_prefs SET wallet_linked = false');
  await run();
  assert.equal((await rows(`SELECT count(*)::int AS n FROM information_schema.views WHERE table_name = 'pf_all_tx'`))[0].n, 0);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'pf_prefs' AND column_name LIKE 'wallet%'`))[0].n, 0);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '051_finances_wallindirain_auto.sql'`))[0].n, 0);
});
