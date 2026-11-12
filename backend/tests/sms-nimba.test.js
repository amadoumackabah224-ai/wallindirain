// 064 : codes par SMS (Nimba) — réglage éteint par défaut, refus sans identifiants, envoi par l'API Nimba, repli et retour arrière.
import http from 'node:http';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshDb, TEST_DB, APP_PW, world } from './helpers.js';
import { splitSql } from '../src/migrate.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';

const PW = 'Secret123';
const root = path.resolve(import.meta.dirname, '..', '..');
let db, w, srv, base;
class Client {
  constructor() { this.cookie = ''; }
  async req(method, p, body) {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}), ...(method !== 'GET' ? { 'x-wld': '1' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    for (const c of res.headers.getSetCookie?.() ?? []) { const kv = c.split(';')[0]; this.cookie = kv.endsWith('=') ? '' : kv; }
    let json = null; try { json = await res.json(); } catch { /* vide */ }
    return { status: res.status, json };
  }
  get(p) { return this.req('GET', p); }
  post(p, b = {}) { return this.req('POST', p, b); }
}
const rows = async (sql, p) => (await db.owner.query(sql, p)).rows;
const login = async (id) => { const c = new Client(); const ph = (await rows('SELECT phone FROM users WHERE id = $1', [id]))[0].phone; assert.equal((await c.post('/api/auth/login', { identifier: ph, password: PW })).status, 200); return c; };
const today = new Date().toISOString().slice(0, 10);

let nimba, hits = [], mode = 'ok', admin, seller;
const cfgBase = (sms) => ({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
  db: { ...TEST_DB, database: 'wld_sms', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' }, ...(sms ? { sms } : {}) });
const start = async (sms) => {
  if (srv) await srv.close();
  srv = await createServer(cfgBase(sms), { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
  admin = await login(w.admin); seller = await login(w.seller);
};
const queued = async (tpl) => (await rows(`SELECT channel, status FROM messages WHERE template = $1 ORDER BY id DESC LIMIT 1`, [tpl]))[0];

before(async () => {
  db = await freshDb('wld_sms'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  nimba = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: b ? JSON.parse(b) : null });
      if (req.url === '/v1/accounts') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ sms_balance: 321 })); }
      if (mode === 'fail') { res.statusCode = 400; return res.end('{"detail":"refusé"}'); }
      res.statusCode = 201; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ messageid: 'm-1', message_cost: 1 }));
    });
  });
  await new Promise((r) => nimba.listen(0, '127.0.0.1', r));
  await start(null);
});
beforeEach(() => { srv.resetLimits(); hits = []; mode = 'ok'; });
after(async () => { await srv.close(); await new Promise((r) => nimba.close(r)); await db.owner.end(); await db.app.end(); });


const sms = () => ({ serviceId: 'SID123', secretToken: 'TOK456', senderName: 'WALLIN', baseUrl: `http://127.0.0.1:${nimba.address().port}/v1`, phoneFormat: 'international' });

test('éteint par défaut, et impossible à allumer sans identifiants sur le serveur', async () => {
  assert.equal(Number((await rows(`SELECT value FROM settings WHERE key = 'sms_codes'`))[0].value), 0);
  const st = (await admin.get('/api/admin/sms')).json;
  assert.equal(st.configured, false); assert.equal(st.enabled, false);
  const r = await admin.post('/api/admin/settings', { key: 'sms_codes', value: 1 });
  assert.equal(r.status, 409);
  assert.equal(Number((await rows(`SELECT value FROM settings WHERE key = 'sms_codes'`))[0].value), 0);
  assert.equal((await admin.post('/api/admin/sms/test', { phone: '622000001' })).status, 409);
  assert.equal((await seller.get('/api/admin/sms')).status, 403);
  await db.app.query(`SELECT _queue_message('622000001', 'password_reset', 'Wallindirain : votre code est 123456')`).catch(() => null);
  assert.equal((await queued('password_reset'))?.channel ?? 'whatsapp', 'whatsapp');
});

test('avec identifiants : état sans secrets, SMS de test envoyé avec l\'authentification Nimba', async () => {
  await start(sms());
  const st = (await admin.get('/api/admin/sms')).json;
  assert.equal(st.configured, true); assert.equal(st.balance, 321); assert.equal(st.sender_name, 'WALLIN');
  assert.ok(!JSON.stringify(st).includes('TOK456') && !JSON.stringify(st).includes('SID123'), 'aucun secret renvoyé');
  hits = [];
  assert.equal((await admin.post('/api/admin/sms/test', { phone: '622000001' })).status, 200);
  const h = hits.find((x) => x.url === '/v1/messages');
  assert.equal(h.method, 'POST');
  assert.equal(h.auth, `Basic ${Buffer.from('SID123:TOK456').toString('base64')}`);
  assert.deepEqual(h.body.to, ['224622000001']); assert.equal(h.body.sender_name, 'WALLIN'); assert.match(h.body.message, /test/);
  mode = 'fail';
  const bad = await admin.post('/api/admin/sms/test', { phone: '622000001' });
  assert.equal(bad.status, 502); assert.match(bad.json.error?.message || bad.json.message || JSON.stringify(bad.json), /400/);
});

test('allumé : les codes partent par SMS (les autres messages restent sur WhatsApp), marqués envoyés ou échoués', async () => {
  assert.equal((await admin.post('/api/admin/settings', { key: 'sms_codes', value: 1 })).status, 200);
  await db.owner.query(`SELECT _queue_message('622000002', 'withdrawal_code', 'Wallindirain : retrait de 5 000 GNF : 654321')`);
  await db.owner.query(`SELECT _queue_message('622000002', 'order_confirmed', 'Wallindirain : commande confirmée')`);
  assert.equal((await queued('withdrawal_code')).channel, 'sms');
  assert.equal((await queued('order_confirmed')).channel, 'whatsapp');
  hits = [];
  await srv.worker.flushMessages();
  const sent = hits.filter((x) => x.url === '/v1/messages');
  assert.equal(sent.length, 1); assert.match(sent[0].body.message, /654321/);
  assert.equal((await queued('withdrawal_code')).status, 'sent');
  mode = 'fail';
  await db.owner.query(`SELECT _queue_message('622000003', 'delivery_code', 'Wallindirain : Code de livraison : 4321')`);
  await srv.worker.flushMessages();
  assert.equal((await queued('delivery_code')).status, 'failed');
});

test('identifiants retirés alors que le réglage est allumé : le code part quand même (repli), rien ne se perd', async () => {
  await start(null);
  await db.owner.query(`SELECT _queue_message('622000004', 'password_reset', 'Wallindirain : votre code est 111222')`);
  assert.equal((await queued('password_reset')).channel, 'sms');
  hits = [];
  await srv.worker.flushMessages();
  assert.equal(hits.filter((x) => x.url === '/v1/messages').length, 0);
  assert.equal((await queued('password_reset')).status, 'simulated');
});

test('retour arrière : tout repart par WhatsApp, réglage retiré', async () => {
  const sql = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-064.sql'), 'utf8');
  await db.owner.query('BEGIN'); for (const q of splitSql(sql)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT');
  assert.equal(Number((await rows(`SELECT count(*) n FROM settings WHERE key = 'sms_codes'`))[0].n), 0);
  await db.owner.query(`SELECT _queue_message('622000005', 'password_reset', 'Wallindirain : votre code est 333444')`);
  assert.equal((await queued('password_reset')).channel, 'whatsapp');
});
