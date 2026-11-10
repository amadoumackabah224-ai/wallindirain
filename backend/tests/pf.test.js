// 048 : Mes finances (comptes personnels, transactions, formules gratuite et Pro), droits, retour arrière.
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
let s, s2, admin, courier, agent, wh, sup;

before(async () => {
  db = await freshDb('wld_pf'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_pf', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
  s = await login(w.seller); s2 = await login(w.seller2); admin = await login(w.admin); courier = await login(w.courier); agent = await login(w.agent1); wh = await login(w.warehouse); sup = await login(w.supplier);
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });


const acc = (c, body) => c.post('/api/pf/accounts', body);
const tx = (c, body) => c.post('/api/pf/transactions', { kind: 'expense', category: 'food', occurred_on: dayStr(0), ...body });
const home = async (c, q = '') => (await c.get(`/api/pf/home${q}`)).json;
const price = (monthly, yearly = 0, trial = 14) => db.owner.query(`UPDATE settings SET value = CASE key WHEN 'pf_price_monthly' THEN $1::numeric WHEN 'pf_price_yearly' THEN $2::numeric WHEN 'pf_trial_days' THEN $3::numeric ELSE value END WHERE key IN ('pf_price_monthly','pf_price_yearly','pf_trial_days')`, [monthly, yearly, trial]);
let before0;

test('éteint par défaut : rien n\'est disponible et aucune donnée n\'est créée', async () => {
  assert.equal((await s.get('/api/pf/status')).json.enabled, false);
  assert.equal((await s.get('/api/pf/home')).json.enabled, false);
  assert.equal((await acc(s, { name: 'Espèces', kind: 'cash' })).status, 403);
  await expectErr(call(db.app, 'fn_pf_account_save', w.seller, null, 'Espèces', 'cash', 'blue', 0, null), 'feature_off');
  assert.equal((await rows('SELECT count(*)::int AS n FROM pf_accounts'))[0].n, 0);
  assert.equal((await db.owner.query(`UPDATE settings SET value = 1 WHERE key = 'feature_finances_perso'`)).rowCount, 1);
  before0 = await walletTotals();
});

test('tous les rôles peuvent ouvrir des comptes ; chacun ne voit que les siens', async () => {
  for (const [c, name] of [[s, 'Vendeur'], [s2, 'Vendeur 2'], [courier, 'Livreur'], [agent, 'Agent'], [wh, 'Magasinier'], [sup, 'Fournisseur'], [admin, 'Admin']]) {
    const r = await acc(c, { name: `Orange Money ${name}`, kind: 'mobile_money', color: 'orange', opening_balance: 10000 });
    assert.equal(r.status, 201, name);
  }
  assert.equal((await s.get('/api/pf/accounts')).json.accounts.length, 1);
  assert.equal((await courier.get('/api/pf/accounts')).json.accounts.length, 1);
  const other = (await s2.get('/api/pf/accounts')).json.accounts[0].id;
  assert.equal((await s.post(`/api/pf/accounts/${other}/archive`, { archived: true })).status, 404, 'pas le compte d\'un autre');
  assert.equal((await acc(s, { id: other, name: 'Volé', kind: 'cash' })).status, 404);
  assert.equal((await tx(s, { account_id: other, amount: 100 })).status, 404);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM pf_transactions`))[0].n, 0);
});

test('comptes : validations, doublons, archivage sans suppression', async () => {
  assert.equal((await acc(s, { name: 'x', kind: 'cash' })).status, 400);
  assert.equal((await acc(s, { name: 'Espèces', kind: 'coffre' })).status, 400);
  assert.equal((await acc(s, { name: 'Espèces', kind: 'cash', color: 'rose' })).status, 400);
  assert.equal((await acc(s, { name: 'orange money vendeur', kind: 'cash' })).status, 409, 'même nom (casse ignorée)');
  const e = await acc(s, { name: 'Espèces', kind: 'cash', color: 'green', opening_balance: 50000 }); assert.equal(e.status, 201);
  assert.equal((await acc(s, { id: e.json.id, name: 'Caisse', kind: 'cash', color: 'green', opening_balance: 60000 })).status, 200);
  assert.equal((await s.post(`/api/pf/accounts/${e.json.id}/archive`, { archived: true })).status, 200);
  const list = (await s.get('/api/pf/accounts')).json.accounts;
  assert.equal(list.length, 2); assert.ok(list.find((a) => a.id === e.json.id).archived_at, 'archivé, pas supprimé');
  assert.equal((await tx(s, { account_id: e.json.id, amount: 100 })).status, 404, 'pas de transaction sur un compte archivé');
  assert.equal((await s.post(`/api/pf/accounts/${e.json.id}/archive`, { archived: false })).status, 200);
});

test('transactions : revenu, dépense, soldes, modification, annulation, catégories et dates contrôlées', async () => {
  const [om, cash] = (await s.get('/api/pf/accounts')).json.accounts;
  assert.equal(om.balance, 10000); assert.equal(cash.balance, 60000);
  assert.equal((await tx(s, { account_id: om.id, kind: 'income', category: 'sales', amount: 25000 })).status, 201);
  const d = await tx(s, { account_id: om.id, amount: 4000, note: 'Déjeuner' }); assert.equal(d.status, 201);
  assert.equal((await s.get('/api/pf/accounts')).json.accounts.find((a) => a.id === om.id).balance, 31000);
  assert.equal((await tx(s, { account_id: om.id, amount: 0 })).status, 400);
  assert.equal((await tx(s, { account_id: om.id, amount: 100, category: 'sales' })).status, 400, 'catégorie de revenu sur une dépense');
  assert.equal((await tx(s, { account_id: om.id, amount: 100, occurred_on: dayStr(10) })).status, 400, 'pas dans le futur lointain');
  assert.equal((await tx(s, { account_id: om.id, amount: 100, occurred_on: 'hier' })).status, 400);
  assert.equal((await s.post(`/api/pf/transactions/${d.json.id}/update`, { account_id: cash.id, amount: 5000, category: 'transport', note: '', occurred_on: dayStr(0) })).status, 200);
  assert.equal((await s.get('/api/pf/accounts')).json.accounts.find((a) => a.id === cash.id).balance, 55000);
  assert.equal((await s.post(`/api/pf/transactions/${d.json.id}/void`)).status, 200);
  assert.equal((await s.get('/api/pf/accounts')).json.accounts.find((a) => a.id === cash.id).balance, 60000);
  assert.equal((await rows('SELECT count(*)::int AS n FROM pf_transactions WHERE voided_at IS NOT NULL'))[0].n, 1, 'annulée, pas supprimée');
  assert.equal((await s2.post(`/api/pf/transactions/${d.json.id}/void`)).status, 404);
  assert.equal((await s.get('/api/pf/transactions')).json.transactions.length, 1);
});

test('virement : déplace l\'argent entre deux comptes sans changer revenus ni dépenses, s\'annule des deux côtés', async () => {
  const [om, cash] = (await s.get('/api/pf/accounts')).json.accounts;
  const h0 = await home(s);
  const t = await s.post('/api/pf/transfers', { from: om.id, to: cash.id, amount: 10000, occurred_on: dayStr(0) }); assert.equal(t.status, 201);
  const h1 = await home(s);
  assert.equal(h1.balance, h0.balance); assert.equal(h1.income, h0.income); assert.equal(h1.expense, h0.expense);
  assert.equal(h1.accounts.find((a) => a.id === om.id).balance, h0.accounts.find((a) => a.id === om.id).balance - 10000);
  assert.equal((await s.post('/api/pf/transfers', { from: om.id, to: om.id, amount: 1, occurred_on: dayStr(0) })).status, 400);
  const other = (await s2.get('/api/pf/accounts')).json.accounts[0].id;
  assert.equal((await s.post('/api/pf/transfers', { from: om.id, to: other, amount: 1, occurred_on: dayStr(0) })).status, 404, 'pas vers le compte d\'un autre');
  const row = (await s.get('/api/pf/transactions?kind=transfer')).json.transactions[0];
  assert.equal((await s.post(`/api/pf/transactions/${row.id}/update`, { account_id: om.id, amount: 5, category: 'food', occurred_on: dayStr(0) })).status, 409, 'un virement ne se modifie pas');
  assert.equal((await s.post(`/api/pf/transactions/${row.id}/void`)).status, 200);
  assert.equal((await rows('SELECT count(*)::int AS n FROM pf_transactions WHERE transfer_id = $1 AND voided_at IS NOT NULL', [row.transfer_id]))[0].n, 2);
  assert.equal((await home(s)).accounts.find((a) => a.id === om.id).balance, h0.accounts.find((a) => a.id === om.id).balance);
});

test('tableau de bord : jauges, courbe du solde (dernier point = solde), catégories, compte Wallindirain en lecture seule', async () => {
  const [om] = (await s.get('/api/pf/accounts')).json.accounts;
  await tx(s, { account_id: om.id, kind: 'income', category: 'salary', amount: 100000, occurred_on: dayStr(-3) });
  await tx(s, { account_id: om.id, category: 'transport', amount: 20000, occurred_on: dayStr(-1) });
  const h = await home(s);
  assert.equal(h.series.length, 30); assert.equal(h.series.at(-1).balance, h.balance);
  assert.equal(h.series.at(-1).day, dayStr(0));
  assert.ok(h.series.every((p, i, a) => i === 0 || typeof p.balance === 'number'));
  assert.equal(h.series.find((p) => p.day === dayStr(-4)).balance, h.balance - (100000 - 20000 + 25000), 'avant le salaire');
  assert.ok(h.gauges.income >= 0 && h.gauges.income <= 1 && h.gauges.flow >= 0 && h.gauges.flow <= 1 && h.gauges.balance >= 0 && h.gauges.balance <= 1);
  assert.ok(h.expense_by_category.find((c) => c.category === 'transport').total === 20000);
  assert.deepEqual(Object.keys(h.wallindirain).sort(), ['available', 'pending']);
  const empty = await home(s2);
  assert.equal(empty.gauges.flow, 0.5, 'rien ne bouge : aiguille au centre');
  assert.equal((await s.post('/api/pf/prefs', { income_target: 500000, balance_target: 1000000 })).status, 200);
  assert.equal((await home(s)).targets.income, 500000);
  assert.equal((await s.post('/api/pf/prefs', { income_target: -5 })).status, 400);
});

test('aucune écriture du portefeuille de la plateforme n\'est créée par la gestion personnelle', async () => {
  const now = await walletTotals();
  assert.deepEqual(now, before0);
  assert.equal((await rows('SELECT count(*)::int AS n FROM fn_ledger_check()'))[0].n, 0);
});

test('formule gratuite : limites de comptes et d\'historique, anciens comptes lisibles, rien n\'est supprimé', async () => {
  // l'essai est fini ; un prix est fixé
  await db.owner.query(`UPDATE pf_access SET trial_until = now() - interval '1 day'`);
  await price(30000, 250000, 14);
  // le vendeur a 2 comptes (le premier et « Caisse »), tous deux actifs ; la limite gratuite est 2
  const st = (await s.get('/api/pf/status')).json; assert.equal(st.tier, 'free'); assert.equal(st.priced, true);
  assert.equal((await acc(s, { name: 'Épargne', kind: 'savings' })).status, 403, 'troisième compte refusé');
  assert.equal((await acc(s, { name: 'Épargne', kind: 'savings' })).json.error, 'pro_required');
  // un vieil historique est caché (pas supprimé)
  const [om] = (await s.get('/api/pf/accounts')).json.accounts;
  await db.owner.query(`INSERT INTO pf_transactions(owner_id, account_id, kind, amount, category, occurred_on) VALUES ($1, $2, 'expense', 777, 'food', current_date - 200)`, [w.seller, om.id]);
  assert.ok(!(await s.get('/api/pf/transactions')).json.transactions.some((t) => t.amount === 777));
  assert.equal((await s.get('/api/pf/transactions')).json.history_limited, 90);
  assert.equal((await rows('SELECT count(*)::int AS n FROM pf_transactions WHERE amount = 777'))[0].n, 1);
  // la courbe gratuite est limitée à 30 jours
  assert.equal((await home(s, '?days=365')).days, 30);
  // comptes au-delà de la limite : un 3e compte créé avant le prix reste lisible mais en lecture seule
  await db.owner.query(`INSERT INTO pf_accounts(owner_id, name, kind, created_at) VALUES ($1, 'Ancien compte', 'other', now() + interval '1 hour')`, [w.seller]);
  const ancien = (await s.get('/api/pf/accounts')).json.accounts.find((a) => a.name === 'Ancien compte');
  assert.equal(ancien.writable, false); assert.equal(ancien.balance, 0);
  const r = await tx(s, { account_id: ancien.id, amount: 100 }); assert.equal(r.status, 403); assert.equal(r.json.error, 'pro_required');
  assert.equal((await tx(s, { account_id: om.id, amount: 100 })).status, 201, 'les deux premiers comptes restent utilisables');
});

test('abonnement Pro : prélevé sur le portefeuille, s\'additionne, ne touche aucun autre compte, comptes équilibrés', async () => {
  assert.equal((await s.post('/api/pf/subscribe', { plan: 'monthly' })).status, 409, 'solde insuffisant');
  await db.owner.query(`INSERT INTO wallet_entries(user_id, kind, amount, description) VALUES ($1, 'deposit', 300000, 'test')`, [w.seller]);
  await db.owner.query(`INSERT INTO wallet_entries(user_id, kind, amount, description) VALUES ('00000000-0000-0000-0000-000000000001', 'deposit', -300000, 'contrepartie test')`);
  const p1 = (await s.post('/api/pf/subscribe', { plan: 'monthly' })); assert.equal(p1.status, 200);
  const sum = async (u) => Number((await rows('SELECT COALESCE(sum(amount),0)::bigint AS t FROM wallet_entries WHERE user_id = $1', [u]))[0].t);
  assert.equal(await sum(w.seller), 270000);
  const st = (await s.get('/api/pf/status')).json; assert.equal(st.tier, 'pro'); assert.equal(st.on_trial, false);
  const p2 = (await s.post('/api/pf/subscribe', { plan: 'yearly' })); assert.equal(p2.status, 200);
  assert.ok(Date.parse(p2.json.paid_until) - Date.parse(p1.json.paid_until) > 360 * 86_400_000, 'l\'année s\'ajoute à la suite');
  assert.equal(await sum(w.seller), 20000);
  assert.equal((await s.post('/api/pf/subscribe', { plan: 'weekly' })).status, 400);
  assert.equal((await rows('SELECT count(*)::int AS n FROM fn_ledger_check()'))[0].n, 0);
  // Pro : la limite de comptes disparaît
  assert.equal((await acc(s, { name: 'Épargne', kind: 'savings' })).status, 201);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM wallet_entries WHERE kind = 'pf_subscription'`))[0].n, 4);
  // un livreur peut aussi s'abonner ; une facture de services de vendeur ne contient pas cet abonnement
  assert.equal((await courier.post('/api/pf/subscribe', { plan: 'monthly' })).status, 409);
});

test('administrateur : offrir ou encaisser hors plateforme (note obligatoire), liste des abonnés, droits', async () => {
  assert.equal((await s.post('/api/admin/pf/grant', { user_id: w.courier, months: 1, note: 'ok ok' })).status, 403);
  assert.equal((await admin.post('/api/admin/pf/grant', { user_id: w.courier, months: 1, note: '' })).status, 400);
  assert.equal((await admin.post('/api/admin/pf/grant', { user_id: w.courier, months: 3, note: 'Paiement reçu en espèces' })).status, 200);
  assert.equal((await courier.get('/api/pf/status')).json.tier, 'pro');
  const l = (await admin.get('/api/admin/pf')).json;
  assert.equal(l.settings.pf_free_accounts, 2); assert.ok(l.users.some((u) => u.id === w.courier));
  assert.equal((await s.get('/api/admin/pf')).status, 403);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'pf_granted'`))[0].n, 1);
});

test('droits de la base : fonctions accordées, fonctions internes fermées, tables non modifiables directement', async () => {
  for (const f of ['fn_pf_account_save', 'fn_pf_tx_add', 'fn_pf_transfer', 'fn_pf_subscribe', 'fn_admin_pf_grant', 'fn_pf_tier']) {
    assert.equal((await rows(`SELECT has_function_privilege('wld_app', p.oid, 'EXECUTE') AS ok FROM pg_proc p WHERE proname = $1`, [f]))[0].ok, true, f);
  }
  for (const f of ['_pf_tier', '_pf_actor', '_pf_touch', '_pf_check_tx']) assert.equal((await rows(`SELECT has_function_privilege('wld_app', p.oid, 'EXECUTE') AS ok FROM pg_proc p WHERE proname = $1`, [f]))[0].ok, false, f);
  await assert.rejects(db.app.query(`INSERT INTO pf_accounts(owner_id, name, kind) VALUES ($1, 'Triche', 'cash')`, [w.seller]), /permission denied/);
  await assert.rejects(db.app.query(`UPDATE pf_transactions SET amount = 1`), /permission denied/);
  // fonction appelée par un rôle non autorisé / compte inactif
  await expectErr(call(db.app, 'fn_pf_account_save', '00000000-0000-0000-0000-000000000099', null, 'Fantôme', 'cash', 'blue', 0, null), 'forbidden');
});

test('un compte anonymisé perd ses données de finances personnelles', async () => {
  const u = (await call(db.app, 'fn_register', '622' + String(Math.floor(Math.random() * 900000) + 100000), 'Fournisseur Test', 'supplier', 'x', 'CNI-777777'));
  await db.owner.query(`UPDATE users SET status = 'active', password_hash = $2 WHERE id = $1`, [u, await hashPassword(PW)]);
  const c = await login(u);
  const a = await acc(c, { name: 'Espèces', kind: 'cash' }); assert.equal(a.status, 201);
  await tx(c, { account_id: a.json.id, amount: 500 });
  await call(db.app, 'fn_admin_anonymize_user', w.admin, u);
  for (const t of ['pf_accounts', 'pf_transactions', 'pf_access']) assert.equal((await rows(`SELECT count(*)::int AS n FROM ${t} WHERE owner_id = $1`, [u]))[0].n, 0, t);
});

test('retour arrière 048 : refusé s\'il existe des données ou si la fonction est allumée, accepté sinon', async () => {
  const rb60 = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-060.sql'), 'utf8');
  await db.owner.query('BEGIN'); for (const q of splitSql(rb60)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT');
  const rb59 = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-059.sql'), 'utf8');
  await db.owner.query('BEGIN'); for (const q of splitSql(rb59)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT');
  const rb58 = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-058.sql'), 'utf8');
  await db.owner.query('BEGIN'); for (const q of splitSql(rb58)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT');
  const rb57 = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-057.sql'), 'utf8');
  await db.owner.query('BEGIN'); for (const q of splitSql(rb57)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT');   // la 057 se défait avant la 056
  const rb56 = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-056.sql'), 'utf8');
  await db.owner.query('BEGIN'); for (const q of splitSql(rb56)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT');   // la 056 se défait avant la 055
  const rb55 = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-055.sql'), 'utf8');
  await db.owner.query('BEGIN'); for (const q of splitSql(rb55)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT');   // la 055 se défait avant la 054
  const rb54 = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-054.sql'), 'utf8');
  await db.owner.query('BEGIN'); for (const q of splitSql(rb54)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT');   // la 054 se défait avant la 053
  const rb53 = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-053.sql'), 'utf8');
  await db.owner.query('BEGIN'); for (const q of splitSql(rb53)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT');   // la 053 se défait avant la 051
  const rb51 = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-051.sql'), 'utf8');
  await db.owner.query('BEGIN'); for (const q of splitSql(rb51)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT');   // la 051 se défait avant la 050
  const rb50 = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-050.sql'), 'utf8');
  await db.owner.query('BEGIN'); for (const q of splitSql(rb50)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT');   // la 050 se défait avant la 049
  const rb49 = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-049.sql'), 'utf8');
  const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-048.sql'), 'utf8');
  await db.owner.query('BEGIN'); for (const q of splitSql(rb49)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT');   // la 049 se défait avant la 048
  const run = async () => { await db.owner.query('BEGIN'); try { for (const q of splitSql(rb)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT'); } catch (e) { await db.owner.query('ROLLBACK'); throw e; } };
  await assert.rejects(run, /des données de Mes finances existent/);
  for (const t of ['pf_transactions', 'pf_prefs', 'pf_accounts', 'pf_access']) await db.owner.query(`DELETE FROM ${t}`);
  await assert.rejects(run, /éteignez d'abord la fonction/);
  await db.owner.query(`UPDATE settings SET value = 0 WHERE key = 'feature_finances_perso'`);
  await run();
  assert.equal((await rows(`SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE '%pf\\_%'`))[0].n, 0);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM settings WHERE key LIKE 'pf\\_%' OR key = 'feature_finances_perso'`))[0].n, 0);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '048_finances_perso.sql'`))[0].n, 0);
});
