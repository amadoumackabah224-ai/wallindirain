// Notifications dans l'application et annonces de l'administration (migration 027).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshDb, TEST_DB, APP_PW, world, approvedProduct, codeOf, call, expectErr } from './helpers.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';
import { splitSql, migrate } from '../src/migrate.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PW = 'Secret123';
let db, w, product, srv, base, n = 0, k = 0;
const count = async (sql, p = []) => Number((await db.owner.query(sql, p)).rows[0].n);
const phone = () => `6${String(++n).padStart(8, '0')}`;
const mk = () => call(db.app, 'fn_seller_create_order_once', w.seller, `notif-test-key-${String(++k).padStart(8, '0')}`, product, null, null, 1, 'Client Test', phone(), 'Kaloum', 'Rue 1 Kaloum', null, true);
const notes = async (user) => (await call(db.app, 'fn_my_notifications', user)).items;
const titles = async (user) => (await notes(user)).map((x) => x.title);

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

before(async () => {
  db = await freshDb('wld_notif'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  product = await approvedProduct(db, w, { price: 60000, qty: 150 });
  await call(db.app, 'fn_seller_set_price', w.seller, product, 120000);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_notif', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });

test('produit validé : le fournisseur est prévenu ; lecture, compteur et « tout marquer comme lu »', async () => {
  assert.ok((await titles(w.supplier)).includes('Produit validé'));
  const before = await call(db.app, 'fn_notifications_unread', w.supplier);
  assert.ok(before >= 1);
  const first = (await notes(w.supplier))[0];
  assert.equal(first.read, false);
  assert.equal(await call(db.app, 'fn_notifications_read', w.supplier, [first.id]), 1);
  assert.equal(await call(db.app, 'fn_notifications_unread', w.supplier), before - 1);
  await call(db.app, 'fn_notifications_read', w.supplier, null);
  assert.equal(await call(db.app, 'fn_notifications_unread', w.supplier), 0);
  assert.equal((await call(db.app, 'fn_my_notifications', w.supplier)).unread, 0);
});

test('livraison : le vendeur suit sa commande, le livreur est prévenu du colis, sans téléphone ni adresse dans les textes', async () => {
  const o = await mk();
  const ref = (await db.owner.query('SELECT ref FROM orders WHERE id = $1', [o.id])).rows[0].ref;
  await call(db.app, 'fn_chief_assign', w.chief, o.id, w.courier);
  assert.ok((await titles(w.courier)).includes('Nouveau colis affecté'));
  assert.ok((await titles(w.seller)).includes('Livreur affecté'));
  await call(db.app, 'fn_courier_pickup', w.courier, o.id); await call(db.app, 'fn_courier_depart', w.courier, o.id);
  await call(db.app, 'fn_courier_deliver', w.courier, o.id, await codeOf(db, ref));
  const s = await notes(w.seller);
  const delivered = s.find((x) => x.title === 'Commande livrée');
  assert.ok(delivered && delivered.body.includes(ref) && delivered.link === 'orders');
  for (const x of await db.owner.query('SELECT title, body FROM notifications').then((r) => r.rows)) {
    assert.doesNotMatch(`${x.title} ${x.body}`, /\b6\d{8}\b/, 'aucun numéro de téléphone');
    assert.doesNotMatch(`${x.title} ${x.body}`, /Rue 1/, 'aucune adresse');
  }
});

test('bonus reçu : annoncé avec le montant déjà calculé, sans rien modifier au portefeuille', async () => {
  const before = Number((await db.owner.query('SELECT COALESCE(sum(amount),0) AS s FROM wallet_entries')).rows[0].s);
  await db.owner.query(`INSERT INTO wallet_entries(user_id, kind, amount, description) VALUES ($1, 'referral_bonus', 15000, 'test')`, [w.seller2]);
  const t = (await notes(w.seller2)).find((x) => x.title === 'Bonus de parrainage reçu');
  assert.ok(t); assert.equal(t.body, 'Vous avez reçu 15 000 GNF.'); assert.equal(t.link, 'wallet');
  assert.equal(Number((await db.owner.query('SELECT COALESCE(sum(amount),0) AS s FROM wallet_entries')).rows[0].s), before + 15000);
  assert.equal(await count('SELECT count(*)::int AS n FROM fn_ledger_check()'), 0);
});

test('une notification qui échoue ne bloque JAMAIS l\'action métier', async () => {
  const o = await mk();
  await db.owner.query('ALTER TABLE notifications ADD CONSTRAINT notif_test_fail CHECK (false) NOT VALID');
  try {
    const avant = await count('SELECT count(*)::int AS n FROM notifications');
    await call(db.app, 'fn_chief_assign', w.chief, o.id, w.courier);                         // doit réussir malgré l'échec de la notification
    assert.equal((await db.owner.query('SELECT status FROM orders WHERE id = $1', [o.id])).rows[0].status, 'assigned');
    assert.equal(await count('SELECT count(*)::int AS n FROM notifications'), avant);
  } finally { await db.owner.query('ALTER TABLE notifications DROP CONSTRAINT notif_test_fail'); }
});

test('isolation : on ne lit et on ne marque que ses propres notifications', async () => {
  const mine = (await notes(w.seller))[0];
  const other = (await notes(w.courier))[0];
  assert.ok(mine && other);
  assert.ok(!(await notes(w.seller2)).some((x) => x.id === mine.id));
  const unreadBefore = await call(db.app, 'fn_notifications_unread', w.courier);
  assert.equal(await call(db.app, 'fn_notifications_read', w.seller2, [other.id]), 0);          // id d'un autre : rien ne bouge
  assert.equal(await call(db.app, 'fn_notifications_unread', w.courier), unreadBefore);
  assert.equal((await db.owner.query('SELECT has_function_privilege($1, $2, $3) AS e', ['wld_app', '_notify(uuid,text,text,text,text)', 'EXECUTE'])).rows[0].e, false);
});

test('annonces : réservées à l\'administration, bonnes personnes, bornes de texte, tracées', async () => {
  const sellers = await count(`SELECT count(*)::int AS n FROM users WHERE role = 'seller' AND status = 'active' AND deleted_at IS NULL`);
  await expectErr(call(db.app, 'fn_admin_announce', w.seller, 'all', 'Bonjour', 'Message de test'), 'forbidden');
  await expectErr(call(db.app, 'fn_admin_announce', w.admin, 'pirate', 'Bonjour', 'Message de test'), 'invalid_input');
  await expectErr(call(db.app, 'fn_admin_announce', w.admin, 'seller', 'ab', 'Message de test'), 'invalid_input');
  await expectErr(call(db.app, 'fn_admin_announce', w.admin, 'seller', 'Bonjour', 'x'.repeat(601)), 'invalid_input');
  const r = await call(db.app, 'fn_admin_announce', w.admin, 'seller', 'Nouvelle règle', 'Merci de vérifier vos prix cette semaine.');
  assert.equal(r.recipients, sellers);
  assert.ok((await titles(w.seller)).includes('Nouvelle règle'));
  assert.ok((await titles(w.seller2)).includes('Nouvelle règle'));
  assert.ok(!(await titles(w.courier)).includes('Nouvelle règle'));
  assert.ok(!(await titles(w.admin)).includes('Nouvelle règle'));
  assert.equal(await count(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'announcement'`), 1);
  const list = await call(db.app, 'fn_admin_announcements', w.admin);
  assert.equal(list[0].title, 'Nouvelle règle'); assert.equal(list[0].recipients, sellers);
  await expectErr(call(db.app, 'fn_admin_announcements', w.seller), 'forbidden');
});

test('HTTP : liste, compteur, lecture ; annonces réservées à l\'admin ; connexion obligatoire', async () => {
  assert.equal((await new Client().get('/api/notifications')).status, 401);
  const s = await login(w.seller); const a = await login(w.admin);
  const list = (await s.get('/api/notifications')).json;
  assert.ok(list.items.length > 0 && list.unread > 0);
  assert.equal((await s.get('/api/notifications/unread')).json.unread, list.unread);
  assert.equal((await s.post('/api/notifications/read', { ids: 'x' })).status, 400);
  assert.equal((await s.post('/api/notifications/read', { ids: [list.items[0].id] })).json.marked, list.items[0].read ? 0 : 1);
  assert.equal((await s.post('/api/notifications/read', {})).status, 200);
  assert.equal((await s.get('/api/notifications/unread')).json.unread, 0);
  assert.equal((await s.post('/api/admin/announcements', { audience: 'all', title: 'Test', body: 'Message' })).status, 403);
  assert.equal((await s.get('/api/admin/announcements')).status, 403);
  const r = await a.post('/api/admin/announcements', { audience: 'courier', title: 'Pour les livreurs', body: 'Réunion demain à 9 h.' });
  assert.equal(r.status, 201); assert.equal(r.json.recipients, 2);
  assert.equal((await a.get('/api/admin/announcements')).json.announcements[0].title, 'Pour les livreurs');
  const c = await login(w.courier);
  assert.ok((await c.get('/api/notifications')).json.items.some((x) => x.title === 'Pour les livreurs'));
});

test('droits de la base : fonctions publiques sécurisées, déclencheurs internes non appelables', async () => {
  for (const f of ['fn_my_notifications', 'fn_notifications_unread', 'fn_notifications_read', 'fn_admin_announce', 'fn_admin_announcements']) {
    const r = (await db.owner.query(`SELECT prosecdef, proconfig::text AS c, has_function_privilege('wld_app', oid, 'EXECUTE') AS e FROM pg_proc WHERE proname = $1`, [f])).rows;
    assert.equal(r.length, 1, f); assert.equal(r[0].prosecdef, true); assert.match(r[0].c, /search_path=public, pg_temp/); assert.equal(r[0].e, true);
  }
  for (const f of ['_notify', '_gnf_text', '_notify_order_status', '_notify_withdrawal', '_notify_bonus', '_notify_identity', '_notify_product', '_notify_tour', '_notify_support']) {
    assert.equal((await db.owner.query(`SELECT has_function_privilege('wld_app', oid, 'EXECUTE') AS e FROM pg_proc WHERE proname = $1`, [f])).rows[0].e, false, f);
  }
  // la base ne peut ni écrire ni effacer directement dans les notifications (tout passe par les fonctions)
  assert.equal((await db.owner.query(`SELECT has_table_privilege('wld_app', 'notifications', 'INSERT') AS i, has_table_privilege('wld_app', 'notifications', 'UPDATE') AS u, has_table_privilege('wld_app', 'notifications', 'DELETE') AS d`)).rows[0].i, false);
});

test('retour arrière 027 : retire notifications et déclencheurs sans toucher aux commandes ; migration rejouable', async () => {
  const rb = ['042', '041', '040', '039', '038', '037', '036', '035', '034', '033', '032', '031', '028', '027'].map((x) => fs.readFileSync(path.join(root, 'docs', `retour-arriere-${x}.sql`), 'utf8')).join('\n');   // la 028 dépend de la 027
  await db.owner.query('BEGIN');
  try { for (const s of splitSql(rb)) { if (/^(begin|commit)$/i.test(s.trim())) continue; await db.owner.query(s); } await db.owner.query('COMMIT'); } catch (e) { await db.owner.query('ROLLBACK'); throw e; }
  assert.equal(await count(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('notifications','announcements')`), 0, 'tables');
  assert.deepEqual((await db.owner.query(`SELECT proname FROM pg_proc WHERE proname LIKE '\\_notify%' OR proname IN ('_gnf_text','fn_my_notifications','fn_notifications_unread','fn_notifications_read','fn_admin_announce','fn_admin_announcements')`)).rows, [], 'fonctions');
  assert.deepEqual((await db.owner.query(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('orders_notify','withdrawals_notify','wallet_bonus_notify','identity_notify','products_notify','tours_notify','support_notify')`)).rows, [], 'déclencheurs');
  const o = await mk();
  await call(db.app, 'fn_chief_assign', w.chief, o.id, w.courier);                                // les commandes continuent de fonctionner
  assert.equal((await db.owner.query('SELECT status FROM orders WHERE id = $1', [o.id])).rows[0].status, 'assigned');
  await migrate({ ...TEST_DB, database: 'wld_notif' }, APP_PW, () => {});
  assert.equal(await count(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '027_notifications.sql'`), 1);
  assert.equal(await count(`SELECT count(*)::int AS n FROM pg_tables WHERE tablename = 'notifications'`), 1);
});
