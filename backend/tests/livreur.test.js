// Étape 1 : profil du livreur (véhicule, disponibilité) et zones couvertes (migration 018).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshDb, TEST_DB, APP_PW, world, approvedProduct, deliver, call, expectErr } from './helpers.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';
import { migrate } from '../src/migrate.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PW = 'Secret123';
let db, w, srv, base, n = 0;
const count = async (sql, p = []) => Number((await db.owner.query(sql, p)).rows[0].n);
const phone = () => `6${String(++n).padStart(8, '0')}`;

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
const login = async (id) => {
  const c = new Client(); const ph = (await db.owner.query('SELECT phone FROM users WHERE id = $1', [id])).rows[0].phone;
  assert.equal((await c.post('/api/auth/login', { identifier: ph, password: PW })).status, 200); return c;
};

before(async () => {
  db = await freshDb('wld_livreur'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_livreur', user: 'wld_app', password: APP_PW, max: 5 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });

test('administrateur : véhicule et zones enregistrés, nettoyés, remplacés ; zone inconnue et liste trop longue refusées', async () => {
  const zones = async (c) => (await call(db.app, 'fn_courier_profile', c)).zones;
  const r = await call(db.app, 'fn_admin_set_courier_zones', w.admin, w.courier, [' Ratoma ', 'Kaloum', 'Kaloum']);
  assert.deepEqual(r.zones, ['Kaloum', 'Ratoma']);                                           // espaces retirés, doublons fusionnés, ordre stable
  assert.deepEqual(await zones(w.courier), ['Kaloum', 'Ratoma']);
  await call(db.app, 'fn_admin_set_courier_zones', w.admin, w.courier, ['Matoto']);          // remplace, ne cumule pas
  assert.deepEqual(await zones(w.courier), ['Matoto']);
  await call(db.app, 'fn_admin_set_courier_zones', w.admin, w.courier, []);                  // aucune zone : permis
  assert.deepEqual(await zones(w.courier), []);
  await call(db.app, 'fn_admin_set_courier_zones', w.admin, w.courier, ['Kaloum']);
  await expectErr(call(db.app, 'fn_admin_set_courier_zones', w.admin, w.courier, ['Kaloum', 'Atlantide']), 'invalid_input');
  assert.deepEqual(await zones(w.courier), ['Kaloum']);                                      // refus complet : rien n'a changé
  await expectErr(call(db.app, 'fn_admin_set_courier_zones', w.admin, w.courier, Array.from({ length: 51 }, (_, i) => `Zone ${i}`)), 'invalid_input');
  await call(db.app, 'fn_admin_set_courier_profile', w.admin, w.courier, 'moto');
  assert.equal((await call(db.app, 'fn_courier_profile', w.courier)).vehicle, 'moto');
  await expectErr(call(db.app, 'fn_admin_set_courier_profile', w.admin, w.courier, 'fusée'), 'invalid_input');
  await call(db.app, 'fn_admin_set_courier_profile', w.admin, w.courier, null);
  assert.equal((await call(db.app, 'fn_courier_profile', w.courier)).vehicle, null);
  const aud = (await db.owner.query(`SELECT action, details::text AS d FROM audit_log WHERE action IN ('courier_zones_set','courier_profile_set') AND entity_id = $1`, [w.courier])).rows;
  assert.ok(aud.length >= 5); assert.ok(aud.every((a) => !/\d{9}/.test(a.d)));               // journalisé, sans numéro de téléphone
});

test('permissions : seul l\'administrateur règle le profil et les zones, seul le livreur sa disponibilité, sur des livreurs uniquement', async () => {
  for (const actor of [w.seller, w.supplier, w.agent1, w.chief, w.courier, w.warehouse]) {
    await expectErr(call(db.app, 'fn_admin_set_courier_zones', actor, w.courier, ['Kaloum']), 'forbidden');
    await expectErr(call(db.app, 'fn_admin_set_courier_profile', actor, w.courier, 'moto'), 'forbidden');
  }
  for (const actor of [w.seller, w.admin, w.chief, w.agent1]) {
    await expectErr(call(db.app, 'fn_courier_set_availability', actor, false), 'forbidden');
    await expectErr(call(db.app, 'fn_courier_profile', actor), 'forbidden');
  }
  await expectErr(call(db.app, 'fn_admin_set_courier_zones', w.admin, w.seller, ['Kaloum']), 'not_found');      // pas un livreur
  await expectErr(call(db.app, 'fn_admin_set_courier_zones', w.admin, '00000000-0000-0000-0000-000000000009', ['Kaloum']), 'not_found');
  await expectErr(call(db.app, 'fn_courier_set_availability', w.courier, null), 'invalid_input');
});

test('disponibilité : chaque livreur ne modifie et ne voit que la sienne', async () => {
  await call(db.app, 'fn_admin_set_courier_zones', w.admin, w.courier2, ['Dixinn']);
  assert.equal((await call(db.app, 'fn_courier_profile', w.courier)).availability, 'available');                // défaut
  await call(db.app, 'fn_courier_set_availability', w.courier, false);
  assert.equal((await call(db.app, 'fn_courier_profile', w.courier)).availability, 'unavailable');
  const p2 = await call(db.app, 'fn_courier_profile', w.courier2);
  assert.equal(p2.availability, 'available'); assert.deepEqual(p2.zones, ['Dixinn']);                            // l'autre est intact
  await call(db.app, 'fn_courier_set_availability', w.courier, true);
  assert.equal((await call(db.app, 'fn_courier_profile', w.courier)).availability, 'available');
});

test('affectation inchangée : livreur indisponible ou sans zone toujours affectable ; livraison complète, comptabilité et réglages intacts', async () => {
  const product = await approvedProduct(db, w, { price: 60000, qty: 20 });
  await call(db.app, 'fn_seller_set_price', w.seller, product, 120000);
  const snap = async () => (await db.owner.query(`SELECT (SELECT md5(string_agg(key || value::text, ',' ORDER BY key)) FROM settings) AS s,
      (SELECT md5(string_agg(commune || fee::text || active::text, ',' ORDER BY commune)) FROM delivery_rates) AS z`)).rows[0];
  const before = await snap();
  await call(db.app, 'fn_admin_set_courier_zones', w.admin, w.courier, []);
  await call(db.app, 'fn_courier_set_availability', w.courier, false);
  const o = await call(db.app, 'fn_seller_create_order_once', w.seller, 'liv-test-key-00000001', product, null, null, 1, 'Client Test', phone(), 'Kaloum', 'Rue 1 Kaloum', null, false);
  const res = await deliver(db, w, o.id, o.ref);                                                                 // chef affecte w.courier : indisponible et sans zone
  assert.ok(res !== undefined);
  assert.equal((await db.owner.query('SELECT status FROM orders WHERE id = $1', [o.id])).rows[0].status, 'delivered');
  assert.equal(await count('SELECT count(*)::int AS n FROM fn_ledger_check()'), 0);
  assert.deepEqual(await snap(), before);                                                                        // ni réglage, ni tarif, ni paie modifiés
  await call(db.app, 'fn_courier_set_availability', w.courier, true);
});

test('HTTP : livreur (profil, disponibilité), administrateur (liste, zones, véhicule), chef (liste enrichie), accès croisés refusés', async () => {
  const cou = await login(w.courier), adm = await login(w.admin), chief = await login(w.chief), sel = await login(w.seller);
  const p = await cou.get('/api/courier/profile'); assert.equal(p.status, 200); assert.ok(Array.isArray(p.json.zones));
  assert.equal((await cou.post('/api/courier/availability', { available: false })).status, 200);
  assert.equal((await cou.get('/api/courier/profile')).json.availability, 'unavailable');
  assert.equal((await cou.post('/api/courier/availability', { available: 'oui' })).status, 400);
  assert.equal((await cou.post('/api/courier/availability', {})).status, 400);
  await cou.post('/api/courier/availability', { available: true });
  for (const [m, url, body] of [['get', '/api/admin/couriers'], ['post', `/api/admin/couriers/${w.courier}/zones`, { communes: ['Kaloum'] }], ['post', `/api/admin/couriers/${w.courier}/profile`, { vehicle: 'moto' }]]) {
    assert.equal((await cou[m](url, body)).status, 403, `livreur ${url}`);
    assert.equal((await sel[m](url, body)).status, 403, `vendeur ${url}`);
    assert.equal((await chief[m](url, body)).status, 403, `chef ${url}`);
  }
  assert.equal((await sel.get('/api/courier/profile')).status, 403); assert.equal((await adm.get('/api/courier/profile')).status, 403);
  assert.equal((await adm.post(`/api/admin/couriers/${w.courier}/zones`, { communes: ['Matam', 'Ratoma'] })).status, 200);
  assert.equal((await adm.post(`/api/admin/couriers/${w.courier}/zones`, { communes: 'Matam' })).status, 400);
  assert.equal((await adm.post(`/api/admin/couriers/${w.courier}/zones`, { communes: [1, 2] })).status, 400);
  assert.equal((await adm.post(`/api/admin/couriers/${w.courier}/zones`, { communes: ['Inconnue'] })).status, 400);
  assert.equal((await adm.post(`/api/admin/couriers/${w.courier}/profile`, { vehicle: 'moto' })).status, 200);
  assert.equal((await adm.post(`/api/admin/couriers/${w.courier}/profile`, { vehicle: 'jet' })).status, 400);
  assert.equal((await adm.post(`/api/admin/couriers/pas-un-id/zones`, { communes: [] })).status, 400);
  const list = await adm.get('/api/admin/couriers'); assert.equal(list.status, 200);
  const me = list.json.couriers.find((c) => c.id === w.courier);
  assert.deepEqual(me.zones, ['Matam', 'Ratoma']); assert.equal(me.vehicle, 'moto'); assert.equal(me.availability, 'available');
  assert.ok(list.json.couriers.every((c) => !('password_hash' in c))); assert.ok(list.json.zones.some((z) => z.commune === 'Kaloum'));
  const ch = await chief.get('/api/chief/orders'); assert.equal(ch.status, 200);
  const cc = ch.json.couriers.find((c) => c.id === w.courier); assert.deepEqual(cc.zones, ['Matam', 'Ratoma']); assert.equal(cc.availability, 'available');
});

test('création du livreur : compte, véhicule et zones réglés d\'un coup ; zone ou véhicule invalide = aucun compte créé ; autres rôles inchangés', async () => {
  const adm = await login(w.admin), sel = await login(w.seller);
  const users = () => count(`SELECT count(*)::int AS n FROM users`);
  const base0 = { role: 'courier', name: 'Livreur Nouveau', password: 'Zebre4829x' };
  const before = await users();
  const bad = await adm.post('/api/admin/users', { ...base0, phone: '622111001', vehicle: 'moto', communes: ['Kaloum', 'Atlantide'] });
  assert.equal(bad.status, 400); assert.equal(await users(), before);                                  // refus complet : pas de compte à moitié configuré
  assert.equal((await adm.post('/api/admin/users', { ...base0, phone: '622111001', vehicle: 'fusée', communes: [] })).status, 400); assert.equal(await users(), before);
  assert.equal((await adm.post('/api/admin/users', { ...base0, phone: '622111001', communes: 'Kaloum' })).status, 400); assert.equal(await users(), before);
  const ok = await adm.post('/api/admin/users', { ...base0, phone: '622111001', vehicle: 'moto', communes: ['Ratoma', ' Kaloum ', 'Kaloum'] });
  assert.equal(ok.status, 201);
  const p = await call(db.app, 'fn_courier_profile', ok.json.id); assert.equal(p.vehicle, 'moto'); assert.deepEqual(p.zones, ['Kaloum', 'Ratoma']);
  const plain = await adm.post('/api/admin/users', { ...base0, name: 'Livreur Simple', phone: '622111002' });           // sans option : comme avant
  assert.equal(plain.status, 201); assert.deepEqual((await call(db.app, 'fn_courier_profile', plain.json.id)).zones, []);
  const agent = await adm.post('/api/admin/users', { role: 'agent', team: 'Alpha', name: 'Agent Test', phone: '622111003', password: 'Zebre4829x', vehicle: 'moto', communes: ['Kaloum'] });
  assert.equal(agent.status, 201); assert.equal(await count('SELECT count(*)::int AS n FROM courier_zones WHERE courier_id = $1', [agent.json.id]), 0);   // zones ignorées hors livreur
  assert.equal((await adm.post('/api/admin/users', { ...base0, phone: '622111004', password: 'court' })).status, 400);
  assert.equal((await sel.post('/api/admin/users', { ...base0, phone: '622111005' })).status, 403);
  const list = await adm.get('/api/admin/users?role=courier'); assert.equal(list.status, 200);
  const me = list.json.users.find((u) => u.id === ok.json.id);
  assert.equal(me.vehicle, 'moto'); assert.deepEqual(me.zones, ['Kaloum', 'Ratoma']); assert.equal(me.availability, 'available');
  assert.ok(list.json.users.every((u) => !('password_hash' in u)));
  const all = await adm.get('/api/admin/users'); assert.equal(all.json.users.find((u) => u.id === agent.json.id).zones, null);   // pas de zones pour un agent
  assert.equal(await count('SELECT count(*)::int AS n FROM fn_ledger_check()'), 0);
});

test('droits SQL : tables en lecture seule pour l\'application, fonctions SECURITY DEFINER, fonction interne non exécutable', async () => {
  for (const t of ['courier_profiles', 'courier_zones']) {
    for (const priv of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) assert.equal((await db.owner.query(`SELECT has_table_privilege('wld_app', $1, $2) AS p`, [t, priv])).rows[0].p, false, `${t} ${priv}`);
    await assert.rejects(db.app.query(`DELETE FROM ${t}`), /permission denied/);
  }
  await assert.rejects(db.app.query(`INSERT INTO courier_zones(courier_id, commune) VALUES (gen_random_uuid(), 'Kaloum')`), /permission denied/);
  await assert.rejects(db.app.query(`SELECT _courier_exists('${w.courier}')`), /permission denied/);
  const fns = (await db.owner.query(`SELECT proname, prosecdef, proconfig::text AS c, has_function_privilege('wld_app', oid, 'EXECUTE') AS e FROM pg_proc
     WHERE proname IN ('fn_admin_set_courier_profile','fn_admin_set_courier_zones','fn_courier_set_availability','fn_courier_profile','_courier_exists') ORDER BY 1`)).rows;
  assert.equal(fns.length, 5);
  for (const f of fns) { assert.equal(f.prosecdef, true, f.proname); assert.match(f.c, /search_path=public, pg_temp/); assert.equal(f.e, !f.proname.startsWith('_'), f.proname); }
  assert.equal((await db.owner.query(`SELECT has_table_privilege('wld_app', 'order_requests', 'SELECT') AS p`)).rows[0].p, false);       // exclusion de la 017 conservée
});

test('retour arrière 018 : retire profils et zones, rien d\'autre ; la migration peut ensuite être rejouée', async () => {
  await call(db.app, 'fn_admin_set_courier_zones', w.admin, w.courier2, ['Kaloum']);
  const snap = async () => (await db.owner.query(`SELECT (SELECT count(*) FROM wallet_entries)::text || '/' || (SELECT COALESCE(sum(amount),0) FROM wallet_entries)::text AS ecr,
      (SELECT md5(string_agg(o::text, ',' ORDER BY id)) FROM orders o) AS cmd, (SELECT md5(string_agg(key || value::text, ',' ORDER BY key)) FROM settings) AS s,
      (SELECT md5(string_agg(p.proname || md5(pg_get_functiondef(p.oid)) || COALESCE(p.proacl::text, ''), ',' ORDER BY p.proname)) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
         AND p.proname NOT IN ('fn_admin_set_courier_profile','fn_admin_set_courier_zones','fn_courier_set_availability','fn_courier_profile','_courier_exists')) AS fonctions`)).rows[0];
  const before = await snap();
  const { splitSql } = await import('../src/migrate.js');
  const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-018.sql'), 'utf8');
  await db.owner.query('BEGIN');
  for (const s of splitSql(rb)) { if (/^(begin|commit)$/i.test(s.trim())) continue; await db.owner.query(s); }
  await db.owner.query('COMMIT');
  assert.deepEqual(await snap(), before);                                                                        // données, réglages et autres fonctions identiques
  assert.equal(await count(`SELECT (SELECT count(*) FROM pg_class WHERE relname IN ('courier_profiles','courier_zones')) + (SELECT count(*) FROM schema_migrations WHERE name = '018_profil_livreur.sql') AS n`), 0);
  await migrate({ ...TEST_DB, database: 'wld_livreur' }, APP_PW, () => {});
  assert.equal(await count(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '018_profil_livreur.sql'`), 1);
  assert.deepEqual((await call(db.app, 'fn_courier_profile', w.courier2)).zones, []);                            // table vide après rejeu
  assert.equal((await db.owner.query(`SELECT has_table_privilege('wld_app', 'courier_zones', 'INSERT') AS p`)).rows[0].p, false);
});
