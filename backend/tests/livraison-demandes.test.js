// Migrations 069-070 : expéditeur (livraison à la demande) : inscription, demande à prix figé, limites, annulation, droits, retour arrière.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { splitSql } from '../src/migrate.js';
import { freshDb, world, call, expectErr } from './helpers.js';

let db, w, ship, other, n = 0;
const root = path.resolve(import.meta.dirname, '..', '..');
const ph = () => `69${String(++n + 5000000).padStart(7, '0')}`;
const set = (k, val) => db.owner.query('UPDATE settings SET value = $2 WHERE key = $1', [k, val]);
const mk = (over = {}) => call(db.app, 'fn_dlv_request_create', ship, ...Object.values({ from: 'Taouyah', fa: 'Rue 12, près de la mosquée', to: 'Ratoma', ta: 'Marché de Ratoma', rn: 'Mariama', rp: ph(), d: 'Carton de chaussures', kg: 3, dv: 100000, payer: 'receiver', ack: true, ...over }));
const reg = (role) => call(db.app, 'fn_register', ph(), 'Test', role, 'x'.repeat(60), null, null, null, null);

before(async () => {
  db = await freshDb('wld_dlvreq'); w = await world(db);
  await call(db.app, 'fn_admin_dlv_import', w.admin, 'Taouyah', JSON.stringify([{ places: ['Ratoma', 'Concasseur'], light: 10000, heavy: 15000 }]));
});
after(async () => { await db.owner.end(); await db.app.end(); });

test('inscription expéditeur : fermée par défaut, ouverte seulement si les deux réglages sont à 1', async () => {
  await expectErr(reg('shipper'), 'invalid_role');
  await set('feature_livraison_demande', 1); await expectErr(reg('shipper'), 'invalid_role');
  await set('dlv_open_signup', 1);
  ship = await reg('shipper'); other = await reg('shipper');
  assert.ok(ship);
  assert.equal((await db.owner.query('SELECT role::text AS r, status::text AS s FROM users WHERE id = $1', [ship])).rows[0].r, 'shipper');
});

test('demande : prix léger/lourd figé, trajet sans tarif et non-expéditeur refusés', async () => {
  const a = await mk();
  assert.equal(a.price, 10000); assert.equal(a.weight_class, 'light'); assert.match(a.ref, /^LD-[0-9A-F]{6}$/);
  const b = await mk({ kg: 12 });
  assert.equal(b.price, 15000); assert.equal(b.weight_class, 'heavy');
  await set('delivery_heavy_kg', 99);   // le prix déjà enregistré ne change pas
  const mine = await call(db.app, 'fn_dlv_my_requests', ship);
  assert.equal(mine.find((r) => r.id === b.id).price, 15000);
  await expectErr(mk({ to: 'Labé' }), 'not_found');
  await expectErr(call(db.app, 'fn_dlv_request_create', w.seller, 'Taouyah', 'Rue 1', 'Ratoma', 'Rue 2', 'Mariama', ph(), 'Colis', 3, 0, 'sender', true), 'forbidden');
});

test('contrôles : confirmation des objets interdits, valeur plafonnée, téléphone, limite par jour', async () => {
  await expectErr(mk({ ack: false }), 'invalid_input');
  await expectErr(mk({ dv: 999999999 }), 'invalid_input');
  await expectErr(mk({ rp: '123' }), 'invalid_input');
  await expectErr(mk({ payer: 'nobody' }), 'invalid_input');
  await set('dlv_daily_limit', 3);   // déjà 2 demandes aujourd'hui
  await mk();
  await expectErr(mk(), 'limit');
});

test('chacun ne voit que ses demandes ; annulation seulement tant que « new » ; l\'admin voit tout', async () => {
  const mine = await call(db.app, 'fn_dlv_my_requests', ship);
  assert.equal((await call(db.app, 'fn_dlv_my_requests', other)).length, 0);
  await expectErr(call(db.app, 'fn_dlv_request_cancel', other, mine[0].id), 'not_found');
  await call(db.app, 'fn_dlv_request_cancel', ship, mine[0].id);
  await expectErr(call(db.app, 'fn_dlv_request_cancel', ship, mine[0].id), 'invalid_state');
  const all = await call(db.app, 'fn_admin_dlv_requests', w.admin, null);
  assert.equal(all.length, 3);
  assert.equal(all[0].shipper_phone.length, 9);
  await expectErr(call(db.app, 'fn_admin_dlv_requests', ship, null), 'forbidden');
  assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM audit_log WHERE action IN ('dlv_request_created','dlv_request_cancelled')")).rows[0].n, 4);
});

test('retour arrière 070 : refusé s\'il existe des demandes, accepté sinon', async () => {
  const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-070.sql'), 'utf8');
  const run = async () => { await db.owner.query('BEGIN'); try { for (const q of splitSql(rb)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT'); } catch (e) { await db.owner.query('ROLLBACK'); throw e; } };
  await assert.rejects(run, /refusé pour ne rien perdre/);
});
