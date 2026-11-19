// Migration 081 : période de grâce Mes finances. Prolonge les essais sans jamais en raccourcir ; aucun argent touché.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { splitSql } from '../src/migrate.js';
import { freshDb, world, call, expectErr } from './helpers.js';

const root = path.resolve(import.meta.dirname, '..', '..');
let db, w;
const tier = async (u) => (await call(db.app, 'fn_pf_tier', u));
before(async () => {
  db = await freshDb('wld_pfgrace'); w = await world(db);
  await call(db.app, 'fn_admin_set_setting', w.admin, 'feature_finances_perso', 1);
  await call(db.app, 'fn_pf_account_save', w.seller, null, 'Caisse', 'cash', 'blue', 0, null);       // crée l'accès (essai de 14 jours)
  await call(db.app, 'fn_pf_account_save', w.supplier, null, 'Caisse', 'cash', 'blue', 0, null);
  await db.owner.query(`UPDATE pf_access SET trial_until = now() - interval '5 days' WHERE owner_id = $1`, [w.seller]);   // essai fini
  await db.owner.query(`UPDATE pf_access SET trial_until = now() - interval '5 days', paid_until = now() + interval '100 days' WHERE owner_id = $1`, [w.supplier]); // abonné long
});
after(async () => { await db.owner.end(); await db.app.end(); });

test('sans grâce : un prix fixé fait passer en gratuit celui dont l\'essai est fini', async () => {
  await call(db.app, 'fn_admin_set_setting', w.admin, 'pf_price_monthly', 20000);
  assert.equal(await tier(w.seller), 'free');
  assert.equal(await tier(w.supplier), 'pro');
});

test('grâce : droits, durée, prolongation sans raccourcir', async () => {
  await expectErr(call(db.app, 'fn_admin_pf_grace', w.seller, 30), 'forbidden');
  await expectErr(call(db.app, 'fn_admin_pf_grace', w.admin, 0), 'invalid_input');
  await expectErr(call(db.app, 'fn_admin_pf_grace', w.admin, 91), 'invalid_input');
  const n = await call(db.app, 'fn_admin_pf_grace', w.admin, 30);
  assert.equal(n, 1);                                                                    // seul le vendeur est concerné
  assert.equal(await tier(w.seller), 'pro');
  const r = (await db.owner.query(`SELECT trial_until, paid_until FROM pf_access WHERE owner_id = $1`, [w.supplier])).rows[0];
  assert.ok(new Date(r.paid_until) - Date.now() > 99 * 86400000, 'abonnement long non raccourci');
  assert.equal((await db.owner.query('SELECT count(*)::int AS n FROM fn_ledger_check()')).rows[0].n, 0);
});

test('retour arrière 081 : supprime la fonction', async () => {
  const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-081.sql'), 'utf8');
  await db.owner.query('BEGIN'); for (const q of splitSql(rb)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT');
  assert.equal((await db.owner.query(`SELECT to_regprocedure('fn_admin_pf_grace(uuid,int)') AS f`)).rows[0].f, null);
});
