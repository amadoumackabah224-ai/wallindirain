// Textes légaux par rôle : chacun ne voit que les siens, accord à la première connexion et à chaque nouvelle version.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, TEST_DB, APP_PW, world } from './helpers.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';

let db, w, srv, base;
const PW = 'Secret123';
const VERSION = '2026-10-23';

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
const phoneOf = async (id) => (await db.owner.query('SELECT phone FROM users WHERE id = $1', [id])).rows[0].phone;
const login = async (id) => { const c = new Client(); const r = await c.post('/api/auth/login', { identifier: await phoneOf(id), password: PW }); assert.equal(r.status, 200); return { c, user: r.json.user }; };
const slugs = (r) => r.json.pages.map((p) => p.slug);

beforeEach(() => srv.resetLimits());
before(async () => {
  db = await freshDb('wld_textes'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: VERSION }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_textes', user: 'wld_app', password: APP_PW, max: 5 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });

test('chaque rôle ne voit que ses textes', async () => {
  const seller = await login(w.seller); const courier = await login(w.courier); const agent = await login(w.agent1); const admin = await login(w.admin);
  assert.deepEqual(slugs(await seller.c.get('/api/public/legal')), ['mentions-legales', 'cookies', 'conditions-vendeur', 'confidentialite-vendeur']);
  assert.deepEqual(slugs(await courier.c.get('/api/public/legal')), ['mentions-legales', 'cookies', 'conditions-livreur', 'confidentialite-livreur']);
  assert.deepEqual(slugs(await agent.c.get('/api/public/legal')), ['mentions-legales', 'cookies', 'regles-equipe', 'confidentialite-equipe']);
  // un connecté ne peut pas choisir le public d'un autre : ?audience est ignoré
  assert.deepEqual(slugs(await seller.c.get('/api/public/legal?audience=courier')), slugs(await seller.c.get('/api/public/legal')));
  // lecture : le vendeur ne lit pas les textes du livreur ni de l'équipe ; le livreur lit les siens ; l'administrateur lit tout
  assert.equal((await seller.c.get('/api/public/legal/conditions-livreur')).status, 404);
  assert.equal((await seller.c.get('/api/public/legal/regles-equipe')).status, 404);
  assert.equal((await courier.c.get('/api/public/legal/conditions-livreur')).status, 200);
  assert.equal((await agent.c.get('/api/public/legal/confidentialite-equipe')).status, 200);
  assert.equal((await new Client().get('/api/public/legal/conditions-livreur')).status, 404);
  const all = slugs(await admin.c.get('/api/public/legal')); assert.equal(all.length, 13);
  assert.deepEqual(slugs(await admin.c.get('/api/public/legal?audience=courier')), ['mentions-legales', 'cookies', 'conditions-livreur', 'confidentialite-livreur']);
});

test('contenu : chaque texte parle de son public et ne mélange pas les autres', async () => {
  const seller = await login(w.seller); const courier = await login(w.courier);
  const vend = (await seller.c.get('/api/public/legal/conditions-vendeur')).json.html;
  assert.match(vend, /Trophées/); assert.match(vend, /Frais de la plateforme/); assert.doesNotMatch(vend, /comptage de la caisse/);
  const liv = (await courier.c.get('/api/public/legal/conditions-livreur')).json.html;
  assert.match(liv, /caisse/); assert.doesNotMatch(liv, /Trophées/); assert.doesNotMatch(liv, /Frais de la plateforme/);
  const conf = (await seller.c.get('/api/public/legal/confidentialite-vendeur')).json.html;
  assert.match(conf, /sous 30 jours/); assert.doesNotMatch(conf, /Qui a consulté mes photos/);
  const cli = (await new Client().get('/api/public/legal/confidentialite-client')).json.html;
  assert.doesNotMatch(cli, /numéro de versement/i); assert.match(cli, /payez en espèces/i);
});

test('accord à la première connexion, puis une nouvelle version le redemande', async () => {
  const seller = await login(w.seller);
  assert.equal(seller.user.legal_pending, true);                                                  // jamais accepté : demandé
  let me = (await seller.c.get('/api/me/legal')).json;
  assert.equal(me.pending, true); assert.equal(me.audience, 'seller'); assert.ok(me.summary.length > 50); assert.equal(me.pages.length, 4);
  assert.equal((await seller.c.post('/api/me/legal/accept', {})).status, 400);                    // l'accord doit être explicite
  assert.equal((await seller.c.post('/api/me/legal/accept', { accept: true })).status, 200);
  assert.equal((await seller.c.post('/api/me/legal/accept', { accept: true })).status, 200);       // sans doublon
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM consents WHERE user_id = $1 AND kind = 'accept'`, [w.seller])).rows[0].n, 1);
  me = (await seller.c.get('/api/me/legal')).json;
  assert.equal(me.pending, false); assert.equal(me.accepted_version, VERSION); assert.ok(me.accepted_at);
  assert.equal((await seller.c.get('/api/auth/me')).json.user.legal_pending, false);
  assert.equal((await login(w.seller)).user.legal_pending, false);
  // nouvelle version des textes : l'accord est redemandé
  await srv.close();
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-11-01' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_textes', user: 'wld_app', password: APP_PW, max: 5 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
  const again = await login(w.seller);
  assert.equal(again.user.legal_pending, true);
  assert.equal((await again.c.get('/api/me/legal')).json.accepted_version, VERSION);               // la preuve de l'ancien accord reste
});

test('l\'administrateur n\'a pas d\'accord à donner, personne sans connexion ne peut accepter, la preuve ne peut pas être modifiée', async () => {
  const admin = await login(w.admin);
  assert.equal(admin.user.legal_pending, false);
  const me = (await admin.c.get('/api/me/legal')).json; assert.equal(me.pending, false); assert.equal(me.pages.length, 13);
  assert.equal((await new Client().post('/api/me/legal/accept', { accept: true })).status, 401);
  await assert.rejects(db.owner.query(`UPDATE consents SET version = 'x' WHERE kind = 'accept'`));
});
