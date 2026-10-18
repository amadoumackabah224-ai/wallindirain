// Tests HTTP : captures d'écran, numéro de versement, retraits payés avec preuve, mode test des codes.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, TEST_DB, APP_PW, PNG } from './helpers.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';

let srv, base, db;
const PW = 'Secret123';
const dataUrl = (buf, mime = 'image/png') => `data:${mime};base64,${buf.toString('base64')}`;

class Client {
  constructor() { this.cookie = ''; }
  async req(method, path, body, headers = {}) {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}), ...(method !== 'GET' ? { 'x-wld': '1' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie?.() ?? []) { const kv = c.split(';')[0]; this.cookie = kv.endsWith('=') ? '' : kv; }
    const buf = Buffer.from(await res.arrayBuffer());
    let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* binaire ou html */ }
    return { status: res.status, json, headers: res.headers, buf };
  }
  get(p, h) { return this.req('GET', p, undefined, h); }
  post(p, b = {}) { return this.req('POST', p, b); }
  async login(phone, password = PW) { const r = await this.post('/api/auth/login', { phone, password }); assert.equal(r.status, 200, JSON.stringify(r.json)); return this; }
}

beforeEach(() => srv.resetLimits());
before(async () => {
  db = await freshDb('wld_http2');
  await db.owner.query(`INSERT INTO users(role,status,full_name,phone,password_hash,identity_verified) VALUES ('admin','active','Admin','620000000',$1,true)`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  srv = await createServer({
    prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_http2', user: 'wld_app', password: APP_PW, max: 5 }, owner: {},
    messaging: { provider: 'simulated' }
  }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });

test('inscription : l\'opérateur de versement est obligatoire, le numéro par défaut est celui de connexion', async () => {
  const c = new Client();
  const base0 = { phone: '631000001', name: 'Vendeur Un', role: 'seller', password: PW, identity_doc: 'CNI-123456' };
  assert.equal((await c.post('/api/auth/register', base0)).status, 400);                                               // sans opérateur
  assert.equal((await c.post('/api/auth/register', { ...base0, payout_method: 'visa' })).status, 400);
  assert.equal((await c.post('/api/auth/register', { ...base0, payout_method: 'orange_money', payout_phone: '123' })).status, 400);
  assert.equal((await c.post('/api/auth/register', { ...base0, payout_method: 'orange_money' })).status, 201);
  await c.login('631000001');
  const wallet = (await c.get('/api/wallet')).json;
  assert.deepEqual(wallet.payout, { method: 'orange_money', phone: '631000001' });
});

test('numéro de versement : mot de passe exigé, une seule fois', async () => {
  // compte créé sans numéro (cas des comptes d'avant la mise à jour)
  await db.owner.query(`INSERT INTO users(role,status,full_name,phone,password_hash) VALUES ('seller','active','Ancien Vendeur','632000001',$1)`, [await hashPassword(PW)]);
  const c = await new Client().login('632000001');
  assert.equal((await c.get('/api/wallet')).json.payout.phone, null);
  assert.equal((await c.post('/api/me/payout', { method: 'mtn_momo', phone: '666111222', password: 'mauvais1' })).status, 403);
  assert.equal((await c.post('/api/me/payout', { method: 'mtn_momo', phone: '666111222', password: PW })).status, 200);
  const again = await c.post('/api/me/payout', { method: 'orange_money', phone: '622000000', password: PW });
  assert.equal(again.json.error, 'payout_locked');                                  // déjà défini : seule l'administration peut le changer
  assert.equal((await c.get('/api/wallet')).json.payout.phone, '666111222');
});

test('captures : types, taille et droits de l\'API', async () => {
  const admin = await new Client().login('620000000');
  const cr = await admin.post('/api/admin/users', { phone: '633000001', name: 'Livreur Un', role: 'courier', password: PW });
  assert.equal(cr.status, 201);
  const courier = await new Client().login('633000001');
  const seller = await new Client().login('631000001');

  const up = (c, kind, image) => c.post('/api/proofs', { kind, image });
  assert.equal((await up(admin, 'withdrawal_payment', dataUrl(PNG))).status, 201);
  assert.equal((await up(courier, 'remittance', dataUrl(PNG))).status, 201);
  assert.equal((await up(courier, 'withdrawal_payment', dataUrl(PNG))).status, 403);          // mauvais rôle pour ce type
  assert.equal((await up(seller, 'remittance', dataUrl(PNG))).status, 403);
  assert.equal((await up(new Client(), 'remittance', dataUrl(PNG))).status, 401);
  assert.equal((await up(admin, 'withdrawal_payment', 'pas une image')).status, 400);
  assert.equal((await up(admin, 'withdrawal_payment', dataUrl(Buffer.from('<?php echo 1; ?>'), 'image/png'))).status, 400);   // faux type : octets vérifiés
  assert.equal((await up(admin, 'withdrawal_payment', dataUrl(Buffer.concat([PNG, Buffer.alloc(650_000)])))).status, 413);
  assert.equal((await up(admin, 'withdrawal_payment', dataUrl(PNG, 'image/gif'))).status, 400);

  // affichage : l'auteur et l'admin voient l'image, un autre compte non
  const id = (await up(courier, 'remittance', dataUrl(PNG))).json.id;
  const mine = await courier.get(`/api/proofs/${id}`);
  assert.equal(mine.status, 200);
  assert.equal(mine.headers.get('content-type'), 'image/png');
  assert.deepEqual(mine.buf, PNG);
  assert.equal((await admin.get(`/api/proofs/${id}`)).status, 200);
  assert.equal((await seller.get(`/api/proofs/${id}`)).status, 403);
  assert.equal((await new Client().get(`/api/proofs/${id}`)).status, 401);
  assert.equal((await courier.get('/api/proofs/pas-un-uuid')).status, 400);
});

test('retrait de bout en bout : demande, code, paiement manuel avec capture, preuve visible du bénéficiaire', async () => {
  const admin = await new Client().login('620000000');
  const seller = await new Client().login('631000001');
  const sid = (await admin.get('/api/admin/users?role=seller')).json.users.find((u) => u.phone === '631000001').id;
  assert.equal((await admin.post(`/api/admin/users/${sid}/verify`, { verified: true })).status, 200);
  assert.equal((await admin.post('/api/admin/deposits', { user_id: sid, amount: 200000, reference: 'DEP-HTTP' })).status, 200);

  // la demande ne prend plus de numéro : il vient du compte
  const req = await seller.post('/api/withdrawals', { amount: 60000, method: 'mtn_momo', account: '666000000' });
  assert.equal(req.status, 201, JSON.stringify(req.json));
  // mode test : le code est lisible dans l'écran Messages de l'administrateur
  const msgs = (await admin.get('/api/admin/messages')).json;
  assert.equal(msgs.test_codes_visible, true);
  const code = /: (\d{6})\./.exec(msgs.messages.find((m) => m.template === 'withdrawal_code').body)[1];
  assert.equal((await seller.post(`/api/withdrawals/${req.json.id}/confirm`, { code })).status, 200);

  const list = (await admin.get('/api/admin/withdrawals')).json.withdrawals;
  const wd = list.find((x) => x.id === req.json.id);
  assert.equal(wd.account_number, '631000001');                      // numéro du compte, pas celui envoyé dans la requête
  assert.equal(wd.method, 'orange_money');

  // sans capture : refusé ; avec capture : payé
  const noProof = await admin.post(`/api/admin/withdrawals/${wd.id}/pay`, { payment_ref: 'OM-2026-77' });
  assert.equal(noProof.json.error, 'proof_required');
  const proof = (await admin.post('/api/proofs', { kind: 'withdrawal_payment', image: dataUrl(PNG) })).json.id;
  assert.equal((await admin.post(`/api/admin/withdrawals/${wd.id}/pay`, { payment_ref: 'OM-2026-77', proof_id: proof })).status, 200);

  const mine = (await seller.get('/api/wallet')).json.withdrawals.find((x) => x.id === wd.id);
  assert.equal(mine.status, 'paid');
  assert.equal(mine.proof_id, proof);
  assert.equal((await seller.get(`/api/proofs/${proof}`)).status, 200);        // le bénéficiaire voit la preuve de son transfert
});

test('mode test : les codes ne sont visibles que si SHOW_TEST_CODES et messages simulés', async () => {
  const { loadConfig } = await import('../src/config.js');
  const keep = { ...process.env };
  try {
    Object.assign(process.env, { SHOW_TEST_CODES: '1', MESSAGE_PROVIDER: 'whatsapp', WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_ID: 'p', DB_APP_PASSWORD: 'x' });
    assert.throws(() => loadConfig(), /SHOW_TEST_CODES/);
    Object.assign(process.env, { MESSAGE_PROVIDER: 'simulated' });
    assert.equal(loadConfig().showTestCodes, true);
    delete process.env.SHOW_TEST_CODES;
    assert.equal(loadConfig().showTestCodes, false);
  } finally { for (const k of ['SHOW_TEST_CODES', 'MESSAGE_PROVIDER', 'WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID', 'DB_APP_PASSWORD']) { if (k in keep) process.env[k] = keep[k]; else delete process.env[k]; } }
});

test('administration : réinitialisation du mot de passe avec mot de passe temporaire', async () => {
  const admin = await new Client().login('620000000');
  const users = (await admin.get('/api/admin/users')).json.users;
  const uid = users.find((u) => u.phone === '632000001').id;
  const r = await admin.post(`/api/admin/users/${uid}/reset-password`);
  assert.equal(r.status, 200);
  assert.match(r.json.temporary_password, /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{10}$/);
  await new Client().login('632000001', r.json.temporary_password);
  assert.equal((await new Client().post('/api/auth/login', { phone: '632000001', password: PW })).status, 401);
  assert.equal((await admin.post(`/api/admin/users/${uid}/update`, { name: 'Nouveau Nom', payout_method: 'orange_money', payout_phone: '622999888' })).status, 200);
  const after = (await admin.get('/api/admin/users')).json.users.find((u) => u.id === uid);
  assert.deepEqual([after.full_name, after.payout_method, after.payout_phone], ['Nouveau Nom', 'orange_money', '622999888']);
});

test('fichiers : revalidation (ETag) et adresse mal formée en 400', async () => {
  const c = new Client();
  const first = await c.get('/js/main.js');
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-cache');
  const etag = first.headers.get('etag');
  assert.ok(etag);
  assert.equal((await c.get('/js/main.js', { 'if-none-match': etag })).status, 304);
  assert.equal((await c.get('/%E0%A4%A')).status, 400);
  assert.equal((await c.get('/api/public/link/%E0%A4%A')).status, 400);
});
