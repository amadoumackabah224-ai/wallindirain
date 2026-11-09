// 054 : profil et catégories modifiables (arbre système, catégories de la personne, masquage, limite gratuite, retour arrière).
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
  db = await freshDb('wld_pfc'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_pfc', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
  s = await login(w.seller); s2 = await login(w.seller2); courier = await login(w.courier);
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });


const acc = (c, body) => c.post('/api/pf/accounts', body);
const tx = (c, body) => c.post('/api/pf/transactions', { kind: 'expense', category: 'food', occurred_on: dayStr(0), ...body });
const cats = async (c) => (await c.get('/api/pf/categories')).json;
const setPrice = (m) => db.owner.query(`UPDATE settings SET value = $1 WHERE key = 'pf_price_monthly'`, [m]);
let accId;

test('éteint : rien n\'est disponible ; allumé : l\'arbre système est servi', async () => {
  assert.equal((await cats(s)).enabled, false);
  assert.equal((await s.post('/api/pf/profile', { profile: 'business' })).status, 403);
  await db.owner.query(`UPDATE settings SET value = 1 WHERE key = 'feature_finances_perso'`);
  await setPrice(5000);
  accId = (await acc(s, { name: 'Espèces', kind: 'cash', opening_balance: 1000000 })).json.id;
  const c = await cats(s);
  assert.equal(c.profile, null);
  const by = Object.fromEntries(c.items.map((i) => [i.key, i]));
  for (const k of ['sales', 'food', 'financing', 'space', 'payroll', 'stock', 'opsvc', 'bills', 'debt_repay']) assert.ok(by[k], k);
  assert.equal(by.energy.parent, 'space'); assert.equal(by.employees.parent, 'payroll');
  assert.equal(by.financing.operating, false); assert.equal(by.repay_loan.kind, 'expense');
  assert.equal(by.sales_product.kind, 'income');
});

test('transactions : anciennes et nouvelles catégories acceptées, mauvais type ou clé inconnue refusés', async () => {
  assert.equal((await tx(s, { account_id: accId, amount: 1000 })).status, 201);
  assert.equal((await tx(s, { account_id: accId, amount: 1000, category: 'energy' })).status, 201);
  assert.equal((await tx(s, { account_id: accId, amount: 1000, kind: 'income', category: 'sales_service' })).status, 201);
  assert.equal((await tx(s, { account_id: accId, amount: 1000, category: 'sales_service' })).status, 400, 'revenu utilisé comme dépense');
  assert.equal((await tx(s, { account_id: accId, amount: 1000, category: 'nimporte' })).status, 400);
  assert.equal((await tx(s, { account_id: accId, amount: 1000, category: 'Bad Key!' })).status, 400);
  assert.equal((await s.post('/api/pf/budgets', { category: 'stock', amount: 50000 })).status, 200);
});

test('profil : choix, validation, isolation', async () => {
  assert.equal((await s.post('/api/pf/profile', { profile: 'x' })).status, 400);
  assert.equal((await s.post('/api/pf/profile', { profile: 'business' })).status, 200);
  assert.equal((await cats(s)).profile, 'business');
  assert.equal((await cats(courier)).profile, null);
  await s.post('/api/pf/prefs', { income_target: 100 });
  assert.equal((await cats(s)).profile, 'business', 'les objectifs ne touchent pas au profil');
});

test('catégories de la personne : ajout sous un groupe, 3 niveaux au plus, doublons, isolation, usage dans une transaction', async () => {
  const a = await s.post('/api/pf/categories', { parent: 'employees', label: 'Mariama Diallo', icon: '👩' });
  assert.equal(a.status, 201); const key = a.json.key; assert.match(key, /^c_[0-9a-f]+$/);
  assert.equal((await tx(s, { account_id: accId, amount: 2000, category: key })).status, 201);
  assert.equal((await s.post('/api/pf/categories', { parent: 'employees', label: 'mariama diallo' })).status, 409, 'doublon');
  assert.equal((await s.post('/api/pf/categories', { parent: 'payroll', label: 'Employés' })).status, 409, 'même nom qu\'une catégorie système');
  // niveau 3 (sous un élément ajouté) refusé : employees (2) > Mariama (3)
  assert.equal((await s.post('/api/pf/categories', { parent: key, label: 'Prime' })).status, 400);
  assert.equal((await s.post('/api/pf/categories', { parent: 'inconnue', label: 'X' })).status, 404);
  assert.equal((await s.post('/api/pf/categories', { label: 'X' })).status, 400, 'nouveau groupe : type obligatoire');
  const g = await s.post('/api/pf/categories', { kind: 'income', label: 'Mon groupe' });
  assert.equal(g.status, 201);
  assert.equal((await s.post('/api/pf/categories', { parent: g.json.key, label: 'Sous-groupe' })).status, 201);
  // isolation : l'autre vendeur ne la voit pas et ne peut pas l'utiliser
  assert.equal((await cats(s2)).items.some((i) => i.key === key), false);
  assert.equal((await tx(s2, { account_id: (await acc(s2, { name: 'E', kind: 'cash' })).json.id, amount: 100, category: key })).status, 400);
  assert.equal((await s2.post(`/api/pf/categories/${key}`, { label: 'Pirate' })).status, 404);
});

test('modifier : renommer et changer l\'icône d\'une catégorie système (pour soi seulement), masquer sans rien perdre', async () => {
  assert.equal((await s.post('/api/pf/categories/food', { label: 'Courses', icon: '🥖' })).status, 200);
  const mine = (await cats(s)).items.find((i) => i.key === 'food');
  assert.equal(mine.label, 'Courses'); assert.equal(mine.icon, '🥖'); assert.equal(mine.default_label, 'Alimentation');
  assert.equal((await cats(s2)).items.find((i) => i.key === 'food').label, 'Alimentation');
  assert.equal((await s.post('/api/pf/categories/food', { hidden: true })).status, 200);
  assert.equal((await cats(s)).items.find((i) => i.key === 'food').hidden, true);
  assert.equal((await cats(s)).items.find((i) => i.key === 'food').label, 'Alimentation', 'nom vide = nom d\'origine');
  // l'ancienne transaction reste lisible et une nouvelle reste possible (masquer = ne plus proposer)
  assert.equal((await tx(s, { account_id: accId, amount: 10, category: 'food' })).status, 201);
  assert.equal((await s.post('/api/pf/categories/nimporte', { label: 'x' })).status, 404);
});

test('formule gratuite : limite de catégories ajoutées ; Pro : illimité', async () => {
  await setPrice(5000);
  await db.owner.query(`UPDATE settings SET value = 2 WHERE key = 'pf_free_categories'`);
  const before = (await db.owner.query(`SELECT count(*)::int AS n FROM pf_cat_custom WHERE owner_id = $1 AND archived_at IS NULL`, [w.seller2])).rows[0].n;
  let last; for (let i = 0; i < 3; i++) last = await s2.post('/api/pf/categories', { parent: 'travel', label: `Lieu ${i}` });
  assert.equal(last.status, 409); assert.equal(last.json.error, 'limit');
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM pf_cat_custom WHERE owner_id = $1`, [w.seller2])).rows[0].n, before + 2);
  // renommer une catégorie système reste libre dans la formule gratuite
  assert.equal((await s2.post('/api/pf/categories/travel', { label: 'Déplacements' })).status, 200);
  await setPrice(0);
  assert.equal((await s2.post('/api/pf/categories', { parent: 'travel', label: 'Lieu 9' })).status, 201);
});

test('anonymisation : les catégories de la personne disparaissent', async () => {
  await db.owner.query(`UPDATE users SET deleted_at = now() WHERE id = $1`, [w.seller2]);
  for (const t of ['pf_cat_custom', 'pf_cat_override']) assert.equal((await rows(`SELECT count(*)::int AS n FROM ${t} WHERE owner_id = $1`, [w.seller2]))[0].n, 0, t);
});

test('droits : tables non modifiables par l\'application, fonctions internes fermées', async () => {
  await assert.rejects(db.app.query(`INSERT INTO pf_cat_custom(owner_id,key,kind,label) VALUES ($1,'x','income','x')`, [w.seller]), /permission denied/);
  await assert.rejects(db.app.query(`UPDATE pf_cat_system SET label = 'x'`), /permission denied/);
  await assert.rejects(db.app.query(`SELECT _pf_cat_ok($1,'expense','food')`, [w.seller]), /permission denied/);
  await db.app.query(`SELECT fn_pf_profile_set($1,'both')`, [w.seller]);
});

test('retour arrière 054 : refusé s\'il existe des données personnalisées ou des nouvelles catégories, accepté sinon', async () => {
  const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-054.sql'), 'utf8');
  const run = async () => { await db.owner.query('BEGIN'); try { for (const q of splitSql(rb)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT'); } catch (e) { await db.owner.query('ROLLBACK'); throw e; } };
  await assert.rejects(run, /personnalisés existent/);
  await db.owner.query(`DELETE FROM pf_cat_custom`); await db.owner.query(`DELETE FROM pf_cat_override`); await db.owner.query(`UPDATE pf_prefs SET profile = NULL`);
  await assert.rejects(run, /nouvelles catégories/);
  await db.owner.query(`DELETE FROM pf_transactions WHERE category NOT IN ('sales','salary','gift','other_in','food','transport','housing','telecom','health','family','business','shopping','savings','other_out','transfer')`);
  await db.owner.query(`DELETE FROM pf_budgets WHERE category = 'stock'`);
  await run();
  assert.equal((await rows(`SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('_pf_cat_ok','fn_pf_cat_add','fn_pf_cat_edit','fn_pf_profile_set')`))[0].n, 0);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '054_categories.sql'`))[0].n, 0);
  assert.equal((await tx(s, { account_id: accId, amount: 5 })).status, 201, 'les anciennes catégories fonctionnent toujours');
  assert.equal((await tx(s, { account_id: accId, amount: 5, category: 'energy' })).status, 400);
});
