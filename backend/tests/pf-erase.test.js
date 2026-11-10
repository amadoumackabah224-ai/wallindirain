// 058 : la personne efface elle-même ses données Mes finances (et rien d'autre).
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
  db = await freshDb('wld_pfe'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  await db.owner.query(`UPDATE settings SET value = 1 WHERE key = 'feature_finances_perso'`);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_pfe', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
  const ph = (await rows('SELECT phone FROM users WHERE id = $1', [w.seller]))[0].phone;
  assert.equal((await call('POST', '/api/auth/login', { identifier: ph, password: PW })).status, 200);
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });

test('effacement : confirmation obligatoire, puis les données Mes finances disparaissent, le compte reste', async () => {
  const acc = (await call('POST', '/api/pf/accounts', { name: 'Caisse', kind: 'cash', color: 'teal', opening_balance: 1000 })).json.id;
  assert.equal((await call('POST', '/api/pf/transactions', { account_id: acc, kind: 'expense', amount: 100, category: 'food', occurred_on: today })).status, 201);
  assert.equal((await call('POST', '/api/pf/erase', { confirm: 'non' })).status, 400);
  assert.equal((await rows('SELECT count(*)::int n FROM pf_accounts WHERE owner_id = $1', [w.seller]))[0].n, 1);
  assert.equal((await call('POST', '/api/pf/erase', { confirm: 'EFFACER' })).status, 200);
  for (const t of ['pf_accounts', 'pf_transactions', 'pf_prefs', 'pf_budgets', 'pf_contacts']) assert.equal((await rows(`SELECT count(*)::int n FROM ${t} WHERE owner_id = $1`, [w.seller]))[0].n, 0, t);
  assert.equal((await rows('SELECT deleted_at FROM users WHERE id = $1', [w.seller]))[0].deleted_at, null, 'le compte reste');
  assert.equal((await call('GET', '/api/pf/accounts')).status, 200, 'on peut recommencer');
});

test('un autre utilisateur n\'est pas touché ; propriétaire d\'un espace actif : refusé', async () => {
  await db.owner.query(`INSERT INTO pf_accounts(owner_id, name, kind, color) VALUES ($1, 'Autre', 'cash', 'teal')`, [w.seller2]);
  await db.owner.query(`UPDATE settings SET value = 1 WHERE key IN ('pf_spaces')`);
  await db.owner.query(`UPDATE settings SET value = 0 WHERE key = 'pf_price_monthly'`);
  const sp = await call('POST', '/api/pf/spaces', { name: 'Boutique' });
  assert.equal(sp.status, 201);
  const r = await call('POST', '/api/pf/erase', { confirm: 'EFFACER' });
  assert.equal(r.status, 409);
  assert.equal((await rows('SELECT count(*)::int n FROM pf_accounts WHERE owner_id = $1', [w.seller2]))[0].n, 1);
  assert.equal((await call('POST', `/api/pf/spaces/${sp.json.id}/archive`, { archived: true })).status, 200);
  assert.equal((await call('POST', '/api/pf/erase', { confirm: 'EFFACER' })).status, 200);
  assert.equal((await rows('SELECT count(*)::int n FROM pf_accounts WHERE owner_id = $1', [w.seller2]))[0].n, 1);
});

test('droits de la base et retour arrière', async () => {
  await assert.rejects(db.app.query('SELECT _err($1, $2)', ['x', 'y']));
  const sql = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-058.sql'), 'utf8');
  for (const st of splitSql(sql)) await db.owner.query(st);
  assert.equal((await rows(`SELECT count(*)::int n FROM pg_proc WHERE proname = 'fn_pf_erase'`))[0].n, 0);
});
