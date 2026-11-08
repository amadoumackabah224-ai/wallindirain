// 050 : Contacts (carnet, notes, étiquettes, import, appels), formule Pro, droits, retour arrière.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshDb, TEST_DB, APP_PW, world, call, expectErr, deliver } from './helpers.js';
import { splitSql } from '../src/migrate.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';

const PW = 'Secret123';
const root = path.resolve(import.meta.dirname, '..', '..');
let db, w, srv, base, n = 0;
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
const login = async (id) => { const c = new Client(); const ph = (await db.owner.query('SELECT phone FROM users WHERE id = $1', [id])).rows[0].phone; assert.equal((await c.post('/api/auth/login', { identifier: ph, password: PW })).status, 200); return c; };
const order = (extra = {}) => ({ request_key: `r${String(++n).padStart(3, '0')}`.padEnd(20, 'x'), qty: 2, customer_name: 'Client Test', customer_phone: `62200${String(1000 + n)}`, commune: 'Ratoma', address: 'Rue 1, près du marché', unit_price: 100000, own_product_name: 'Sac', pickup_detail: 'Chez moi', ...extra });
const place = async (s, extra = {}) => { const r = await s.post('/api/seller/orders', order(extra)); assert.equal(r.status, 201); return r.json; };
const rows = async (sql, p) => (await db.owner.query(sql, p)).rows;
const dayStr = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const walletTotals = async () => (await rows('SELECT count(*)::int AS n, COALESCE(sum(amount),0)::text AS t FROM wallet_entries'))[0];
let s, s2, courier;

before(async () => {
  db = await freshDb('wld_pfc'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_pfc', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
  s = await login(w.seller); s2 = await login(w.seller2); courier = await login(w.courier);
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });


const ct = (c, extra = {}) => c.post('/api/pf/contacts', { name: 'Mariama Diallo', phone: '622 11 22 33', city: 'Ratoma', stage: 'prospect', ...extra });
const list = async (c, q = '') => (await c.get(`/api/pf/contacts${q}`)).json;
const setPrice = (m) => db.owner.query(`UPDATE settings SET value = $1 WHERE key = 'pf_price_monthly'`, [m]);
let cid;

test('éteint : rien n\'est possible', async () => {
  assert.equal((await s.get('/api/pf/contacts')).json.enabled, false);
  assert.equal((await ct(s)).status, 403);
  await db.owner.query(`UPDATE settings SET value = 1 WHERE key = 'feature_finances_perso'`);
});

test('contact : création (numéro nettoyé), modification, doublon, validation, isolation', async () => {
  const r = await ct(s); assert.equal(r.status, 201); cid = r.json.id;
  const l = await list(s);
  assert.equal(l.contacts[0].phone, '622112233');
  assert.equal((await ct(s, { name: 'Autre', phone: '+224 622-11-22-33' })).status, 409, 'même numéro avec indicatif');
  assert.equal((await ct(s, { name: 'X' })).status, 400);
  assert.equal((await ct(s, { phone: 'abc' })).status, 400);
  assert.equal((await ct(s, { phone: '622000001', stage: 'vip' })).status, 400);
  assert.equal((await s.post('/api/pf/contacts', { id: cid, name: 'Mariama D.', phone: '622112233', city: 'Kaloum', stage: 'client' })).status, 200);
  assert.equal((await list(s)).contacts[0].stage, 'client');
  assert.equal((await list(courier)).contacts.length, 0);
  assert.equal((await courier.get(`/api/pf/contacts/${cid}`)).status, 404);
  assert.equal((await courier.post('/api/pf/contacts', { id: cid, name: 'Volé', phone: '622999999' })).status, 404);
  assert.equal((await courier.post(`/api/pf/contacts/${cid}/archive`)).status, 404);
  assert.equal((await list(s, '?q=kalo')).contacts.length, 1);
  assert.equal((await list(s, '?q=zzz')).contacts.length, 0);
});

test('notes datées : ajout, retrait (masquée, conservée), isolation', async () => {
  const n = await s.post(`/api/pf/contacts/${cid}/notes`, { body: 'À rappeler vendredi' });
  assert.equal(n.status, 201);
  assert.equal((await s.get(`/api/pf/contacts/${cid}`)).json.notes.length, 1);
  assert.equal((await s.post(`/api/pf/contacts/${cid}/notes`, { body: '   ' })).status, 400);
  assert.equal((await courier.post(`/api/pf/contacts/${cid}/notes`, { body: 'intrus' })).status, 404);
  assert.equal((await courier.post(`/api/pf/contact-notes/${n.json.id}/void`)).status, 404);
  assert.equal((await s.post(`/api/pf/contact-notes/${n.json.id}/void`)).status, 200);
  assert.equal((await s.get(`/api/pf/contacts/${cid}`)).json.notes.length, 0);
  assert.equal((await rows('SELECT count(*)::int AS n FROM pf_contact_notes'))[0].n, 1, 'conservée');
});

test('étiquettes : créer, attacher, filtrer, retirer ; pas celles d\'un autre', async () => {
  const l = await s.post('/api/pf/labels', { name: 'Fidèle', color: 'green' }); assert.equal(l.status, 201);
  assert.equal((await s.post('/api/pf/labels', { name: 'fidèle', color: 'red' })).status, 409);
  assert.equal((await s.post('/api/pf/labels', { name: 'Z', color: 'pink' })).status, 400);
  assert.equal((await s.post(`/api/pf/contacts/${cid}/labels`, { labels: [l.json.id] })).status, 200);
  assert.equal((await list(s, `?label=${l.json.id}`)).contacts.length, 1);
  assert.equal((await s.get(`/api/pf/contacts/${cid}`)).json.labels[0].name, 'Fidèle');
  const other = await courier.post('/api/pf/labels', { name: 'Autre', color: 'blue' });
  assert.equal((await s.post(`/api/pf/contacts/${cid}/labels`, { labels: [other.json.id] })).status, 404, 'étiquette d\'un autre');
  assert.equal((await courier.post(`/api/pf/labels/${l.json.id}/delete`)).status, 404);
  assert.equal((await s.post(`/api/pf/labels/${l.json.id}/delete`)).status, 200);
  assert.equal((await list(s)).labels.length, 0);
  assert.equal((await s.get(`/api/pf/contacts/${cid}`)).json.labels.length, 0, 'masquée partout');
});

test('import de fichier : lignes valides ajoutées, doublons et invalides ignorés', async () => {
  const r = await s.post('/api/pf/contacts-import', { rows: [{ name: 'Alpha Barry', phone: '+224 621 00 00 01', city: 'Matam' }, { name: 'Beta', phone: '621000002' }, { name: 'Mariama', phone: '622112233' }, { name: 'Sans numéro', phone: '' }, { name: 'C', phone: '621000003' }, { name: 'Alpha bis', phone: '621000001' }] });
  assert.equal(r.status, 200); assert.deepEqual(r.json, { added: 2, skipped: 4 });
  assert.equal((await list(s)).total, 3);
  assert.equal((await s.post('/api/pf/contacts-import', { rows: Array(501).fill({ name: 'Aa', phone: '621000009' }) })).status, 400);
  assert.equal((await s.post('/api/pf/contacts-import', {})).status, 400);
});

test('vendeur : historique des commandes et import depuis les commandes ; pas pour les autres rôles', async () => {
  const o = await s.post('/api/seller/orders', order({ customer_name: 'Client Commande', customer_phone: '622555666' }));
  assert.equal(o.status, 201);
  const add = await s.post('/api/pf/contacts-from-orders'); assert.equal(add.json.added, 1);
  assert.equal((await s.post('/api/pf/contacts-from-orders')).json.added, 0, 'pas de doublon');
  const c = (await list(s, '?q=622555666')).contacts[0]; assert.equal(c.origin, 'order'); assert.equal(c.stage, 'client');
  const d = (await s.get(`/api/pf/contacts/${c.id}`)).json; assert.equal(d.orders.length, 1);
  assert.equal((await courier.post('/api/pf/contacts-from-orders')).status, 403);
  const cc = (await ct(courier, { phone: '622555666' })).json.id;
  assert.equal((await courier.get(`/api/pf/contacts/${cc}`)).json.orders, null, 'aucun historique hors vendeur');
});

test('archiver / rétablir ; formule gratuite : limite de contacts, étiquettes et import réservés Pro', async () => {
  assert.equal((await s.post(`/api/pf/contacts/${cid}/archive`, { archived: true })).status, 200);
  assert.equal((await list(s, '?archived=1')).contacts.length, 1);
  assert.equal((await s.post(`/api/pf/contacts/${cid}/archive`, { archived: false })).status, 200);
  await setPrice(5000); await db.owner.query(`DELETE FROM pf_access`); await db.owner.query(`UPDATE settings SET value = 4 WHERE key = 'pf_free_contacts'`);
  assert.equal((await list(s)).total, 4);
  const r = await ct(s, { phone: '621000077' }); assert.equal(r.status, 403); assert.equal(r.json.error, 'pro_required');
  assert.equal((await s.post(`/api/pf/contacts/${cid}/archive`, { archived: true })).status, 200);
  assert.equal((await ct(s, { phone: '621000077' })).status, 201, 'place libérée');
  assert.equal((await s.post(`/api/pf/contacts/${cid}/archive`, { archived: false })).status, 403, 'rétablir respecte la limite');
  assert.equal((await s.post('/api/pf/labels', { name: 'Pro', color: 'blue' })).status, 403);
  assert.equal((await s.post('/api/pf/contacts-import', { rows: [{ name: 'Zed', phone: '621000088' }] })).status, 403);
  assert.equal((await s.post('/api/pf/contacts', { id: (await list(s)).contacts[0].id, name: 'Modifié', phone: (await list(s)).contacts[0].phone, stage: 'client' })).status, 200, 'modifier reste libre');
  await db.owner.query(`INSERT INTO pf_access(owner_id, paid_until) VALUES ($1, now() + interval '30 days')`, [w.seller]);
  assert.equal((await s.post('/api/pf/contacts-import', { rows: [{ name: 'Zed', phone: '621000088' }] })).json.added, 1);
  await setPrice(0);
});

test('droits : tables fermées à l\'application, fonctions internes non appelables', async () => {
  await assert.rejects(db.app.query(`INSERT INTO pf_contacts(owner_id, name, phone) VALUES ($1,'Aa','621000000')`, [w.seller]), /permission denied/i);
  await assert.rejects(db.app.query(`SELECT _pf_norm_phone('1')`), /permission denied/i);
});

test('anonymisation : carnet, notes et étiquettes disparaissent', async () => {
  await db.owner.query(`UPDATE users SET deleted_at = now() WHERE id = $1`, [w.seller]);
  for (const t of ['pf_contacts', 'pf_contact_notes', 'pf_contact_labels']) assert.equal((await rows(`SELECT count(*)::int AS n FROM ${t} WHERE owner_id = $1`, [w.seller]))[0].n, 0, t);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM pf_contact_label_links`))[0].n, 0);
});

test('retour arrière 050 : refusé s\'il existe des données, accepté sinon', async () => {
  const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-050.sql'), 'utf8');
  const run = async () => { await db.owner.query('BEGIN'); try { for (const q of splitSql(rb)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT'); } catch (e) { await db.owner.query('ROLLBACK'); throw e; } };
  await assert.rejects(run, /des données de Contacts existent/);
  for (const t of ['pf_contact_label_links', 'pf_contact_labels', 'pf_contact_notes', 'pf_contacts']) await db.owner.query(`DELETE FROM ${t}`);
  await run();
  assert.equal((await rows(`SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'fn\\_pf\\_contact%' OR proname = '_pf_norm_phone'`))[0].n, 0);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM settings WHERE key = 'pf_free_contacts'`))[0].n, 0);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '050_contacts_crm.sql'`))[0].n, 0);
});
