// Conformité : pages légales, consentement, demandes sur les données, anonymisation, purge, profil, messagerie, remise à zéro.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, call, expectErr, TEST_DB, APP_PW, PNG, world, approvedProduct } from './helpers.js';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { createLegal, legalMissing, PAGES } from '../src/legal.js';
import { hashPassword } from '../src/security.js';

let srv, base, db;
const PW = 'Secret123';
const BIG = Buffer.concat([PNG, Buffer.alloc(300, 1)]);
const dataUrl = (buf) => `data:image/png;base64,${buf.toString('base64')}`;

class Client {
  constructor() { this.cookie = ''; }
  async req(method, path, body) {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}), ...(method !== 'GET' ? { 'x-wld': '1' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie?.() ?? []) { const kv = c.split(';')[0]; this.cookie = kv.endsWith('=') ? '' : kv; }
    const buf = Buffer.from(await res.arrayBuffer());
    let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* html */ }
    return { status: res.status, json, headers: res.headers, buf, text: buf.toString('utf8') };
  }
  get(p) { return this.req('GET', p); }
  post(p, b = {}) { return this.req('POST', p, b); }
  async login(phone, password = PW) { const r = await this.post('/api/auth/login', { phone, password }); assert.equal(r.status, 200, JSON.stringify(r.json)); return this; }
}

before(async () => {
  db = await freshDb('wld_compliance');
  await db.owner.query(`INSERT INTO users(role,status,full_name,phone,password_hash,identity_verified) VALUES ('admin','active','Admin','620000000',$1,true)`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  srv = await createServer({
    prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', trustProxy: false, showTestCodes: true,
    legal: { version: '2026-10-19', name: 'Société <Test> & Fils', form: 'SARL', address: '', email: 'contact@exemple.gn', rccm: '', nif: '', director: '', hostingRegion: '', returnDays: '2' },
    db: { ...TEST_DB, database: 'wld_compliance', user: 'wld_app', password: APP_PW, max: 5 }, owner: {}, messaging: { provider: 'simulated' }
  }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });
beforeEach(() => srv.resetLimits());

test('plus aucune adresse /legal ni aide publique : tout est lu dans l\'application', async () => {
  const c = new Client();
  for (const [slug] of PAGES) { const r = await c.get(`/legal/${slug}`); assert.ok(r.status === 404 || !/Dernière mise à jour/.test(r.text), `${slug} : plus de page serveur`); }
  assert.equal((await c.post('/api/public/support', { name: 'Test', phone: '681000099', message: 'bonjour' })).status, 404);
  assert.equal((await c.post('/api/public/assistant', { question: 'bonjour' })).status, 404);
  assert.ok(legalMissing({ legal: {} }).length >= 8);
  assert.equal(typeof createLegal, 'function');
});

test('robots.txt : lisible, l\'API est exclue', async () => {
  const r = await new Client().get('/robots.txt');
  assert.match(r.headers.get('content-type'), /text\/plain/);
  assert.match(r.text, /Disallow: \/api\//); assert.ok(!/\/legal/.test(r.text));
  assert.doesNotMatch((await new Client().get('/llms.txt')).headers.get('content-type'), /text\/plain/);   // plus de fichier pour robots d'IA
});

test('consentement : exigé à l\'inscription et à la commande, et enregistré', async () => {
  const c = new Client();
  const body = { phone: '641000001', name: 'Vendeur Légal', role: 'seller', password: PW, payout_method: 'orange_money' };
  const r0 = await c.post('/api/auth/register', body);
  assert.equal(r0.status, 400); assert.equal(r0.json.error, 'consent_required');
  assert.equal((await c.post('/api/auth/register', { ...body, accept_terms: true })).status, 201);          // vendeur : pièce d'identité facultative
  const { rows } = await db.owner.query(`SELECT kind, version FROM consents WHERE user_id = (SELECT id FROM users WHERE phone = '641000001')`);
  assert.deepEqual(rows, [{ kind: 'register', version: '2026-10-19' }]);
  assert.equal((await c.post('/api/auth/register', { ...body, phone: '641000002', role: 'supplier', accept_terms: true })).status, 400);   // fournisseur : pièce obligatoire
  const o = await c.post('/api/public/link/inconnu/order', { qty: 1, name: 'Client', phone: '642000001', commune: 'Ratoma', address: 'Rue 1' });
  assert.equal(o.json.error, 'consent_required');
  const none = await db.owner.query(`SELECT count(*)::int AS n FROM consents WHERE kind = 'order'`);
  assert.equal(none.rows[0].n, 0);
  // le journal ne garde que l'empreinte du numéro du client
  await call(db.app, 'fn_record_consent', 'order', null, '642000001', '2026-10-19');
  const h = await db.owner.query(`SELECT subject_hash FROM consents WHERE kind = 'order'`);
  assert.match(h.rows[0].subject_hash, /^[0-9a-f]{64}$/); assert.ok(!h.rows[0].subject_hash.includes('642000001'));
  await assert.rejects(db.owner.query(`UPDATE consents SET version = 'x'`));                                // ajout seul
});

test('demandes sur les données : formulaire public, limite, clôture par l\'admin', async () => {
  const c = new Client();
  const r = await c.post('/api/public/data-request', { kind: 'erasure', name: 'Aminata Bah', phone: '651000001', message: 'Supprimez mon compte' });
  assert.equal(r.status, 201);
  assert.equal((await c.post('/api/public/data-request', { kind: 'bidon', name: 'Aminata Bah', phone: '651000001' })).status, 400);
  for (let i = 0; i < 2; i++) await c.post('/api/public/data-request', { kind: 'access', name: 'Aminata Bah', phone: '651000001' });
  assert.equal((await c.post('/api/public/data-request', { kind: 'access', name: 'Aminata Bah', phone: '651000001' })).status, 429);   // 3 ouvertes au maximum
  assert.equal((await c.get('/api/admin/data-requests')).status, 401);
  const a = await new Client().login('620000000');
  const list = (await a.get('/api/admin/data-requests')).json.requests;
  assert.equal(list.length, 3);
  assert.equal((await a.post(`/api/admin/data-requests/${list[0].id}/close`, { status: 'done', note: '' })).status, 400);
  assert.equal((await a.post(`/api/admin/data-requests/${list[0].id}/close`, { status: 'done', note: 'Compte anonymisé' })).status, 200);
  assert.equal((await a.post(`/api/admin/data-requests/${list[0].id}/close`, { status: 'done', note: 'encore' })).status, 409);
  assert.equal((await a.get('/api/admin/dashboard')).json.data_requests_open, 2);
});

test('anonymisation : refusée s\'il reste de l\'argent, sinon les données d\'identité sont effacées', async () => {
  const w = await world(db);
  const a = await new Client().login('620000000');
  // portefeuille non vide → refus
  await db.owner.query(`INSERT INTO wallet_entries(user_id, kind, amount, available_at, description) VALUES ($1, 'deposit', 5000, now(), 'test')`, [w.seller]);
  const r = await a.post(`/api/admin/users/${w.seller}/anonymize`);
  assert.equal(r.status >= 400, true, JSON.stringify(r.json));
  // solde à zéro → anonymisé
  await db.owner.query(`INSERT INTO wallet_entries(user_id, kind, amount, available_at, description) VALUES ($1, 'withdrawal', -5000, now(), 'test')`, [w.seller]);
  await call(db.app, 'fn_avatar_set', w.seller, 'image/png', BIG);
  assert.equal((await a.post(`/api/admin/users/${w.seller}/anonymize`)).status, 200);
  const u = (await db.owner.query(`SELECT full_name, phone, identity_doc, payout_phone, deleted_at FROM users WHERE id = $1`, [w.seller])).rows[0];
  assert.equal(u.full_name, 'Compte supprimé'); assert.match(u.phone, /^000\d{6}$/); assert.equal(u.identity_doc, null); assert.equal(u.payout_phone, null); assert.ok(u.deleted_at);
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM avatars WHERE user_id = $1`, [w.seller])).rows[0].n, 0);
  const adminId = (await db.owner.query(`SELECT id FROM users WHERE phone = '620000000'`)).rows[0].id;
  assert.ok((await a.post(`/api/admin/users/${adminId}/anonymize`)).status >= 400);          // un administrateur ne s'anonymise pas lui-même
});

test('purge : données périmées supprimées, données récentes gardées', async () => {
  const w = await world(db);
  await db.owner.query(`INSERT INTO messages(to_phone, template, body, status, created_at) VALUES ('660000001','x','vieux','sent', now() - interval '100 days'), ('660000002','x','récent','sent', now())`);
  await db.owner.query(`INSERT INTO data_requests(kind, full_name, phone, status, handled_at, note) VALUES ('access','Vieux Dossier','660000003','done', now() - interval '2 years', 'ok')`);
  const r = await call(db.owner, 'fn_purge_old_data');
  assert.ok(r.messages >= 1);
  const m = (await db.owner.query(`SELECT body FROM messages WHERE to_phone IN ('660000001','660000002')`)).rows.map((x) => x.body);
  assert.deepEqual(m, ['récent']);
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM data_requests WHERE phone = '660000003'`)).rows[0].n, 0);
  assert.equal(typeof w.seller, 'string');
});

test('profil : nom, mot de passe (ancien exigé), numéro de versement (mot de passe exigé), photo', async () => {
  const c = new Client();
  await c.post('/api/auth/register', { phone: '671000001', name: 'Vendeur Profil', role: 'seller', password: PW, accept_terms: true, payout_method: 'orange_money' });
  await c.login('671000001');
  assert.equal((await c.post('/api/me/profile', { name: 'Vendeur Renommé' })).status, 200);
  assert.equal((await c.get('/api/me/profile')).json.name, 'Vendeur Renommé');
  // mot de passe
  assert.equal((await c.post('/api/me/password', { current: 'FauxPass9', next: 'Nouveau456' })).status, 403);
  assert.equal((await c.post('/api/me/password', { current: PW, next: 'court' })).status, 400);
  assert.equal((await c.post('/api/me/password', { current: PW, next: 'Nouveau456' })).status, 200);
  assert.equal((await c.get('/api/me/profile')).status, 200);                                              // cette session reste ouverte
  assert.equal((await new Client().post('/api/auth/login', { phone: '671000001', password: PW })).status, 401);
  await new Client().login('671000001', 'Nouveau456');
  // numéro de versement
  assert.equal((await c.post('/api/me/payout/change', { method: 'mtn_momo', phone: '666111222', password: PW })).status, 403);
  assert.equal((await c.post('/api/me/payout/change', { method: 'mtn_momo', phone: '666111222', password: 'Nouveau456' })).status, 200);
  assert.deepEqual((await c.get('/api/me/profile')).json.payout, { method: 'mtn_momo', phone: '666111222' });
  const alert = (await db.owner.query(`SELECT 1 FROM messages WHERE to_phone = '671000001' AND template = 'payout_changed'`)).rowCount;
  assert.equal(alert, 1);                                                                                  // l'ancien numéro est prévenu
  // photo : image valide seulement, visible du propriétaire et de l'admin, pas des autres
  assert.equal((await c.post('/api/me/avatar', { image: 'data:text/html;base64,PGI+' })).status, 400);
  assert.equal((await c.post('/api/me/avatar', { image: dataUrl(BIG) })).status, 200);
  const id = (await c.get('/api/me/profile')).json.id;
  assert.equal((await c.get(`/api/users/${id}/avatar`)).status, 200);
  const a = await new Client().login('620000000');
  assert.equal((await a.get(`/api/users/${id}/avatar`)).status, 200);
  const other = new Client(); await other.post('/api/auth/register', { phone: '671000002', name: 'Autre Vendeur', role: 'seller', password: PW, accept_terms: true, payout_method: 'orange_money' }); await other.login('671000002');
  assert.equal((await other.get(`/api/users/${id}/avatar`)).status, 403);
  assert.equal((await c.post('/api/me/avatar/delete')).status, 200);
  assert.equal((await c.get(`/api/users/${id}/avatar`)).status, 404);
});

test('assistant : réservé aux personnes connectées ; thèmes, sujets, questions du métier, rôles', async () => {
  const c = new Client();
  // sans connexion : aucun accès à l'assistant (ni questions, ni thèmes)
  assert.equal((await c.post('/api/public/assistant', { question: 'mot de passe oublié' })).status, 404);
  assert.equal((await c.post('/api/assistant', { question: 'mot de passe oublié' })).status, 401);
  assert.equal((await c.get('/api/assistant/topics')).status, 401);

  const s = new Client();
  await s.post('/api/auth/register', { phone: '691000009', name: 'Vendeur Bot', role: 'seller', password: PW, accept_terms: true, payout_method: 'orange_money' });
  await s.login('691000009');
  const r = await s.post('/api/assistant', { question: 'J\'ai oublié mon mot de passe' });
  assert.equal(r.json.found, true); assert.match(r.json.text, /Mot de passe oublié/); assert.match(r.json.text, /appelez le numéro de contact/);
  assert.equal((await s.post('/api/assistant', { question: '' })).status, 400);
  const t = await s.get('/api/assistant/topics');
  assert.ok(t.json.topics.length >= 5);
  const ids = t.json.topics.flatMap((x) => x.items.map((i) => i.id));
  assert.ok(ids.includes('c-quoi')); assert.ok(!ids.includes('admin-retraits'), 'un vendeur ne voit pas les sujets admin');
  const sujet = await s.post('/api/assistant', { topic: 'c-quoi' });
  assert.equal(sujet.json.found, true); assert.match(sujet.json.text, /paiement à la livraison/);
  assert.equal((await s.post('/api/assistant', { topic: 'admin-retraits' })).status, 404);
  const cas = [
    ['Comment faire de la publicité sur Facebook et TikTok ?', 'pub-facebook'],
    ['Comment vendre avec WhatsApp ?', 'pub-whatsapp'],
    ['on m\'a demandé mon code PIN Orange Money', 'securite-mobile-money'],
    ['pourquoi mon argent n\'est pas encore disponible', 'gains-delai'],
    ['faut-il payer des impôts ?', 'fiscalite'],
    ['comment vendre plus', 'conseils-ventes'],
    ['j\'ai oublié mon mot de passe', 'mdp-oublie'],
    ['est-ce que vous utilisez des cookies ?', 'cookies']
  ];
  for (const [q, id] of cas) { const x = await s.post('/api/assistant', { question: q }); assert.equal(x.json.id, id, q); }
  // les réponses sur les règles proposent le texte complet, lu dans l'application
  assert.equal((await s.post('/api/assistant', { topic: 'cookies' })).json.legal, 'cookies');
  assert.equal((await s.post('/api/assistant', { topic: 'donnees' })).json.legal, 'confidentialite');
  const nf = await s.post('/api/assistant', { question: 'xyzzy plugh' });
  assert.equal(nf.json.found, false); assert.ok(Array.isArray(nf.json.related)); assert.equal(nf.json.team, true);
});

test('textes légaux lus dans l\'application : liste, contenu, accessibles avant connexion, champs échappés', async () => {
  const c = new Client();
  const l = await c.get('/api/public/legal');
  assert.equal(l.status, 200); assert.equal(l.json.pages.length, PAGES.length);
  for (const [slug, title] of PAGES) {
    const r = await c.get(`/api/public/legal/${slug}`);
    assert.equal(r.status, 200, slug); assert.equal(r.json.title, title); assert.ok(r.json.html.length > 300);
    assert.ok(!/<html|<script/i.test(r.json.html), 'fragment seulement, sans script');
  }
  const m = await c.get('/api/public/legal/mentions-legales');
  assert.match(m.json.html, /Société &lt;Test&gt; &amp; Fils/);
  assert.equal((await c.get('/api/public/legal/inconnue')).status, 404);
  assert.equal((await c.get('/api/public/legal/..%2fconfig')).status, 404);
});

test('messagerie avec l\'équipe : connecté, visiteur, réponse, mot de passe temporaire', async () => {
  const a = await new Client().login('620000000');
  const c = new Client();
  await c.post('/api/auth/register', { phone: '681000001', name: 'Vendeur Chat', role: 'seller', password: PW, accept_terms: true, payout_method: 'orange_money' });
  await c.login('681000001');
  assert.equal((await c.post('/api/support', { body: '' })).status, 400);
  assert.equal((await c.post('/api/support', { body: 'Bonjour, besoin d\'aide' })).status, 201);
  await c.post('/api/support', { body: 'Deuxième message' });
  const mine = (await c.get('/api/support')).json;
  assert.equal(mine.messages.length, 2);
  const inbox = (await a.get('/api/admin/support')).json.threads;
  const t = inbox.find((x) => x.phone === '681000001');
  assert.equal(inbox.filter((x) => x.phone === '681000001').length, 1);                                       // une seule conversation ouverte
  assert.equal((await a.post(`/api/admin/support/${t.id}/reply`, { body: 'Nous vous répondons' })).status, 200);
  assert.equal((await c.get('/api/support')).json.unread, true);
  assert.equal((await c.get('/api/support?read=1')).json.messages.length, 3);
  assert.equal((await c.get('/api/support')).json.unread, false);
  assert.equal((await c.get('/api/admin/support')).status, 403);                                              // pas pour un vendeur
  // un visiteur sans compte ne peut plus écrire à l'équipe (l'aide est réservée aux connectés)
  assert.equal((await new Client().post('/api/public/support', { name: 'X', phone: '681000001', message: 'abc' })).status, 404);
  assert.equal((await new Client().post('/api/support', { body: 'abc' })).status, 401);
});

test('remise à zéro : confirmation écrite et mot de passe exigés, activités effacées, comptes et produits gardés', async () => {
  const w = await world(db);
  const p = await approvedProduct(db, w);
  const a = await new Client().login('620000000');
  assert.equal((await a.post('/api/admin/reset-activity', { confirm: 'REINITIALISER', password: 'FauxPass9' })).status, 403);
  assert.equal((await a.post('/api/admin/reset-activity', { confirm: 'oui', password: PW })).status, 400);
  const seller = new Client();
  await seller.post('/api/auth/register', { phone: '691100001', name: 'Vendeur Reset', role: 'seller', password: PW, accept_terms: true, payout_method: 'orange_money' });
  await seller.login('691100001');
  assert.equal((await seller.post('/api/admin/reset-activity', { confirm: 'REINITIALISER', password: PW })).status, 403);   // réservé à l'admin
  const before = (await db.owner.query(`SELECT (SELECT count(*) FROM wallet_entries)::int AS w, (SELECT count(*) FROM users)::int AS u, (SELECT count(*) FROM products)::int AS p`)).rows[0];
  assert.ok(before.w > 0);
  const r = await a.post('/api/admin/reset-activity', { confirm: 'REINITIALISER', password: PW });
  assert.equal(r.status, 200);
  const after = (await db.owner.query(`SELECT (SELECT count(*) FROM wallet_entries)::int AS w, (SELECT count(*) FROM orders)::int AS o, (SELECT count(*) FROM users)::int AS u, (SELECT count(*) FROM products)::int AS p, (SELECT coalesce(sum(stock_qty),0) FROM products)::int AS s, (SELECT count(*) FROM audit_log WHERE action = 'activity_reset')::int AS a`)).rows[0];
  assert.equal(after.w, 0); assert.equal(after.o, 0); assert.equal(after.s, 0); assert.equal(after.u, before.u); assert.equal(after.p, before.p); assert.equal(after.a, 1);   // la trace de la remise à zéro est conservée
  assert.equal((await a.get('/api/admin/dashboard')).json.ledger_problems, 0);
  assert.ok(p);
});

test('identité : le vendeur ajoute sa pièce plus tard, figée une fois vérifiée', async () => {
  const c = new Client();
  await c.post('/api/auth/register', { phone: '692000001', name: 'Vendeur Pièce', role: 'seller', password: PW, accept_terms: true, payout_method: 'orange_money' });
  await c.login('692000001');
  assert.equal((await c.get('/api/wallet')).json.identity_submitted, false);
  assert.equal((await c.post('/api/me/identity', { identity_doc: 'ab' })).status, 400);
  assert.equal((await c.post('/api/me/identity', { identity_doc: 'CNI-5551234' })).status, 200);
  assert.equal((await c.get('/api/wallet')).json.identity_submitted, true);
  const a = await new Client().login('620000000');
  const id = (await c.get('/api/me/profile')).json.id;
  await a.post(`/api/admin/users/${id}/verify`, { verified: true });
  assert.notEqual((await c.post('/api/me/identity', { identity_doc: 'CNI-9999999' })).status, 200);          // figée
});
