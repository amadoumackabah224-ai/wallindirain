// Administration de Mes finances : liste des personnes (y compris celles sans opération), statut, suspension.
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
  db = await freshDb('wld_pfa'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  await db.owner.query(`UPDATE settings SET value = 1 WHERE key = 'feature_finances_perso'`);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_pfa', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
  const ph = (await rows('SELECT phone FROM users WHERE id = $1', [w.admin]))[0].phone;
  assert.equal((await call('POST', '/api/auth/login', { identifier: ph, password: PW })).status, 200);
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });


test('la liste montre aussi les membres sans opération, avec statut et dernière activité', async () => {
  await db.owner.query(`INSERT INTO pf_access(owner_id, trial_until) VALUES ($1, now())`, [w.seller]);
  await db.owner.query(`INSERT INTO pf_accounts(owner_id, name, kind, color) VALUES ($1, 'Caisse', 'cash', 'teal')`, [w.seller]);
  const a = (await rows('SELECT id FROM pf_accounts WHERE owner_id = $1', [w.seller]))[0].id;
  await db.owner.query(`INSERT INTO pf_transactions(owner_id, account_id, kind, amount, category, occurred_on) VALUES ($1, $2, 'income', 100, 'unassigned_income', current_date)`, [w.seller, a]);
  await db.owner.query(`UPDATE users SET role = 'member' WHERE id = $1`, [w.seller2]);
  const l = (await call('GET', '/api/admin/pf')).json.users;
  const s1 = l.find((u) => u.id === w.seller), s2 = l.find((u) => u.id === w.seller2);
  assert.ok(s1 && s1.last_activity && s1.status === 'active' && s1.transactions === 1);
  assert.ok(s2 && s2.transactions === 0 && s2.last_activity === null, 'membre sans aucune opération visible');
  assert.equal(l.some((u) => u.id === w.courier), false, 'les autres rôles sans Mes finances n\'y sont pas');
});

test('suspendre puis réactiver une personne depuis l\'administration', async () => {
  assert.equal((await call('POST', `/api/admin/users/${w.seller2}/status`, { status: 'suspended' })).status, 200);
  assert.equal((await call('GET', '/api/admin/pf')).json.users.find((u) => u.id === w.seller2).status, 'suspended');
  assert.equal((await call('POST', `/api/admin/users/${w.seller2}/status`, { status: 'active' })).status, 200);
});
