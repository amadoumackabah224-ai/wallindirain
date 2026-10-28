// Migration 030 : le fournisseur ne donne plus sa pièce d'identité à l'inscription ; elle est exigée au premier retrait.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { splitSql } from '../src/migrate.js';
import { freshDb, world, call, expectErr } from './helpers.js';

let db, w;
const root = path.resolve(import.meta.dirname, '..', '..');
before(async () => { db = await freshDb('wld_supnopiece'); w = await world(db); });
after(async () => { await db.owner.end(); await db.app.end(); });

test('inscription fournisseur sans pièce : compte en attente, aucune pièce enregistrée', async () => {
  const id = await call(db.app, 'fn_register', '623000001', 'Fournisseur Un', 'supplier', 'x', null, 'orange_money', '623000001', '2026-10-24');
  const u = (await db.owner.query('SELECT status, identity_doc, identity_verified FROM users WHERE id = $1', [id])).rows[0];
  assert.deepEqual(u, { status: 'pending', identity_doc: null, identity_verified: false });
  await expectErr(call(db.app, 'fn_register', '623000002', 'Fournisseur Deux', 'supplier', 'x', 'ab', 'orange_money', '623000002', '2026-10-24'), 'invalid_input');   // une pièce saisie reste contrôlée
});

test('le retrait reste bloqué tant que l\'identité n\'est pas vérifiée, puis passe', async () => {
  const id = await call(db.app, 'fn_register', '623000003', 'Fournisseur Trois', 'supplier', 'x', null, 'orange_money', '623000003', '2026-10-24');
  await call(db.app, 'fn_admin_set_user_status', w.admin, id, 'active');
  await call(db.app, 'fn_admin_deposit', w.admin, id, 200000, 'DEP-SUP');
  await expectErr(call(db.app, 'fn_withdrawal_request', id, 50000), 'identity_required');
  await call(db.app, 'fn_set_identity_doc', id, 'CNI-998877');
  await expectErr(call(db.app, 'fn_withdrawal_request', id, 50000), 'identity_required');          // pièce saisie mais pas encore vérifiée
  await call(db.app, 'fn_admin_verify_identity', w.admin, id, true);
  await call(db.app, 'fn_withdrawal_request', id, 50000);
  assert.equal((await db.owner.query('SELECT count(*)::int AS n FROM fn_ledger_check()')).rows[0].n, 0);
});

test('retour arrière 030 : la pièce redevient obligatoire pour un fournisseur ; migration rejouable', async () => {
  const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-030.sql'), 'utf8');
  await db.owner.query('BEGIN');
  for (const s of splitSql(rb)) { if (/^(begin|commit)$/i.test(s.trim())) continue; await db.owner.query(s); }
  await db.owner.query('COMMIT');
  await expectErr(call(db.app, 'fn_register', '623000004', 'Fournisseur Quatre', 'supplier', 'x', null, 'orange_money', '623000004', '2026-10-24'), 'identity_required');
  await call(db.app, 'fn_register', '623000005', 'Vendeur Cinq', 'seller', 'x', null, 'orange_money', '623000005', '2026-10-24');   // vendeur : toujours sans pièce
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '030_fournisseur_sans_piece.sql'`)).rows[0].n, 0);
});
