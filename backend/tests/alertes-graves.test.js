// Migration 066 : alertes graves aux administrateurs. Anti-doublon, réglage, aucune donnée personnelle, retour arrière.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { splitSql } from '../src/migrate.js';
import { freshDb, world, call } from './helpers.js';

let db, w;
const root = path.resolve(import.meta.dirname, '..', '..');
const notifs = async () => (await db.owner.query(`SELECT count(*)::int AS c FROM notifications WHERE user_id = $1 AND kind = 'system' AND title = 'Alerte technique'`, [w.admin])).rows[0].c;
const msgs = async () => (await db.owner.query(`SELECT count(*)::int AS c FROM messages WHERE template = 'ops_alert'`)).rows[0].c;

before(async () => { db = await freshDb('wld_alertes'); w = await world(db); });
after(async () => { await db.owner.end(); await db.app.end(); });

test('une alerte prévient l\'admin (cloche + message) une seule fois par tranche de 30 min', async () => {
  assert.equal((await db.owner.query('SELECT fn_ops_alert($1, $2) AS r', ['error', 'Erreur interne sur /api/orders'])).rows[0].r, true);
  assert.equal((await db.owner.query('SELECT fn_ops_alert($1, $2) AS r', ['error', 'Erreur interne sur /api/orders'])).rows[0].r, false);
  assert.equal(await notifs(), 1);
  assert.equal(await msgs(), 1);
  assert.equal((await db.owner.query('SELECT fn_ops_alert($1, $2) AS r', ['autre', 'Autre type'])).rows[0].r, true);
});

test('le réglage ops_alerts = 0 coupe les alertes', async () => {
  await db.owner.query(`UPDATE settings SET value = 0 WHERE key = 'ops_alerts'`);
  const before = await notifs();
  assert.equal((await db.owner.query('SELECT fn_ops_alert($1, $2) AS r', ['coupe', 'Ne doit pas partir'])).rows[0].r, false);
  assert.equal(await notifs(), before);
  await db.owner.query(`UPDATE settings SET value = 1 WHERE key = 'ops_alerts'`);
});

test('contrôles : messages bloqués détectés, base saine = aucune alerte de comptes', async () => {
  const ok = (await db.owner.query('SELECT fn_run_ops_checks() AS r')).rows[0].r;
  assert.equal(ok.ledger, 0);
  for (let i = 0; i < 3; i++) await db.owner.query(`INSERT INTO messages(to_phone, channel, template, body, status) VALUES ('620000000', 'whatsapp', 'x', 'y', 'failed')`);
  const r = (await db.owner.query('SELECT fn_run_ops_checks() AS r')).rows[0].r;
  assert.equal(r.failed >= 3, true);
  assert.equal(r.alerts >= 1, true);
});

test('retour arrière : fonctions et réglage retirés, notifications conservées', async () => {
  const n = await notifs();
  const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-066.sql'), 'utf8');
  await db.owner.query('BEGIN'); for (const q of splitSql(rb)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT');
  assert.equal((await db.owner.query(`SELECT count(*)::int AS c FROM pg_proc WHERE proname IN ('fn_ops_alert','fn_run_ops_checks')`)).rows[0].c, 0);
  assert.equal(await notifs(), n);
});
