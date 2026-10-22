// Adresse e-mail : vérification par code, connexion par numéro OU e-mail, mot de passe oublié par e-mail, confidentialité.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, TEST_DB, APP_PW } from './helpers.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';
import { toHtml } from '../src/email.js';

let srv, base, db;
const PW = 'Secret123';

class Client {
  constructor() { this.cookie = ''; }
  async req(method, path, body) {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}), ...(method !== 'GET' ? { 'x-wld': '1' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    for (const c of res.headers.getSetCookie?.() ?? []) { const kv = c.split(';')[0]; this.cookie = kv.endsWith('=') ? '' : kv; }
    let json = null; try { json = await res.json(); } catch { /* vide */ }
    return { status: res.status, json };
  }
  get(p) { return this.req('GET', p); }
  post(p, b = {}) { return this.req('POST', p, b); }
}
const login = async (identifier, password = PW) => { const c = new Client(); const r = await c.post('/api/auth/login', { identifier, password }); return { c, r }; };
const lastCode = async (email, template) => (await db.owner.query(`SELECT body FROM messages WHERE to_email = $1 AND template = $2 ORDER BY id DESC LIMIT 1`, [email, template])).rows[0].body.match(/est (\d{6})/)[1];

beforeEach(() => srv.resetLimits());
before(async () => {
  db = await freshDb('wld_email');
  const h = await hashPassword(PW);
  await db.owner.query(`INSERT INTO users(role,status,full_name,phone,password_hash,identity_verified) VALUES ('admin','active','Admin Mail','620000000',$1,true)`, [h]);
  await db.owner.query(`INSERT INTO users(role,status,full_name,phone,password_hash) VALUES ('seller','active','Awa Diallo','631000001',$1),('seller','active','Moussa Camara','631000002',$1)`, [h]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-19' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_email', user: 'wld_app', password: APP_PW, max: 5 }, owner: {}, messaging: { provider: 'simulated' }, email: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });

test('e-mail : ajout, code de vérification, puis connexion par e-mail', async () => {
  const { c } = await login('631000001');
  assert.equal((await c.post('/api/me/email', { email: 'awa@exemple.com', password: 'faux' })).status, 403);   // mot de passe exigé
  assert.equal((await c.post('/api/me/email', { email: 'pas-un-email', password: PW })).status, 400);
  assert.equal((await c.post('/api/me/email', { email: 'Awa@Exemple.com', password: PW })).status, 200);
  // tant que non confirmée : impossible de se connecter avec l'e-mail
  assert.equal((await login('awa@exemple.com')).r.status, 401);
  const me = (await c.get('/api/auth/me')).json.user;
  assert.equal(me.email, 'awa@exemple.com'); assert.equal(me.email_verified, false);
  // mauvais code puis bon code
  assert.equal((await c.post('/api/me/email/verify', { code: '000000' })).json.error, 'invalid_code');
  assert.equal((await c.post('/api/me/email/verify', { code: await lastCode('awa@exemple.com', 'email_verify') })).status, 200);
  const l = await login('AWA@exemple.com');                        // majuscules tolérées
  assert.equal(l.r.status, 200); assert.equal(l.r.json.user.name, 'Awa Diallo');
  assert.equal((await login('awa@exemple.com', 'Mauvais123')).r.status, 401);
  assert.equal((await login('631000001')).r.status, 200);          // le numéro marche toujours
});

test('e-mail : une adresse confirmée appartient à un seul compte', async () => {
  const { c } = await login('631000002');
  await c.post('/api/me/email', { email: 'awa@exemple.com', password: PW });
  const r = await c.post('/api/me/email/verify', { code: await lastCode('awa@exemple.com', 'email_verify') });
  assert.equal(r.status, 400); assert.equal(r.json.error, 'email_taken');
  assert.equal((await c.get('/api/auth/me')).json.user.email_verified, false);
});

test('mot de passe oublié : le code arrive par e-mail (jamais par numéro) quand l\'adresse est confirmée', async () => {
  const before = (await db.owner.query(`SELECT count(*)::int AS n FROM messages WHERE template = 'password_reset'`)).rows[0].n;
  const c = new Client();
  assert.equal((await c.post('/api/auth/forgot', { identifier: 'awa@exemple.com' })).status, 200);
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM messages WHERE template = 'password_reset'`)).rows[0].n, before);   // pas de message au numéro
  const code = await lastCode('awa@exemple.com', 'password_reset_email');
  assert.equal((await c.post('/api/auth/reset', { identifier: 'awa@exemple.com', code: '111111', password: 'Nouveau456' })).status, 400);
  assert.equal((await c.post('/api/auth/reset', { identifier: 'awa@exemple.com', code, password: 'Nouveau456' })).status, 200);
  assert.equal((await login('awa@exemple.com', 'Nouveau456')).r.status, 200);
  assert.equal((await login('631000001', PW)).r.status, 401);
  // même réponse pour une adresse inconnue : rien n'est révélé
  const inconnu = await c.post('/api/auth/forgot', { identifier: 'inconnu@exemple.com' });
  assert.equal(inconnu.status, 200);
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM messages WHERE to_email = 'inconnu@exemple.com'`)).rows[0].n, 0);
});

test('mot de passe oublié par numéro : e-mail si confirmé, sinon message au numéro', async () => {
  const c = new Client();
  await c.post('/api/auth/forgot', { identifier: '631000002' });     // pas d'e-mail confirmé : message au numéro
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM messages WHERE to_phone = '631000002' AND template = 'password_reset'`)).rows[0].n, 1);
  const n = (await db.owner.query(`SELECT count(*)::int AS n FROM messages WHERE to_email = 'awa@exemple.com' AND template = 'password_reset_email'`)).rows[0].n;
  await c.post('/api/auth/forgot', { identifier: '631000001' });     // e-mail confirmé : va dans la boîte
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM messages WHERE to_email = 'awa@exemple.com' AND template = 'password_reset_email'`)).rows[0].n, n + 1);
});

test('inscription avec e-mail : code envoyé, adresse invalide refusée avant création', async () => {
  const c = new Client();
  const bad = await c.post('/api/auth/register', { role: 'seller', name: 'Test Un', phone: '631000010', email: 'x', password: PW, accept_terms: true, payout_method: 'orange_money' });
  assert.equal(bad.status, 400);
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM users WHERE phone = '631000010'`)).rows[0].n, 0);
  const ok = await c.post('/api/auth/register', { role: 'seller', name: 'Test Un', phone: '631000010', email: 'un@exemple.com', password: PW, accept_terms: true, payout_method: 'orange_money' });
  assert.equal(ok.status, 201); assert.equal(ok.json.email_pending, true);
  const { c: u } = await login('631000010');
  assert.equal((await u.post('/api/me/email/verify', { code: await lastCode('un@exemple.com', 'email_verify') })).status, 200);
  assert.equal((await login('un@exemple.com')).r.status, 200);
});

test('e-mail : changement d\'adresse = nouvelle vérification et alerte sur l\'ancienne ; codes masqués après envoi réel', async () => {
  const { c } = await login('631000001', 'Nouveau456');
  await c.post('/api/me/email', { email: 'awa2@exemple.com', password: 'Nouveau456' });
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM messages WHERE to_email = 'awa@exemple.com' AND template = 'email_changed'`)).rows[0].n, 1);
  assert.equal((await login('awa2@exemple.com', 'Nouveau456')).r.status, 401);   // pas encore confirmée
  assert.equal((await login('awa@exemple.com', 'Nouveau456')).r.status, 401);    // l'ancienne n'est plus valable
  await db.owner.query(`SELECT fn_message_mark(id, 'sent') FROM messages WHERE template = 'email_verify' AND to_email = 'awa2@exemple.com'`);
  assert.doesNotMatch((await db.owner.query(`SELECT body FROM messages WHERE template = 'email_verify' AND to_email = 'awa2@exemple.com'`)).rows[0].body, /\d{6}/);
});

test('connexion : verrouillage après 5 échecs, aussi par e-mail', async () => {
  const { c } = await login('631000002');
  await c.post('/api/me/email', { email: 'moussa@exemple.com', password: PW });
  await c.post('/api/me/email/verify', { code: await lastCode('moussa@exemple.com', 'email_verify') });
  for (let i = 0; i < 5; i++) { await login('moussa@exemple.com', 'Faux12345'); srv.resetLimits(); }
  const r = await login('631000002', PW);
  assert.equal(r.r.status === 200, false);
});

test('admin : voit les e-mails envoyés ; un vendeur n\'y a pas accès', async () => {
  const { c: a } = await login('620000000');
  const m = (await a.get('/api/admin/messages')).json;
  assert.ok(m.messages.some((x) => x.channel === 'email' && x.to_email));
  const { c: s } = await login('631000001', 'Nouveau456');
  assert.equal((await s.get('/api/admin/messages')).status, 403);     // un vendeur ne voit jamais la file des messages
  assert.equal((await s.get('/api/admin/users')).status, 403);
});

test('mise en forme des e-mails : le contenu est échappé', () => {
  const html = toHtml('Bonjour <script>alert(1)</script>\n\nCode 123456');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /123456/);
});
