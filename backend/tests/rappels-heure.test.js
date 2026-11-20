// Migration 083 : rappels clients à heure précise, notification unique à l'heure dite, élément « Aujourd'hui », retour arrière.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { splitSql } from '../src/migrate.js';
import { freshDb, world, approvedProduct, call, expectErr } from './helpers.js';

const root = path.resolve(import.meta.dirname, '..', '..');
let db, w;
const PHONE = '622000111';
const iso = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const notes = async () => (await db.owner.query(`SELECT body, link FROM notifications WHERE user_id = $1 AND title = 'Client à rappeler'`, [w.seller])).rows;
const run = async () => (await db.owner.query('SELECT fn_run_relance_reminders() AS n')).rows[0].n;
const run2 = async () => { const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-083.sql'), 'utf8'); await db.owner.query('BEGIN'); try { for (const q of splitSql(rb)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT'); } catch (e) { await db.owner.query('ROLLBACK'); throw e; } };

before(async () => {
  db = await freshDb('wld_rappels'); w = await world(db);
  await db.owner.query(`UPDATE users SET identity_verified = true WHERE id = $1`, [w.seller]);
  const p = await approvedProduct(db, w, { price: 60000, qty: 20 }); await call(db.app, 'fn_seller_set_price', w.seller, p, 120000);
  await call(db.app, 'fn_seller_create_order_once', w.seller, 'rappel-test-key-000001', p, null, null, 1, 'Mariama Diallo', PHONE, 'Kaloum', 'Rue 1 Kaloum', null, false);
});
after(async () => { await db.owner.end(); await db.app.end(); });

test('relances éteintes : refusé ; rôle et saisie contrôlés', async () => {
  await expectErr(call(db.app, 'fn_seller_relance_remind_at', w.seller, PHONE, iso(1), '11:00'), 'feature_off');
  await call(db.app, 'fn_admin_set_setting', w.admin, 'feature_relances', 1);
  await expectErr(call(db.app, 'fn_seller_relance_remind_at', w.courier, PHONE, iso(1), '11:00'), 'forbidden');
  await expectErr(call(db.app, 'fn_seller_relance_remind_at', w.seller, PHONE, iso(1), '25:00'), 'invalid_input');
  await expectErr(call(db.app, 'fn_seller_relance_remind_at', w.seller, PHONE, iso(-1), '11:00'), 'invalid_input');
  await expectErr(call(db.app, 'fn_seller_relance_remind_at', w.seller, '699999999', iso(1), '11:00'), 'not_found');
});

test('rappel avec heure : liste « Mes rappels », rien avant l\'heure', async () => {
  await call(db.app, 'fn_seller_relance_remind_at', w.seller, PHONE, iso(1), '11:00');
  const l = await call(db.app, 'fn_seller_reminders', w.seller);
  assert.equal(l.length, 1); assert.equal(l[0].due_time, '11:00'); assert.equal(l[0].name, 'Mariama Diallo'); assert.equal(l[0].overdue, false);
  assert.equal((await call(db.app, 'fn_seller_reminders', w.supplier).catch(() => 'refus')), 'refus');
  assert.equal(await run(), 0); assert.equal((await notes()).length, 0);
});

test('à l\'heure dite : une seule notification, et « Aujourd\'hui » l\'indique', async () => {
  await db.owner.query(`UPDATE relance_reminders SET due_on = current_date - 1 WHERE seller_id = $1`, [w.seller]);   // l'échéance est passée
  const today = await call(db.app, 'fn_today', w.seller);
  assert.equal(today.items.find((i) => i.key === 'reminders').n, 1);
  assert.equal(await run(), 1);
  const n = await notes();
  assert.equal(n.length, 1); assert.equal(n[0].link, 'relances'); assert.match(n[0].body, /Mariama Diallo.*622000111/);
  assert.equal(await run(), 0); assert.equal((await notes()).length, 1);                  // pas de doublon
});

test('rappel trop ancien : classé sans notification ; modification par l\'ancienne fonction : heure effacée', async () => {
  await db.owner.query(`UPDATE relance_reminders SET due_on = current_date - 5, notified_at = NULL WHERE seller_id = $1`, [w.seller]);
  assert.equal(await run(), 0);
  assert.equal((await notes()).length, 1);
  assert.ok((await db.owner.query(`SELECT notified_at FROM relance_reminders WHERE seller_id = $1`, [w.seller])).rows[0].notified_at);
  await call(db.app, 'fn_seller_relance_remind_at', w.seller, PHONE, iso(2), '17:30');
  await call(db.app, 'fn_seller_relance_remind', w.seller, PHONE, iso(3));
  const r = (await db.owner.query(`SELECT due_time, notified_at FROM relance_reminders WHERE seller_id = $1`, [w.seller])).rows[0];
  assert.equal(r.due_time, null); assert.equal(r.notified_at, null);
  assert.equal((await db.owner.query('SELECT count(*)::int AS n FROM fn_ledger_check()')).rows[0].n, 0);
});

test('retour arrière 083 : refusé s\'il existe des rappels avec heure, puis propre', async () => {
  await call(db.app, 'fn_seller_relance_remind_at', w.seller, PHONE, iso(2), '17:30');
  await assert.rejects(run2, /refusé/);
  await call(db.app, 'fn_seller_relance_remind_at', w.seller, PHONE, null, null);
  await run2();
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'relance_reminders' AND column_name = 'due_time'`)).rows[0].n, 0);
  const today = await call(db.app, 'fn_today', w.seller);
  assert.ok(!(today.items || []).some((i) => i.key === 'reminders'));
});
