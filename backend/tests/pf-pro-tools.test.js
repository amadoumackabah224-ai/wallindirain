// 059 : export CSV, règles automatiques et import (fonctions Pro).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshDb, TEST_DB, APP_PW, world } from './helpers.js';
import { splitSql } from '../src/migrate.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';

const PW = 'Secret123';
const root = path.resolve(import.meta.dirname, '..', '..');
let db, w, srv, base, cookie = '';
const call = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'x-wld': '1' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  for (const c of res.headers.getSetCookie?.() ?? []) { const kv = c.split(';')[0]; cookie = kv.endsWith('=') ? '' : kv; }
  let json = null; try { json = await res.json(); } catch { /* vide */ }
  return { status: res.status, json };
};
const rows = async (sql, p) => (await db.owner.query(sql, p)).rows;
const today = new Date().toISOString().slice(0, 10);

before(async () => {
  db = await freshDb('wld_pft'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  await db.owner.query(`UPDATE settings SET value = 1 WHERE key = 'feature_finances_perso'`);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_pft', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
  await db.owner.query(`UPDATE settings SET value = 0 WHERE key = 'pf_trial_days'`);
  const ph = (await rows('SELECT phone FROM users WHERE id = $1', [w.seller]))[0].phone;
  assert.equal((await call('POST', '/api/auth/login', { identifier: ph, password: PW })).status, 200);
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });


const setPrice = (m) => db.owner.query(`UPDATE settings SET value = $1 WHERE key = 'pf_price_monthly'`, [m]);
let acc;
test('formule gratuite : export, règles et import demandent Pro', async () => {
  await setPrice(5000);
  acc = (await call('POST', '/api/pf/accounts', { name: 'Caisse', kind: 'cash', color: 'teal', opening_balance: 0 })).json.id;
  assert.equal((await call('GET', '/api/pf/export')).status, 403);
  assert.equal((await call('POST', '/api/pf/rules', { contains: 'orange', category: 'telecom' })).status, 403);
  assert.equal((await call('POST', '/api/pf/import', { account_id: acc, rows: [{ date: today, kind: 'expense', amount: 100 }] })).status, 403);
});

test('règles : création, doublon, catégorie invalide, suppression', async () => {
  await setPrice(0);
  const r = await call('POST', '/api/pf/rules', { contains: ' Orange ', category: 'telecom' });
  assert.equal(r.status, 201);
  assert.equal((await call('POST', '/api/pf/rules', { contains: 'orange', category: 'telecom' })).status, 409);
  assert.equal((await call('POST', '/api/pf/rules', { contains: 'x', category: 'telecom' })).status, 400);
  assert.equal((await call('POST', '/api/pf/rules', { contains: 'zzz', kind: 'expense', category: 'unassigned_income' })).status, 400);
  assert.equal((await call('POST', '/api/pf/rules', { contains: 'riz', kind: 'expense', category: 'food' })).status, 201);
  const l = (await call('GET', '/api/pf/rules')).json.rules;
  assert.deepEqual(l.map((x) => x.contains), ['orange', 'riz']);
  assert.equal((await call('POST', `/api/pf/rules/${l[1].id}/remove`)).status, 200);
  assert.equal((await call('POST', `/api/pf/rules/${l[1].id}/remove`)).status, 404);
});

test('import : règles appliquées, repli, lignes invalides ignorées, export CSV', async () => {
  const rowsIn = [
    { date: today, kind: 'expense', amount: 5000, note: 'Recharge ORANGE' },
    { date: today, kind: 'expense', amount: 7000, note: 'Autre chose' },
    { date: today, kind: 'income', amount: 20000, note: '=cmd|x', category: 'nimporte' },
    { date: 'pas-une-date', kind: 'income', amount: 1 },
    { date: today, kind: 'income', amount: -5 },
    { date: today, kind: 'virement', amount: 5 }];
  const r = await call('POST', '/api/pf/import', { account_id: acc, rows: rowsIn });
  assert.equal(r.status, 200); assert.equal(r.json.added, 3); assert.equal(r.json.skipped, 3); assert.equal(r.json.errors.length, 3);
  const tx = await rows('SELECT category, note, amount FROM pf_transactions WHERE owner_id = $1 ORDER BY amount', [w.seller]);
  assert.deepEqual(tx.map((t) => t.category), ['telecom', 'other_out', 'unassigned_income']);
  assert.equal((await call('POST', '/api/pf/import', { account_id: acc, rows: [] })).status, 400);
  assert.equal((await call('POST', '/api/pf/import', { account_id: acc, rows: Array(501).fill(rowsIn[0]) })).status, 400);
  const res = await fetch(`${base}/api/pf/export?from=${today}`, { headers: { cookie } });
  assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /text\/csv/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM pour Excel');
  const txt = buf.toString('utf8').slice(1);
  assert.ok(txt.startsWith('Date;Type;Compte;Catégorie;Montant;Devise;Note'));
  assert.match(txt, /Dépense;Caisse;Téléphone et internet;-5000;GNF;Recharge ORANGE/);
  assert.match(txt, /'=cmd\|x/, 'pas d\'injection de formule');
  assert.equal((await rows('SELECT count(*)::int n FROM pf_transactions WHERE owner_id = $1', [w.seller]))[0].n, 3);
});

test('effacement des données retire aussi les règles ; retour arrière refusé s\'il y a des règles', async () => {
  const sql = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-059.sql'), 'utf8');
  await assert.rejects(async () => { for (const st of splitSql(sql)) await db.owner.query(st); });
  assert.equal((await call('POST', '/api/pf/erase', { confirm: 'EFFACER' })).status, 200);
  assert.equal((await rows('SELECT count(*)::int n FROM pf_rules WHERE owner_id = $1', [w.seller]))[0].n, 0);
  for (const st of splitSql(sql)) await db.owner.query(st);
  assert.equal((await rows(`SELECT count(*)::int n FROM pg_proc WHERE proname IN ('fn_pf_tx_import','fn_pf_rule_save')`))[0].n, 0);
});
