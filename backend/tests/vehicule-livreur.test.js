// Vérification du véhicule des livreurs (migration 062) : plaque + carte grise, examen, blocage des missions (réglage), retour arrière.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitSql } from '../src/migrate.js';
import { freshDb, world, approvedProduct, call, expectErr, PNG } from './helpers.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let db, w, n = 0;
const IMG = Buffer.concat([PNG, Buffer.alloc(3000, 7)]);
const phone = () => `6${String(++n).padStart(8, '0')}`;
const setting = (v) => db.owner.query(`UPDATE settings SET value = $1 WHERE key = 'vehicle_check_required'`, [v]);
const newOrder = async (product) => {
  const o = await call(db.app, 'fn_seller_create_order_once', w.seller, `veh-${++n}-key-0000000000`, product, null, null, 1, 'Client Test', phone(), 'Kaloum', 'Rue 1 Kaloum', null, false);
  await call(db.app, 'fn_agent_take_order', w.agent1, o.id);
  await call(db.app, 'fn_agent_log_call', w.agent1, o.id, 'confirmed', 'OK');
  return o;
};
const priced = async () => { const p = await approvedProduct(db, w, { price: 60000, qty: 20 }); await call(db.app, 'fn_seller_set_price', w.seller, p, 120000); return p; };
const send = async (plate = 'RC 1234 AB') => {
  await call(db.app, 'fn_vehicle_set', w.courier, plate);
  await call(db.app, 'fn_vehicle_image_set', w.courier, 'plate', 'image/png', IMG);
  await call(db.app, 'fn_vehicle_image_set', w.courier, 'card', 'image/png', IMG);
  await call(db.app, 'fn_vehicle_submit', w.courier);
};

before(async () => { db = await freshDb('wld_vehicule'); w = await world(db); });
after(async () => { await db.owner.end(); await db.app.end(); });

test('désactivé par défaut : un livreur moto non vérifié reçoit des missions comme avant', async () => {
  assert.equal(Number((await db.owner.query(`SELECT value FROM settings WHERE key='vehicle_check_required'`)).rows[0].value), 0);
  await call(db.app, 'fn_admin_set_courier_profile', w.admin, w.courier, 'moto');
  const product = await priced();
  const o = await newOrder(product);
  await call(db.app, 'fn_chief_assign', w.chief, o.id, w.courier);
  assert.equal((await db.owner.query('SELECT status FROM orders WHERE id = $1', [o.id])).rows[0].status, 'assigned');
});

test('contrôle activé : moto non vérifiée refusée (affectation et proposition), vélo non concerné, puis vérifiée acceptée', async () => {
  await setting(1);
  const product = await priced();
  const o = await newOrder(product);
  await expectErr(call(db.app, 'fn_chief_assign', w.chief, o.id, w.courier), 'vehicle_unverified');
  await expectErr(call(db.app, 'fn_chief_offer_order', w.chief, o.id, w.courier), 'vehicle_unverified');
  await call(db.app, 'fn_admin_set_courier_profile', w.admin, w.courier2, 'velo');                  // vélo : aucune plaque à fournir
  await call(db.app, 'fn_chief_assign', w.chief, o.id, w.courier2);
  const o2 = await newOrder(product);
  await expectErr(call(db.app, 'fn_vehicle_submit', w.courier), 'invalid_input');                   // rien envoyé
  await call(db.app, 'fn_vehicle_set', w.courier, '  rc 1234  ab ');
  await expectErr(call(db.app, 'fn_vehicle_submit', w.courier), 'invalid_input');                   // photos manquantes
  await expectErr(call(db.app, 'fn_vehicle_image_set', w.courier, 'plate', 'image/png', Buffer.alloc(10)), 'invalid_input');
  await expectErr(call(db.app, 'fn_vehicle_image_set', w.courier, 'moto', 'image/png', IMG), 'invalid_input');
  await send('rc 1234  ab');
  assert.equal((await call(db.app, 'fn_my_vehicle', w.courier)).plate, 'RC 1234 AB');              // majuscules, espaces nettoyés
  await expectErr(call(db.app, 'fn_chief_assign', w.chief, o2.id, w.courier), 'vehicle_unverified'); // envoyé mais pas encore vérifié
  await expectErr(call(db.app, 'fn_vehicle_set', w.courier, 'XX 9999'), 'invalid_state');           // verrouillé pendant l'examen
  await expectErr(call(db.app, 'fn_admin_verify_vehicle', w.seller, w.courier), 'forbidden');
  await call(db.app, 'fn_admin_verify_vehicle', w.admin, w.courier);
  await call(db.app, 'fn_chief_assign', w.chief, o2.id, w.courier);
  assert.equal((await call(db.app, 'fn_my_vehicle', w.courier)).status, 'verified');
});

test('refus avec motif puis renvoi ; images lisibles du livreur et de l\'admin seulement, consultation admin tracée', async () => {
  await call(db.app, 'fn_admin_verify_vehicle', w.admin, w.courier, false);                         // retire la vérification (repasse à examiner)
  await expectErr(call(db.app, 'fn_admin_reject_vehicle', w.admin, w.courier, 'x'), 'invalid_input');
  await call(db.app, 'fn_admin_reject_vehicle', w.admin, w.courier, 'Plaque illisible');
  const k = await call(db.app, 'fn_my_vehicle', w.courier);
  assert.equal(k.status, 'rejected'); assert.equal(k.reject_reason, 'Plaque illisible');
  await call(db.app, 'fn_vehicle_image_set', w.courier, 'plate', 'image/png', IMG);                 // nouvelle photo : repasse en brouillon
  await call(db.app, 'fn_vehicle_submit', w.courier);
  const own = (await db.app.query('SELECT * FROM fn_vehicle_image_get($1,$2,$3)', [w.courier, w.courier, 'plate'])).rows;
  assert.equal(own.length, 1);
  await expectErr(db.app.query('SELECT * FROM fn_vehicle_image_get($1,$2,$3)', [w.courier2, w.courier, 'plate']), 'forbidden');
  const before = Number((await db.owner.query(`SELECT count(*) n FROM audit_log WHERE action='vehicle_image_viewed'`)).rows[0].n);
  await db.app.query('SELECT * FROM fn_vehicle_image_get($1,$2,$3)', [w.admin, w.courier, 'card']);
  assert.equal(Number((await db.owner.query(`SELECT count(*) n FROM audit_log WHERE action='vehicle_image_viewed'`)).rows[0].n), before + 1);
  await assert.rejects(db.app.query('SELECT plate_img FROM courier_vehicles'), /permission denied/);   // jamais lisibles directement
});

test('anonymisation efface le véhicule ; retour arrière refusé tant que des données existent puis propre', async () => {
  const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-062.sql'), 'utf8');
  const run = async () => { await db.owner.query('BEGIN'); try { for (const q of splitSql(rb)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT'); } catch (e) { await db.owner.query('ROLLBACK'); throw e; } };
  await assert.rejects(run(), /retour arrière refusé/);
  await db.owner.query(`UPDATE users SET deleted_at = now() WHERE id = $1`, [w.courier]);
  assert.equal(Number((await db.owner.query('SELECT count(*) n FROM courier_vehicles')).rows[0].n), 0);
  await run();
  assert.equal(Number((await db.owner.query(`SELECT count(*) n FROM information_schema.tables WHERE table_name = 'courier_vehicles'`)).rows[0].n), 0);
  const o = await newOrder(await priced());
  await call(db.app, 'fn_chief_assign', w.chief, o.id, w.courier2);                                   // affectation intacte après retour arrière
});
