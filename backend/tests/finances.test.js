// 045 : tableau argent du vendeur (prévision, dépenses récurrentes, budget, objectif), droits, retour arrière.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshDb, TEST_DB, APP_PW, world, call, expectErr, deliver } from './helpers.js';
import { splitSql } from '../src/migrate.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';
import { occurrences, forecast } from '../src/finances.js';

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
let s, s2, admin, courier, seen;

before(async () => {
  db = await freshDb('wld_finances'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_finances', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
  s = await login(w.seller); s2 = await login(w.seller2); admin = await login(w.admin); courier = await login(w.courier);
  // deux commandes livrées (gains réels), une en cours
  for (const ph of ['622000001', '622000002']) { const o = await place(s, { customer_phone: ph }); await deliver(db, w, o.id, o.ref); }
  await place(s, { customer_phone: '622000003' });
  seen = await walletTotals();
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });

test('échéances : jour, semaine, mois (jamais avant la première échéance), et calcul de la prévision', () => {
  const day = (d) => Date.parse(`${d}T00:00:00Z`);
  const from = day('2026-11-05');
  assert.equal(occurrences({ frequency: 'daily', anchor_on: '2026-10-01' }, from, day('2026-11-08')).join(), '2026-11-06,2026-11-07,2026-11-08');
  assert.equal(occurrences({ frequency: 'weekly', anchor_on: '2026-10-01' }, from, day('2026-11-20')).join(), '2026-11-05'.replace('05', '05') && '2026-11-12,2026-11-19'); // jeudis
  assert.equal(occurrences({ frequency: 'monthly', anchor_on: '2026-09-10' }, from, day('2027-01-31')).join(), '2026-11-10,2026-12-10,2027-01-10');
  assert.equal(occurrences({ frequency: 'monthly', anchor_on: '2027-01-10' }, from, day('2027-02-28')).join(), '2027-01-10,2027-02-10', 'rien avant la première échéance');
  assert.equal(occurrences({ frequency: 'daily', anchor_on: '2026-12-01' }, from, day('2026-11-30')).length, 0);
  // prévision : certain = disponible - réservé + gains débloqués - récurrents ; estimé = en cours × gain moyen × taux
  const now = Date.parse('2026-11-05T10:00:00Z');
  const f = forecast({ now, available: 100_000, reserved: 20_000, locked: [{ amount: 30_000, available_at: '2026-11-10 08:00:00+00' }, { amount: 50_000, available_at: '2027-02-01 08:00:00+00' }],
    inProgress: 10, avgGain: 10_000, rate: 60, recurring: [{ frequency: 'monthly', anchor_on: '2026-09-10', amount: 5_000 }] });
  assert.deepEqual(f.map((x) => x.days), [30, 60, 90]);
  assert.equal(f[0].certain, 100_000 - 20_000 + 30_000 - 5_000, '30 jours : un seul prélèvement mensuel (10 novembre) ; le gain de février n\'est pas encore débloqué');
  assert.equal(f[0].mid - f[0].certain, 60_000); assert.equal(f[0].low - f[0].certain, 45_000); assert.equal(f[0].high - f[0].certain, 70_000);
  assert.equal(f[1].out, 10_000); assert.equal(f[2].out, 15_000);
  assert.ok(f.every((x) => x.low <= x.mid && x.mid <= x.high));
  assert.equal(forecast({ now, available: 0, reserved: 0, locked: [], inProgress: 5, avgGain: 1000, rate: 100, recurring: [] })[0].high, 5000, 'jamais plus que 100 %');
});

test('éteint au départ : aucun accès tant que l\'administrateur ne l\'allume pas', async () => {
  assert.deepEqual((await s.get('/api/seller/finances')).json, { enabled: false });
  const r = await s.post('/api/seller/finances/goal', { target: 100000 });
  assert.equal(r.status, 403); assert.equal(r.json.error, 'feature_off');
  assert.equal((await s.post('/api/seller/finances/recurring', { label: 'Pub', category: 'ads', amount: 1000, frequency: 'daily', anchor_on: dayStr(1) })).json.error, 'feature_off');
  assert.equal((await s.post('/api/admin/settings', { key: 'feature_finances', value: 1 })).status, 403);
  assert.equal((await admin.post('/api/admin/settings', { key: 'feature_finances', value: 1 })).status, 200);
  assert.equal((await s.get('/api/seller/finances')).json.enabled, true);
  assert.equal((await courier.get('/api/seller/finances')).status, 403, 'réservé aux vendeurs');
  assert.equal((await new Client().get('/api/seller/finances')).status, 401);
});

test('aperçu : solde, gains, commandes en cours, estimation et taux (réel, réglé, par défaut)', async () => {
  const o = (await s.get('/api/seller/finances')).json;
  const entries = await rows(`SELECT amount::bigint AS a, available_at > now() AS locked FROM wallet_entries WHERE user_id = $1 AND kind = 'seller_gain'`, [w.seller]);
  const total = entries.reduce((a, e) => a + Number(e.a), 0);
  assert.equal(o.available + o.pending, total, 'le solde affiché = les écritures du portefeuille');
  assert.equal(o.in_progress, 1); assert.equal(o.avg_gain, Math.round(total / 2));
  assert.equal(o.rate.enough_history, false); assert.equal(o.rate.used, 60, 'moins de 10 commandes terminées : taux par défaut');
  assert.equal(o.forecast.length, 3);
  const f = o.forecast[0]; assert.equal(f.mid - f.certain, Math.round(1 * o.avg_gain * 0.6));
  // le vendeur règle son propre taux
  assert.equal((await s.post('/api/seller/finances/rate', { rate: 80 })).status, 200);
  assert.equal((await s.get('/api/seller/finances')).json.rate.used, 80);
  assert.equal((await s.post('/api/seller/finances/rate', { rate: 2 })).status, 400);
  assert.equal((await s.post('/api/seller/finances/rate', { rate: 101 })).status, 400);
  assert.equal((await s.post('/api/seller/finances/rate', { rate: null })).status, 200);
  assert.equal((await s.get('/api/seller/finances')).json.rate.used, 60);
});

test('dépenses récurrentes : créer, modifier, arrêter, échéances proches, limites', async () => {
  const mk = (b = {}) => s.post('/api/seller/finances/recurring', { label: 'Pub Facebook', category: 'ads', amount: 5000, frequency: 'daily', anchor_on: dayStr(0), ...b });
  const a = await mk(); assert.equal(a.status, 201);
  assert.equal((await mk({ label: 'x' })).status, 400, 'nom trop court');
  assert.equal((await mk({ amount: 0 })).status, 400);
  assert.equal((await mk({ category: 'autre' })).status, 400);
  assert.equal((await mk({ frequency: 'yearly' })).status, 400);
  assert.equal((await mk({ frequency: 'monthly', anchor_on: '2026-11-30' })).status, 400, 'mensuel : jour 1 à 28');
  assert.equal((await mk({ anchor_on: '2030-01-01' })).status, 400, 'date trop lointaine');
  const o = (await s.get('/api/seller/finances')).json;
  assert.equal(o.recurring.length, 1); assert.equal(o.due_soon.length, 1, 'une seule ligne par dépense : sa prochaine échéance'); assert.equal(o.due_soon[0].on, dayStr(0));
  assert.ok(o.forecast[0].out >= 29 * 5000);
  // modification et arrêt par le propriétaire seulement
  assert.equal((await s.post('/api/seller/finances/recurring', { id: a.json.id, label: 'Pub TikTok', category: 'ads', amount: 7000, frequency: 'weekly', anchor_on: dayStr(2) })).status, 200);
  assert.equal((await s2.post('/api/seller/finances/recurring', { id: a.json.id, label: 'Vol', category: 'ads', amount: 1, frequency: 'daily', anchor_on: dayStr(1) })).status, 404);
  assert.equal((await s2.post(`/api/seller/finances/recurring/${a.json.id}/stop`)).status, 404);
  assert.equal((await s2.get('/api/seller/finances')).json.recurring.length, 0, 'les données d\'un vendeur ne sont pas vues par un autre');
  assert.equal((await s.post(`/api/seller/finances/recurring/${a.json.id}/stop`)).status, 200);
  assert.equal((await s.post(`/api/seller/finances/recurring/${a.json.id}/stop`)).status, 404, 'déjà arrêtée');
  assert.equal((await s.get('/api/seller/finances')).json.recurring.length, 0);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM finance_recurring WHERE id = $1 AND stopped_at IS NOT NULL`, [a.json.id]))[0].n, 1, 'conservée dans la base');
  // 30 au plus
  for (let i = 0; i < 30; i++) assert.equal((await mk({ label: `Dépense ${i + 10}` })).status, 201);
  const r = await mk({ label: 'Trente et unième' }); assert.equal(r.status, 400); assert.match(r.json.message, /Maximum 30/);
  for (const x of (await s.get('/api/seller/finances')).json.recurring) await s.post(`/api/seller/finances/recurring/${x.id}/stop`);
});

test('budget par catégorie et objectif du mois', async () => {
  assert.equal((await s.post('/api/seller/finances/budget', { category: 'ads', amount: 50000 })).status, 200);
  assert.equal((await s.post('/api/seller/finances/budget', { category: 'ads', amount: 60000 })).status, 200, 'remplace');
  assert.equal((await s.post('/api/seller/finances/budget', { category: 'x', amount: 1 })).status, 400);
  assert.equal((await s.post('/api/seller/finances/budget', { category: 'ads', amount: -5 })).status, 400);
  assert.equal((await s.post('/api/seller/expenses', { date: dayStr(0), category: 'ads', amount: 20000 })).status, 201, 'les dépenses de « Mon bénéfice » comptent dans le réel');
  let o = (await s.get('/api/seller/finances')).json;
  const ads = o.budgets.find((b) => b.category === 'ads'); assert.equal(ads.budget, 60000); assert.equal(ads.spent, 20000);
  assert.equal(o.budgets.find((b) => b.category === 'goods').budget, null);
  assert.equal((await s2.get('/api/seller/finances')).json.budgets.find((b) => b.category === 'ads').budget, null);
  assert.equal((await s.post('/api/seller/finances/budget', { category: 'ads', amount: null })).status, 200);
  assert.equal((await s.get('/api/seller/finances')).json.budgets.find((b) => b.category === 'ads').budget, null);
  // objectif
  assert.equal((await s.post('/api/seller/finances/goal', { target: 0 })).status, 400);
  assert.equal((await s.post('/api/seller/finances/goal', { target: 500000 })).status, 200);
  o = (await s.get('/api/seller/finances')).json;
  assert.equal(o.goal.target, 500000); assert.ok(o.goal.gains > 0); assert.equal(o.goal.missing, Math.max(0, 500000 - o.goal.gains));
  assert.equal(o.goal.deliveries_missing, Math.ceil(o.goal.missing / o.avg_gain));
  assert.ok(o.goal.days_left >= 0 && o.goal.days_left <= 30);
  assert.equal((await s.post('/api/seller/finances/goal', { target: null })).status, 200);
  assert.equal((await s.get('/api/seller/finances')).json.goal.target, null);
});

test('alerte publicité : quand la pub par livraison dépasse le gain moyen', async () => {
  assert.equal((await s.get('/api/seller/finances')).json.ads_alert, null);
  await s.post('/api/seller/expenses', { date: dayStr(0), category: 'ads', amount: 100_000_000 });
  const a = (await s.get('/api/seller/finances')).json.ads_alert;
  assert.ok(a && a.ads_per_delivery > a.avg_gain);
});

test('l\'argent de la plateforme n\'est jamais touché : aucune écriture de portefeuille créée ou modifiée', async () => {
  const now = await walletTotals();
  assert.equal(now.n, seen.n); assert.equal(now.t, seen.t);
});

test('droits de la base : pas d\'accès direct aux tables, seul un vendeur appelle les fonctions', async () => {
  for (const t of ['finance_recurring', 'finance_budgets', 'finance_goals', 'finance_prefs']) {
    await assert.rejects(db.app.query(`INSERT INTO ${t}(owner_id) VALUES ($1)`, [w.seller]), /permission denied/, t);
    await assert.rejects(db.app.query(`DELETE FROM ${t}`), /permission denied/, t);
  }
  await expectErr(call(db.app, 'fn_seller_finance_goal_set', w.courier, 1000), 'forbidden');
  await expectErr(call(db.app, 'fn_seller_finance_goal_set', w.admin, 1000), 'forbidden');
  await expectErr(call(db.app, 'fn_seller_finance_goal_set', w.seller, 0), 'invalid_input');
  await assert.rejects(db.app.query('SELECT _finance_feature_on()'), /permission denied/);
});

test('vie privée : l\'anonymisation d\'un compte vendeur supprime ses données de finances', async () => {
  await s2.post('/api/seller/finances/goal', { target: 10000 });
  await s2.post('/api/seller/finances/budget', { category: 'goods', amount: 1000 });
  await s2.post('/api/seller/finances/rate', { rate: 70 });
  await s2.post('/api/seller/finances/recurring', { label: 'Loyer', category: 'other', amount: 3000, frequency: 'monthly', anchor_on: dayStr(1).slice(0, 8) + '10' });
  await call(db.app, 'fn_admin_anonymize_user', w.admin, w.seller2);
  for (const t of ['finance_recurring', 'finance_budgets', 'finance_goals', 'finance_prefs']) assert.equal((await rows(`SELECT count(*)::int AS n FROM ${t} WHERE owner_id = $1`, [w.seller2]))[0].n, 0, t);
});

test('retour arrière 045 : refusé s\'il existe des données ou si la fonction est allumée, accepté sinon', async () => {
  const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-045.sql'), 'utf8');
  const run = async () => { await db.owner.query('BEGIN'); try { for (const q of splitSql(rb)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT'); } catch (e) { await db.owner.query('ROLLBACK'); throw e; } };
  await s.post('/api/seller/finances/goal', { target: 1000 });
  await assert.rejects(run, /des données de finances existent/);
  for (const t of ['finance_recurring', 'finance_budgets', 'finance_goals', 'finance_prefs']) await db.owner.query(`DELETE FROM ${t}`);
  await assert.rejects(run, /éteignez d'abord la fonction/);
  await db.owner.query(`UPDATE settings SET value = 0 WHERE key = 'feature_finances'`);
  await run();
  assert.equal((await rows(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name LIKE 'finance\\_%'`))[0].n, 0);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'fn\_seller\_finance%' OR proname IN ('_finance_feature_on', 'trg_finances_user_anonymized')`))[0].n, 0);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM settings WHERE key = 'feature_finances'`))[0].n, 0);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '045_finances.sql'`))[0].n, 0);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'users_finances_anonymized'`))[0].n, 0);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '044_relances.sql'`))[0].n, 1, 'les migrations précédentes sont intactes');
});
