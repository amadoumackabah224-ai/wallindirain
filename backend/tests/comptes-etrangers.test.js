// 037 : vendeurs de l'étranger : règles de la base et retour arrière.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { splitSql } from '../src/migrate.js';
import { freshDb, world, call, expectErr } from './helpers.js';

let db, w;
const root = path.resolve(import.meta.dirname, '..', '..');
before(async () => { db = await freshDb('wld_etranger'); w = await world(db); });
after(async () => { await db.owner.end(); await db.app.end(); });

test('base : numéro étranger pour un vendeur seulement, compte en attente ; payout « autre » en texte libre', async () => {
  const id = await call(db.app, 'fn_register', '+221771234567', 'Awa Sall', 'seller', 'x', null, 'other', 'Wave Sénégal 771234567', '2026-10-24');
  const u = (await db.owner.query('SELECT status, payout_method FROM users WHERE id = $1', [id])).rows[0];
  assert.deepEqual(u, { status: 'pending', payout_method: 'other' });
  await expectErr(call(db.app, 'fn_register', '+221771234568', 'Four Nisseur', 'supplier', 'x', null, 'other', 'Wave Sénégal', '2026-10-24'), 'foreign_seller_only');
  await expectErr(call(db.app, 'fn_register', '+224621000001', 'Faux Guinéen', 'seller', 'x', null, 'orange_money', '621000001', '2026-10-24'), 'invalid_input');   // +224 se saisit en 9 chiffres
  await expectErr(call(db.app, 'fn_register', '+221771234567', 'Doublon', 'seller', 'x', null, 'other', 'Wave Sénégal 771234567', '2026-10-24'), 'phone_taken');
  await expectErr(call(db.app, 'fn_register', '+22177', 'Trop Court', 'seller', 'x', null, 'other', 'Wave Sénégal 771234567', '2026-10-24'), 'invalid_input');
  await expectErr(call(db.app, 'fn_register', '623111111', 'Guinéen', 'seller', 'x', null, 'other', 'ab', '2026-10-24'), 'invalid_input');
  await expectErr(call(db.app, 'fn_admin_create_staff', w.admin, '+221771239999', 'Agent Étranger', 'agent', 'x', 'Alpha'), 'invalid_input');   // le personnel reste en Guinée
  assert.equal((await db.owner.query('SELECT count(*)::int AS n FROM fn_ledger_check()')).rows[0].n, 0);
});

test('retour arrière 037 : refusé tant qu\'un compte étranger existe ; sinon restaure les règles à 9 chiffres ; migration rejouable', async () => {
  const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-037.sql'), 'utf8');
  const run = async () => { await db.owner.query('BEGIN'); try { for (const s of splitSql(rb)) { if (/^(begin|commit)$/i.test(s.trim())) continue; await db.owner.query(s); } await db.owner.query('COMMIT'); } catch (e) { await db.owner.query('ROLLBACK'); throw e; } };
  await assert.rejects(run(), /refusé/);
  await db.owner.query(`DELETE FROM consents WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '+%')`).catch(() => {});
  await db.owner.query(`UPDATE users SET phone = '622000099', payout_method = 'orange_money', payout_phone = '622000099' WHERE phone LIKE '+%'`);
  await run();
  await expectErr(call(db.app, 'fn_register', '+221771230000', 'Vendeur Étranger', 'seller', 'x', null, 'orange_money', '621000000', '2026-10-24'), 'invalid_input');
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '037_comptes_etrangers.sql'`)).rows[0].n, 0);
});
