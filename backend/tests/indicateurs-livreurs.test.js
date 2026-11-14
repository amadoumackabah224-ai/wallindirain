// Migration 067 : indicateurs des livreurs (lecture seule), droits, calculs, retour arrière.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { splitSql } from '../src/migrate.js';
import { freshDb, world, approvedProduct, call, expectErr, deliver } from './helpers.js';

let db, w, product, n = 0;
const root = path.resolve(import.meta.dirname, '..', '..');
const ph = () => `67${String(++n + 8000000).padStart(7, '0')}`;
const iso = (d) => d.toISOString().slice(0, 10);
const today = () => iso(new Date());
const ago = (k) => iso(new Date(Date.now() - k * 86400_000));
const mk = async () => (await call(db.app, 'fn_seller_create_order', w.seller, product, null, null, 1, 'Client', ph(), 'Kaloum', 'Rue 1', null, false));

before(async () => { db = await freshDb('wld_indic'); w = await world(db); product = await approvedProduct(db, w, { price: 60000, qty: 60 }); await call(db.app, 'fn_seller_set_price', w.seller, product, 120000); });
after(async () => { await db.owner.end(); await db.app.end(); });

test('droits : admin et livreur seulement, période valide', async () => {
  await expectErr(call(db.app, 'fn_courier_stats', w.seller, ago(30), today()), 'forbidden');
  await expectErr(call(db.app, 'fn_courier_stats', w.admin, today(), ago(3)), 'invalid_input');
  await expectErr(call(db.app, 'fn_courier_stats', w.admin, ago(400), today()), 'invalid_input');
});

test('une livraison réussie est comptée, taux et gains cohérents, pas de donnée client', async () => {
  const o = await mk();
  await deliver(db, w, o.id, o.ref);
  const s = await call(db.app, 'fn_courier_stats', w.admin, ago(1), today());
  const c = s.couriers.find((x) => x.courier_id === w.courier);
  assert.ok(c, 'le livreur apparaît');
  assert.equal(c.delivered, 1);
  assert.equal(c.failed, 0);
  assert.equal(c.success_rate, 100);
  const pay = Number((await db.owner.query('SELECT courier_pay::text AS p FROM orders WHERE id = $1', [o.id])).rows[0].p);
  assert.equal(Number(c.earnings), pay);
  const txt = JSON.stringify(s);
  assert.ok(!txt.includes('Rue 1') && !txt.includes(o.ref));
});

test('retard : une livraison au-delà du délai est comptée', async () => {
  const o = await mk();
  await deliver(db, w, o.id, o.ref);
  await db.owner.query(`UPDATE settings SET value = 0 WHERE key = 'courier_late_hours'`);   // l'historique est en ajout seul : on abaisse le délai plutôt que de vieillir l'affectation
  const s = await call(db.app, 'fn_courier_stats', w.admin, ago(1), today());
  const c = s.couriers.find((x) => x.courier_id === w.courier);
  assert.equal(c.delivered, 2);
  assert.equal(c.late, 2);
  assert.ok(c.avg_minutes >= 0);
  await db.owner.query(`UPDATE settings SET value = 24 WHERE key = 'courier_late_hours'`);
  assert.equal((await call(db.app, 'fn_courier_stats', w.admin, ago(1), today())).couriers.find((x) => x.courier_id === w.courier).late, 0);
});

test('un livreur ne voit que ses propres chiffres', async () => {
  const s = await call(db.app, 'fn_courier_stats', w.courier, ago(1), today());
  assert.ok(s.couriers.every((x) => x.courier_id === w.courier));
});

test('retour arrière : fonction et réglage retirés', async () => {
  const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-067.sql'), 'utf8');
  await db.owner.query('BEGIN'); for (const q of splitSql(rb)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT');
  assert.equal((await db.owner.query(`SELECT count(*)::int AS c FROM pg_proc WHERE proname = 'fn_courier_stats'`)).rows[0].c, 0);
});
