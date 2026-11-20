// Migration 082 : messages du circuit de vérification de la plaque et de la carte grise. Les règles de blocage (062/071) ne changent pas.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { splitSql } from '../src/migrate.js';
import { freshDb, world, call, expectErr, PNG } from './helpers.js';

const root = path.resolve(import.meta.dirname, '..', '..');
let db, w;
const IMG = Buffer.concat([PNG, Buffer.alloc(3000, 7)]);
const notes = async (user, title) => (await db.owner.query(`SELECT title, body, link FROM notifications WHERE user_id = $1 AND title = $2 ORDER BY id`, [user, title])).rows;
const send = async () => {
  await call(db.app, 'fn_vehicle_set', w.courier, 'RC 4321 AB');
  await call(db.app, 'fn_vehicle_image_set', w.courier, 'plate', 'image/png', IMG);
  await call(db.app, 'fn_vehicle_image_set', w.courier, 'card', 'image/png', IMG);
  await call(db.app, 'fn_vehicle_submit', w.courier);
};
before(async () => { db = await freshDb('wld_verifdocs'); w = await world(db); });
after(async () => { await db.owner.end(); await db.app.end(); });

test('dépôt : l\'administrateur est prévenu, statut « en attente »', async () => {
  await send();
  assert.equal((await call(db.app, 'fn_my_vehicle', w.courier)).status, 'submitted');
  const a = await notes(w.admin, 'Véhicule à vérifier');
  assert.equal(a.length, 1); assert.equal(a[0].link, 'couriers'); assert.match(a[0].body, /RC 4321 AB/);
  await call(db.app, 'fn_vehicle_submit', w.courier);                                   // renvoi pendant l'examen : pas de doublon
  assert.equal((await notes(w.admin, 'Véhicule à vérifier')).length, 1);
});

test('refus avec motif : le livreur reçoit le motif et peut renvoyer', async () => {
  await expectErr(call(db.app, 'fn_admin_reject_vehicle', w.admin, w.courier, 'x'), 'invalid_input');
  await call(db.app, 'fn_admin_reject_vehicle', w.admin, w.courier, 'Photo de la plaque illisible');
  const r = await notes(w.courier, 'Véhicule refusé');
  assert.equal(r.length, 1); assert.match(r[0].body, /Photo de la plaque illisible/);
  const v = await call(db.app, 'fn_my_vehicle', w.courier);
  assert.equal(v.status, 'rejected'); assert.equal(v.reject_reason, 'Photo de la plaque illisible');
  await call(db.app, 'fn_vehicle_image_set', w.courier, 'plate', 'image/png', IMG);       // nouveau document
  await call(db.app, 'fn_vehicle_submit', w.courier);
  assert.equal((await call(db.app, 'fn_my_vehicle', w.courier)).status, 'submitted');
  assert.equal((await notes(w.admin, 'Véhicule à vérifier')).length, 2);
});

test('validation : livreur et chefs call center prévenus une seule fois', async () => {
  await call(db.app, 'fn_admin_verify_vehicle', w.admin, w.courier);
  assert.equal((await notes(w.courier, 'Véhicule vérifié')).length, 1);
  assert.equal((await notes(w.chief, 'Livreur vérifié')).length, 1);
  await call(db.app, 'fn_admin_verify_vehicle', w.admin, w.courier);                     // revalidation : pas de nouveau message
  assert.equal((await notes(w.courier, 'Véhicule vérifié')).length, 1);
  assert.equal((await db.owner.query('SELECT count(*)::int AS n FROM fn_ledger_check()')).rows[0].n, 0);
});

test('retour arrière 082 : rétablit la 062 sans message', async () => {
  const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-082.sql'), 'utf8');
  await db.owner.query('BEGIN'); for (const q of splitSql(rb)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT');
  await db.owner.query(`UPDATE courier_vehicles SET status = 'submitted' WHERE user_id = $1`, [w.courier]);
  const before = (await db.owner.query('SELECT count(*)::int AS n FROM notifications')).rows[0].n;
  await call(db.app, 'fn_admin_reject_vehicle', w.admin, w.courier, 'Document périmé');
  assert.equal((await db.owner.query('SELECT count(*)::int AS n FROM notifications')).rows[0].n, before);
});
