// Finances de la société : l'argent de la plateforme arrive tout seul dans « Mes finances » de l'administrateur (migration 073).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { splitSql } from '../src/migrate.js';
import { freshDb, world, call } from './helpers.js';

const root = path.resolve(import.meta.dirname, '..', '..');
let db, w;
before(async () => { db = await freshDb('wld_finsoc'); w = await world(db); });
after(async () => { await db.owner.end(); await db.app.end(); });

const PLATFORM = '00000000-0000-0000-0000-000000000001';
const put = (kind, amount, when = 'now()') => db.owner.query(`INSERT INTO wallet_entries(user_id, kind, amount, available_at, description) VALUES ($1, $2, $3, ${when}, 'test')`, [PLATFORM, kind, amount]);
const rows = async (owner) => (await db.app.query("SELECT kind, category, amount::bigint AS amount, source, account_id FROM pf_all_tx WHERE owner_id = $1 AND source = 'wallindirain' ORDER BY amount DESC", [owner])).rows;

test('les écritures de la plateforme apparaissent chez l\'administrateur, classées par nature, sans rien faire', async () => {
  await put('platform_revenue', 50000); await put('team_pay', -12000); await put('courier_prime', -3000); await put('referral_bonus', -2000);
  const r = await rows(w.admin);
  assert.deepEqual(r.map((x) => [x.kind, x.category, Number(x.amount)]), [
    ['income', 'co_delivery_income', 50000], ['expense', 'employees', 12000], ['expense', 'contractors', 3000], ['expense', 'co_promo', 2000]]);
  assert.ok(r.every((x) => x.account_id === null));
});

test('seul l\'administrateur voit l\'argent de la plateforme', async () => {
  assert.equal((await rows(w.seller)).length, 0); assert.equal((await rows(w.courier)).length, 0);
});

test('l\'argent pas encore disponible n\'est pas compté', async () => {
  const before = (await rows(w.admin)).length;
  await put('platform_revenue', 99000, "now() + interval '3 days'");
  assert.equal((await rows(w.admin)).length, before);
});

test('catégories de l\'entreprise utilisables en dépense récurrente', async () => {
  await db.owner.query("UPDATE settings SET value = 1 WHERE key = 'feature_finances_perso'");
  const id = await call(db.app, 'fn_pf_recurring_save', w.admin, null, 'Serveur', 'expense', 'co_hosting', 250000, 'monthly', new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10).replace(/-(29|30|31)$/, '-15'));
  assert.ok(id);
  assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM pf_cat_system WHERE key LIKE 'co\\_%'")).rows[0].n, 23);
});

const run = async (file) => { const rb = fs.readFileSync(path.join(root, 'docs', file), 'utf8'); await db.owner.query('BEGIN'); try { for (const q of splitSql(rb)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT'); } catch (e) { await db.owner.query('ROLLBACK'); throw e; } };

test('retour arrière : la vue et les catégories reviennent comme avant, refusé si une catégorie est utilisée', async () => {
  await assert.rejects(run('retour-arriere-073.sql'), /refusé/);    // « co_hosting » est utilisée par le récurrent du test précédent
  await db.owner.query("DELETE FROM pf_recurring WHERE category LIKE 'co\\_%'");
  await run('retour-arriere-073.sql');
  assert.equal((await rows(w.admin)).length, 0);
  assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM pf_cat_system WHERE key LIKE 'co\\_%'")).rows[0].n, 0);
});
