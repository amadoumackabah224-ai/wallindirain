// Vérification d'identité (KYC) avec images : dépôt, examen par l'administrateur, transparence, droits, suppression.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, TEST_DB, APP_PW, PNG } from './helpers.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';

let srv, base, db;
const PW = 'Secret123';
const IMG = `data:image/png;base64,${Buffer.concat([PNG, Buffer.alloc(3000, 7)]).toString('base64')}`;

class Client {
  constructor() { this.cookie = ''; }
  async req(method, path, body) {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}), ...(method !== 'GET' ? { 'x-wld': '1' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie?.() ?? []) { const kv = c.split(';')[0]; this.cookie = kv.endsWith('=') ? '' : kv; }
    const buf = Buffer.from(await res.arrayBuffer());
    let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* binaire */ }
    return { status: res.status, json, buf, headers: res.headers };
  }
  get(p) { return this.req('GET', p); }
  post(p, b = {}) { return this.req('POST', p, b); }
  async login(phone) { const r = await this.post('/api/auth/login', { phone, password: PW }); assert.equal(r.status, 200, JSON.stringify(r.json)); return this; }
}
beforeEach(() => srv.resetLimits());
before(async () => {
  db = await freshDb('wld_kyc');
  const h = await hashPassword(PW);
  await db.owner.query(`INSERT INTO users(role,status,full_name,phone,password_hash,identity_verified) VALUES ('admin','active','Admin KYC','620000000',$1,true)`, [h]);
  await db.owner.query(`INSERT INTO users(role,status,full_name,phone,password_hash,payout_method,payout_phone) VALUES ('seller','active','Vendeur KYC','633000001',$1,'orange_money','633000001'),('seller','active','Autre KYC','633000002',$1,'orange_money','633000002'),('warehouse','active','Magasinier KYC','633000003',$1,NULL,NULL)`, [h]);
  await db.owner.query(`UPDATE settings SET value = 1 WHERE key = 'kyc_images_required'`);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-19' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_kyc', user: 'wld_app', password: APP_PW, max: 5 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });

test('KYC : images obligatoires, examen par l\'administrateur, consultations tracées pour l\'admin seulement', async () => {
  const s = await new Client().login('633000001'); const a = await new Client().login('620000000'); const o = await new Client().login('633000002');
  const sid = (await db.owner.query(`SELECT id FROM users WHERE phone='633000001'`)).rows[0].id;
  assert.equal((await s.get('/api/me/identity')).json.status, 'none');
  // envoi incomplet refusé
  assert.equal((await s.post('/api/me/identity/submit')).status, 400);
  assert.equal((await s.post('/api/me/identity', { identity_doc: 'CNI-998877' })).status, 200);
  assert.equal((await s.post('/api/me/identity/image', { side: 'front', doc_type: 'cni', image: IMG })).status, 200);
  assert.equal((await s.post('/api/me/identity/submit')).status, 400);          // selfie manquant
  assert.equal((await s.post('/api/me/identity/image', { side: 'selfie', doc_type: 'cni', image: IMG })).status, 200);
  assert.equal((await s.post('/api/me/identity/image', { side: 'front', doc_type: 'cni', image: 'data:text/html;base64,AAAA' })).status, 400);
  // l'administrateur ne peut pas valider avant l'envoi
  assert.equal((await a.post(`/api/admin/users/${sid}/verify`, { verified: true })).json.error, 'kyc_images_missing');
  assert.equal((await s.post('/api/me/identity/submit')).status, 200);
  assert.equal((await s.get('/api/me/identity')).json.status, 'submitted');
  // pendant l'examen, plus de modification
  assert.equal((await s.post('/api/me/identity/image', { side: 'back', doc_type: 'cni', image: IMG })).json.error, 'invalid_state');
  // droits : un autre vendeur ne voit pas ces images, l'administrateur oui
  assert.equal((await o.get(`/api/identity/${sid}/front`)).status, 403);
  assert.equal((await new Client().get(`/api/identity/${sid}/front`)).status, 401);
  assert.equal((await s.get(`/api/identity/${sid}/front`)).status, 200);          // la personne voit ses images, sans trace
  assert.equal((await s.get('/api/me/identity')).json.views, undefined);   // la personne ne voit jamais l'historique des consultations
  const img = await a.get(`/api/identity/${sid}/front`);
  assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png'); assert.equal(img.headers.get('cache-control'), 'no-store');
  assert.equal((await a.get(`/api/identity/${sid}/back`)).status, 404);
  // la consultation par l'admin est tracée pour l'administration, mais n'est jamais montrée à la personne
  assert.equal((await s.get('/api/me/identity')).json.views, undefined);
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'identity_image_viewed'`)).rows[0].n, 1);
  // les colonnes d'images ne sont pas lisibles directement par l'application
  await assert.rejects(db.app.query('SELECT front FROM identity_documents'));
  // refus avec motif, puis nouvel envoi et validation
  assert.equal((await a.post(`/api/admin/users/${sid}/reject-identity`, { reason: 'x' })).status, 400);
  assert.equal((await a.post(`/api/admin/users/${sid}/reject-identity`, { reason: 'Selfie flou' })).status, 200);
  const rej = (await s.get('/api/me/identity')).json; assert.equal(rej.status, 'rejected'); assert.equal(rej.reject_reason, 'Selfie flou');
  assert.equal((await s.post('/api/me/identity/image', { side: 'selfie', doc_type: 'cni', image: IMG })).status, 200);
  assert.equal((await s.post('/api/me/identity/submit')).status, 200);
  assert.equal((await a.post(`/api/admin/users/${sid}/verify`, { verified: true })).status, 200);
  const w = (await s.get('/api/wallet')).json; assert.equal(w.identity_verified, true); assert.equal(w.kyc_status.status, 'verified');
  // figé une fois vérifié
  assert.equal((await s.post('/api/me/identity/image', { side: 'front', doc_type: 'cni', image: IMG })).json.error, 'identity_locked');
  // la liste admin signale l'état
  const list = (await a.get('/api/admin/users')).json.users.find((u) => u.id === sid);
  assert.equal(list.kyc_status, 'verified');
});

test('KYC : le personnel qui reçoit de l\'argent (livreur) peut lui aussi envoyer sa pièce', async () => {
  await db.owner.query(`INSERT INTO users(role,status,full_name,phone,password_hash,payout_method,payout_phone) VALUES ('courier','active','Livreur KYC','633000009',$1,'mtn_momo','633000009')`, [await hashPassword(PW)]);
  const c = await new Client().login('633000009');
  assert.equal((await c.post('/api/me/identity', { identity_doc: 'CNI-112233' })).status, 200);
  assert.equal((await c.post('/api/me/identity/image', { side: 'front', doc_type: 'cni', image: IMG })).status, 200);
  assert.equal((await c.post('/api/me/identity/image', { side: 'selfie', doc_type: 'cni', image: IMG })).status, 200);
  assert.equal((await c.post('/api/me/identity/submit')).status, 200);
  assert.equal((await c.get('/api/me/identity')).json.status, 'submitted');
});

test('KYC : réglage désactivé = validation sans images ; magasinier exclu ; anonymisation supprime les images', async () => {
  const a = await new Client().login('620000000');
  const m = await new Client().login('633000003');
  assert.equal((await m.get('/api/me/identity')).status, 403);
  const oid = (await db.owner.query(`SELECT id FROM users WHERE phone='633000002'`)).rows[0].id;
  assert.equal((await a.post(`/api/admin/users/${oid}/verify`, { verified: true })).status, 400);
  await db.owner.query(`UPDATE settings SET value = 0 WHERE key = 'kyc_images_required'`);
  assert.equal((await a.post(`/api/admin/users/${oid}/verify`, { verified: true })).status, 200);
  await db.owner.query(`UPDATE settings SET value = 1 WHERE key = 'kyc_images_required'`);
  const o = await new Client().login('633000002');
  await o.post('/api/me/identity', { identity_doc: 'PASS-1234' }).catch(() => {});
  assert.equal((await db.owner.query('SELECT count(*)::int AS n FROM identity_documents')).rows[0].n >= 1, true);
  await db.owner.query(`UPDATE users SET deleted_at = now(), status = 'suspended' WHERE phone = '633000001'`);
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM identity_documents WHERE user_id = (SELECT id FROM users WHERE phone='633000001')`)).rows[0].n, 0);
});
