// 044 : relances des clients (SMS, WhatsApp, appel), étiquettes, rappels, fêtes, désinscription, règles de contact, droits, retour arrière.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshDb, TEST_DB, APP_PW, world, call, expectErr, deliver } from './helpers.js';
import { splitSql } from '../src/migrate.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';
import { autoTags } from '../src/relances.js';

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
const toWarehouse = async (o, cause = 'customer_refusal') => {
  await call(db.app, 'fn_agent_take_order', w.agent1, o.id); await call(db.app, 'fn_agent_log_call', w.agent1, o.id, 'confirmed', 'OK');
  await call(db.app, 'fn_chief_assign', w.chief, o.id, w.courier); await call(db.app, 'fn_courier_pickup', w.courier, o.id);
  await call(db.app, 'fn_courier_fail', w.courier, o.id, 'customer_refusal'); await call(db.app, 'fn_chief_return_to_warehouse', w.chief, o.id);
  await call(db.app, 'fn_warehouse_receive_return', w.warehouse, o.id, cause);
};
const failAbsent = async (o) => {
  await call(db.app, 'fn_agent_take_order', w.agent1, o.id); await call(db.app, 'fn_agent_log_call', w.agent1, o.id, 'confirmed', 'OK');
  await call(db.app, 'fn_chief_assign', w.chief, o.id, w.courier); await call(db.app, 'fn_courier_pickup', w.courier, o.id);
  await call(db.app, 'fn_courier_fail', w.courier, o.id, 'customer_absent');
};
const walletTotals = async () => (await rows('SELECT count(*)::int AS n, COALESCE(sum(amount),0)::text AS t FROM wallet_entries'))[0];
const phones = (r) => r.json.customers.map((c) => c.phone).sort();

// clients du scénario (vendeur 1)
const A = '622000001', B = '622000002', C = '622000003', D = '622000004', E = '622000005', F = '622000006';
let s, s2, admin, courier, seen;

before(async () => {
  db = await freshDb('wld_relances'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_relances', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
  s = await login(w.seller); s2 = await login(w.seller2); admin = await login(w.admin); courier = await login(w.courier);

  // A : 2 livraisons (fidèle, bon client) ; B : 1 livraison (nouveau) ; C : 1 livraison il y a 45 jours (inactif) ;
  // D : client absent (commande non aboutie) ; E : a refusé le colis (client à risque) ; F : 1 livraison (pour les essais d'étiquettes, de rappels)
  for (const extra of [{ customer_phone: A, customer_name: 'Mariama Diallo' }, { customer_phone: A, customer_name: 'Mariama Diallo' }, { customer_phone: B, customer_name: 'Ibrahima Sow' },
    { customer_phone: C, customer_name: 'Fanta Camara' }, { customer_phone: F, customer_name: 'Oumar Barry' }]) {
    const o = await place(s, extra); await deliver(db, w, o.id, o.ref);
    if (extra.customer_phone === C) await db.owner.query(`UPDATE orders SET delivered_at = now() - interval '45 days' WHERE id = $1`, [o.id]);
  }
  await failAbsent(await place(s, { customer_phone: D, customer_name: 'Sekou Bah' }));
  await toWarehouse(await place(s, { customer_phone: E, customer_name: 'Aissatou Keita' }));
  seen = await walletTotals();
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });

test('éteinte au départ : rien n\'est possible tant que l\'administrateur ne l\'allume pas', async () => {
  assert.deepEqual((await s.get('/api/seller/relances')).json, { enabled: false });
  assert.equal((await s.get('/api/seller/relances/list?list=fideles')).status, 403);
  assert.equal((await s.get(`/api/seller/relances/customer/${A}`)).status, 403);
  const r = await s.post('/api/seller/relances/log', { phone: A, channel: 'sms' });
  assert.equal(r.status, 403); assert.equal(r.json.error, 'feature_off');
  assert.equal((await s.post('/api/seller/relances/open', { phone: A, channel: 'call' })).json.error, 'feature_off');
  assert.equal((await s.post('/api/seller/relances/templates', { title: 'x', body: 'Bonjour' })).json.error, 'feature_off');
  assert.equal((await s.post('/api/seller/relances/tags', { name: 'x', color: 'green' })).json.error, 'feature_off');
  // seul l'administrateur l'allume
  assert.equal((await s.post('/api/admin/settings', { key: 'feature_relances', value: 1 })).status, 403);
  assert.equal((await admin.post('/api/admin/settings', { key: 'feature_relances', value: 1 })).status, 200);
  const o = (await s.get('/api/seller/relances')).json;
  assert.equal(o.enabled, true); assert.equal(o.consent.ok, false); assert.equal(o.prefs.interval_days, 14); assert.equal(o.prefs.daily_max, null);
});

test('engagement du vendeur : obligatoire avant tout contact, à la bonne version du texte', async () => {
  const r = await s.post('/api/seller/relances/open', { phone: B, channel: 'sms' });
  assert.equal(r.status, 403); assert.equal(r.json.error, 'consent_required');
  assert.equal((await s.post('/api/seller/relances/log', { phone: B, channel: 'sms' })).json.error, 'consent_required');
  assert.equal((await s.post('/api/seller/relances/consent', { version: 99 })).status, 400, 'mauvaise version');
  assert.equal((await s.post('/api/seller/relances/consent', { version: 1 })).status, 200);
  assert.equal((await s.get('/api/seller/relances')).json.consent.ok, true);
  assert.equal((await s2.post('/api/seller/relances/open', { phone: A, channel: 'sms' })).json.error, 'consent_required', 'l\'engagement d\'un vendeur ne vaut pas pour un autre');
  assert.equal((await courier.post('/api/seller/relances/consent', { version: 1 })).status, 403);
  assert.equal((await new Client().get('/api/seller/relances')).status, 401);
});

test('listes et étiquettes automatiques : fidèles, nouveaux, inactifs, commande non aboutie, à éviter', async () => {
  const o = (await s.get('/api/seller/relances')).json;
  assert.equal(o.lists.fideles, 1); assert.equal(o.lists.nouveaux, 3);              // A, B et F (première livraison il y a moins de 30 jours)
  assert.equal(o.lists.inactifs_30, 1); assert.equal(o.lists.inactifs_60, 0); assert.equal(o.lists.non_abouti, 1);
  assert.equal(o.lists.a_eviter, 1); assert.equal(o.lists.total, 5, 'A, B, C, D, F ; E (à risque) n\'est dans aucune liste d\'envoi');
  const l = async (q) => phones(await s.get(`/api/seller/relances/list?list=${q}`));
  assert.deepEqual(await l('fideles'), [A]);
  assert.deepEqual(await l('nouveaux'), [A, B, F]);
  assert.deepEqual(await l('inactifs&days=30'), [C]);
  assert.deepEqual(await l('inactifs&days=60'), []);
  assert.deepEqual(await l('non_abouti'), [D]);
  assert.deepEqual(await l('fete'), [A, B, C, F], 'tous les clients livrés au moins une fois');
  assert.deepEqual(await l('a_eviter'), [E]);
  const get = async (list, phone) => (await s.get(`/api/seller/relances/list?list=${list}`)).json.customers.find((c) => c.phone === phone);
  assert.deepEqual((await get('fete', A)).auto_tags.sort(), ['bon_client', 'fidele', 'livre', 'nouveau', 'paye']);
  assert.deepEqual((await get('fete', C)).auto_tags.sort(), ['inactif', 'livre', 'paye']);
  assert.deepEqual((await get('non_abouti', D)).auto_tags.sort(), ['a_relancer', 'echec']);
  const e = await get('a_eviter', E);
  assert.ok(e.auto_tags.includes('a_risque') && e.auto_tags.includes('echec')); assert.equal(e.can_message, false); assert.equal(e.can_call, false);
  assert.equal((await s.get('/api/seller/relances/list?list=a_eviter')).json.readonly, true);
  assert.equal((await s.get('/api/seller/relances/list?list=nimporte')).status, 400);
  // un client à risque n'est dans AUCUNE liste d'envoi
  for (const k of ['fideles', 'nouveaux', 'inactifs', 'non_abouti', 'fete', 'rappels']) assert.ok(!(await l(k)).includes(E), `${k} ne contient pas le client à risque`);
  // un vendeur ne voit jamais les clients d'un autre
  await s2.post('/api/seller/relances/consent', { version: 1 });
  assert.equal((await s2.get('/api/seller/relances')).json.lists.total, 0);
  assert.deepEqual(await phones(await s2.get('/api/seller/relances/list?list=fete')), []);
  assert.equal((await s2.get(`/api/seller/relances/customer/${A}`)).status, 404);
  // règle de calcul seule (sans base)
  assert.deepEqual(autoTags({ delivered: 0, paid: 0, failed: 0, last_status: 'new', reminder_on: null, first_delivered_at: null, last_delivered_at: null, risk_incidents: null }), []);
});

test('contact : un message par client tous les 14 jours, bloqué par le serveur ; l\'appel n\'est pas limité par ce délai', async () => {
  assert.equal((await s.post('/api/seller/relances/open', { phone: B, channel: 'sms' })).status, 200);
  const r1 = await s.post('/api/seller/relances/log', { phone: B, channel: 'sms', list: 'nouveaux' });
  assert.equal(r1.status, 201);
  const r2 = await s.post('/api/seller/relances/log', { phone: B, channel: 'whatsapp' });
  assert.equal(r2.status, 409); assert.equal(r2.json.error, 'too_soon'); assert.match(r2.json.message, /prochain message possible/);
  assert.equal((await s.post('/api/seller/relances/open', { phone: B, channel: 'sms' })).json.error, 'too_soon', 'bloqué dès l\'ouverture, avant même d\'ouvrir SMS');
  const row = (await s.get('/api/seller/relances/list?list=nouveaux')).json.customers.find((c) => c.phone === B);
  assert.equal(row.can_message, false); assert.equal(row.can_call, true); assert.equal(row.next_message_on, dayStr(14));
  assert.equal((await s.get('/api/seller/relances/list?list=nouveaux')).json.blocked_recently, 1);
  // l'appel reste possible, avec son résultat
  assert.equal((await s.post('/api/seller/relances/log', { phone: B, channel: 'call', outcome: 'answered' })).status, 201);
  assert.equal((await s.post('/api/seller/relances/log', { phone: B, channel: 'call' })).status, 400, 'résultat de l\'appel obligatoire');
  assert.equal((await s.post('/api/seller/relances/log', { phone: B, channel: 'call', outcome: 'magie' })).status, 400);
  assert.equal((await s.post('/api/seller/relances/log', { phone: F, channel: 'sms', outcome: 'answered' })).status, 400, 'un message n\'a pas de résultat d\'appel');
  // client à risque, inconnu, ou client d'un autre vendeur : jamais
  for (const ch of ['sms', 'whatsapp', 'call']) {
    const e = await s.post('/api/seller/relances/open', { phone: E, channel: ch });
    assert.equal(e.status, 409); assert.equal(e.json.error, 'risky_customer');
  }
  assert.equal((await s.post('/api/seller/relances/open', { phone: '699999999', channel: 'sms' })).status, 404, 'numéro sans commande');
  assert.equal((await s2.post('/api/seller/relances/open', { phone: B, channel: 'sms' })).status, 404, 'client d\'un autre vendeur');
  assert.equal((await s.post('/api/seller/relances/open', { phone: '12', channel: 'sms' })).status, 400);
  assert.equal((await s.post('/api/seller/relances/open', { phone: B, channel: 'pigeon' })).status, 400);
  assert.equal((await courier.post('/api/seller/relances/open', { phone: B, channel: 'sms' })).status, 403);
  // le journal ne garde que qui, quand, quel canal
  const log = await rows(`SELECT channel, outcome, list_key FROM relance_log WHERE seller_id = $1 AND customer_phone = $2 ORDER BY id`, [w.seller, B]);
  assert.deepEqual(log, [{ channel: 'sms', outcome: null, list_key: 'nouveaux' }, { channel: 'call', outcome: 'answered', list_key: null }]);
});

test('le texte des messages n\'est jamais enregistré', async () => {
  const cols = (await rows(`SELECT column_name FROM information_schema.columns WHERE table_name = 'relance_log' ORDER BY ordinal_position`)).map((r) => r.column_name);
  assert.deepEqual(cols, ['id', 'seller_id', 'customer_phone', 'channel', 'outcome', 'list_key', 'at']);
  assert.equal((await s.post('/api/seller/relances/log', { phone: F, channel: 'sms', text: 'MESSAGE-SECRET-123', body: 'MESSAGE-SECRET-123' })).status, 201);
  for (const t of ['relance_log', 'relance_prefs', 'relance_optouts', 'relance_templates', 'relance_tags', 'relance_reminders', 'relance_feasts', 'audit_log']) {
    assert.ok(!(await rows(`SELECT x::text AS r FROM ${t} x`)).some((r) => r.r.includes('MESSAGE-SECRET-123')), `${t} ne contient pas le texte`);
  }
});

test('réglages du vendeur : délai entre deux messages (7 jours au minimum), maximum par jour choisi par lui, sans plafond imposé', async () => {
  const set = (b) => s.post('/api/seller/relances/prefs', b);
  assert.equal((await set({ interval_days: 5, daily_max: null })).status, 400, 'moins de 7 jours refusé');
  assert.equal((await set({ interval_days: 14, daily_max: 0 })).status, 400);
  assert.equal((await set({ interval_days: 14, shop_name: 'x' })).status, 400, 'nom de boutique trop court');
  assert.equal((await set({ interval_days: 7, daily_max: null, shop_name: 'Boutique Mariam' })).status, 200);
  let o = (await s.get('/api/seller/relances')).json;
  assert.equal(o.prefs.interval_days, 7); assert.equal(o.prefs.daily_max, null); assert.equal(o.prefs.shop_name, 'Boutique Mariam');
  // avec 7 jours : un message d'il y a 8 jours ne bloque plus ; un d'il y a 6 jours bloque encore
  await db.owner.query(`UPDATE relance_log SET at = now() - interval '6 days' WHERE seller_id = $1 AND customer_phone = $2 AND channel = 'sms'`, [w.seller, B]);
  assert.equal((await s.post('/api/seller/relances/open', { phone: B, channel: 'sms' })).json.error, 'too_soon');
  await db.owner.query(`UPDATE relance_log SET at = now() - interval '8 days' WHERE seller_id = $1 AND customer_phone = $2 AND channel = 'sms'`, [w.seller, B]);
  assert.equal((await s.post('/api/seller/relances/open', { phone: B, channel: 'sms' })).status, 200);
  // le vendeur fixe son maximum par jour ; atteint, il est arrêté ; il peut le changer quand il veut
  const today = (await s.get('/api/seller/relances')).json.sent_today;
  assert.equal((await set({ interval_days: 7, daily_max: today + 1 })).status, 200);
  assert.equal((await s.post('/api/seller/relances/log', { phone: A, channel: 'sms' })).status, 201);
  const stop = await s.post('/api/seller/relances/log', { phone: C, channel: 'sms' });
  assert.equal(stop.status, 409); assert.equal(stop.json.error, 'daily_limit'); assert.match(stop.json.message, /maximum de/);
  assert.equal((await s.post('/api/seller/relances/open', { phone: C, channel: 'call' })).status, 200, 'l\'appel n\'est pas compté dans le maximum de messages');
  const lst = (await s.get('/api/seller/relances/list?list=fete')).json;
  assert.equal(lst.daily_reached, true); assert.ok(lst.customers.every((c) => !c.can_message));
  assert.equal((await set({ interval_days: 7, daily_max: today + 50 })).status, 200);
  assert.equal((await s.post('/api/seller/relances/log', { phone: C, channel: 'whatsapp' })).status, 201);
  // sans maximum : aucune limite pour le vendeur ; seule reste la protection technique cachée (3 000 par jour)
  assert.equal((await set({ interval_days: 7, daily_max: null })).status, 200);
  await db.owner.query(`INSERT INTO relance_log(seller_id, customer_phone, channel) SELECT $1, '6' || lpad(g::text, 8, '0'), 'sms' FROM generate_series(1, 3000) g`, [w.seller]);
  const cap = await s.post('/api/seller/relances/log', { phone: D, channel: 'whatsapp' });
  assert.equal(cap.status, 409); assert.equal(cap.json.error, 'daily_limit'); assert.match(cap.json.message, /sécurité/);
  await db.owner.query(`DELETE FROM relance_log WHERE customer_phone LIKE '6%' AND customer_phone NOT IN ($1,$2,$3,$4,$5,$6)`, [A, B, C, D, E, F]);
  assert.equal((await s.post('/api/seller/relances/log', { phone: D, channel: 'whatsapp' })).status, 201, 'sans limite tant que la protection technique n\'est pas atteinte');
  await set({ interval_days: 14, daily_max: null, shop_name: 'Boutique Mariam' });
});

test('rappels : « à rappeler » après un appel, date choisie, bandeau du jour, rappel effacé quand le client est relancé', async () => {
  const r = await s.post('/api/seller/relances/log', { phone: D, channel: 'call', outcome: 'call_back' });
  assert.equal(r.status, 201);
  assert.equal((await s.get('/api/seller/relances/list?list=non_abouti')).json.customers[0].reminder_on, dayStr(1), 'sans date : demain');
  assert.deepEqual(phones(await s.get('/api/seller/relances/list?list=rappels')), [], 'pas encore dû');
  assert.equal((await s.post(`/api/seller/relances/customers/${D}/reminder`, { date: dayStr(0) })).status, 200);
  assert.deepEqual(phones(await s.get('/api/seller/relances/list?list=rappels')), [D]);
  assert.equal((await s.get('/api/seller/relances')).json.reminders_today, 1);
  assert.equal((await s.post(`/api/seller/relances/customers/${F}/reminder`, { date: dayStr(-1) })).status, 400, 'date passée');
  assert.equal((await s.post(`/api/seller/relances/customers/${F}/reminder`, { date: 'vendredi' })).status, 400);
  assert.equal((await s.post(`/api/seller/relances/customers/${E}/reminder`, { date: dayStr(2) })).json.error, 'risky_customer');
  assert.equal((await s.post(`/api/seller/relances/customers/699999999/reminder`, { date: dayStr(2) })).status, 404);
  assert.equal((await s2.post(`/api/seller/relances/customers/${D}/reminder`, { date: dayStr(2) })).status, 404, 'client d\'un autre vendeur');
  // un rappel précis choisi après l'appel
  assert.equal((await s.post('/api/seller/relances/log', { phone: D, channel: 'call', outcome: 'call_back', remind_on: dayStr(3) })).status, 201);
  assert.equal((await s.get('/api/seller/relances/list?list=non_abouti')).json.customers[0].reminder_on, dayStr(3));
  // le client est relancé : le rappel disparaît
  assert.equal((await s.post('/api/seller/relances/log', { phone: D, channel: 'call', outcome: 'answered' })).status, 201);
  assert.equal((await s.get('/api/seller/relances/list?list=non_abouti')).json.customers[0].reminder_on, null);
  assert.equal((await s.post(`/api/seller/relances/customers/${F}/reminder`, { date: dayStr(5) })).status, 200);
  assert.equal((await s.post(`/api/seller/relances/customers/${F}/reminder`, { date: null })).status, 200, 'effacer le rappel');
  assert.equal((await s.post('/api/seller/relances/log', { phone: F, channel: 'call', outcome: 'call_back', remind_on: dayStr(-2) })).status, 400);
});

test('« ne plus contacter » : le client disparaît de toutes les listes, seul l\'administrateur peut le réactiver', async () => {
  const before = (await s.get('/api/seller/relances')).json.lists.total;
  assert.equal((await s.post(`/api/seller/relances/customers/${C}/optout`)).status, 200);
  assert.equal((await s.get('/api/seller/relances')).json.lists.total, before - 1);
  for (const k of ['fideles', 'nouveaux', 'inactifs', 'non_abouti', 'fete', 'rappels', 'a_eviter']) assert.ok(!(await phones(await s.get(`/api/seller/relances/list?list=${k}`))).includes(C), `${k}`);
  for (const ch of ['sms', 'whatsapp', 'call']) { const r = await s.post('/api/seller/relances/open', { phone: C, channel: ch }); assert.equal(r.status, 409); assert.equal(r.json.error, 'opted_out'); }
  assert.equal((await s.post(`/api/seller/relances/customers/${C}/reminder`, { date: dayStr(2) })).json.error, 'opted_out');
  assert.equal((await s.post(`/api/seller/relances/customers/699999999/optout`)).status, 404);
  assert.equal((await s2.post(`/api/seller/relances/customers/${A}/optout`)).status, 404, 'un vendeur ne désinscrit pas le client d\'un autre');
  // seul l'administrateur voit la liste des désinscrits et peut réactiver
  assert.equal((await s.get('/api/admin/relances/optouts')).status, 403);
  assert.equal((await s.post('/api/admin/relances/reactivate', { seller_id: w.seller, phone: C })).status, 403);
  const list = (await admin.get('/api/admin/relances/optouts')).json.optouts;
  assert.equal(list.length, 1); assert.equal(list[0].customer_phone, C); assert.equal(list[0].seller_name, 'Vendeur Un');
  assert.equal((await admin.post('/api/admin/relances/reactivate', { seller_id: w.seller, phone: C })).status, 200);
  assert.equal((await admin.post('/api/admin/relances/reactivate', { seller_id: w.seller, phone: C })).status, 404, 'déjà réactivé');
  assert.ok((await phones(await s.get('/api/seller/relances/list?list=fete'))).includes(C));
  assert.ok((await rows(`SELECT 1 FROM audit_log WHERE action IN ('relance_optout','relance_optout_removed')`)).length >= 2, 'tout est dans le journal d\'audit');
  // un vendeur ne peut pas réactiver en rappelant la fonction directement
  await expectErr(call(db.app, 'fn_admin_relance_reactivate', w.seller, w.seller, C), 'forbidden');
});

test('étiquettes du vendeur : couleur, plusieurs par client, liste par étiquette, rien chez les autres vendeurs', async () => {
  const mk = (b) => s.post('/api/seller/relances/tags', b);
  const t1 = await mk({ name: 'Tabaski', color: 'gold' }); assert.equal(t1.status, 201);
  const t2 = await mk({ name: 'Gros acheteur', color: 'green' }); assert.equal(t2.status, 201);
  assert.equal((await mk({ name: 'tabaski', color: 'red' })).status, 409, 'même nom (majuscules ignorées)');
  assert.equal((await mk({ name: 'Rose', color: 'rose' })).status, 400, 'couleur inconnue');
  assert.equal((await mk({ name: '', color: 'red' })).status, 400);
  const setTag = (tag, phone, on = true, who = s) => who.post(`/api/seller/relances/customers/${phone}/tags`, { tag_id: tag, on });
  assert.equal((await setTag(t1.json.id, A)).status, 200); assert.equal((await setTag(t1.json.id, B)).status, 200); assert.equal((await setTag(t2.json.id, A)).status, 200);
  assert.deepEqual(await phones(await s.get(`/api/seller/relances/list?list=etiquette&tag=${t1.json.id}`)), [A, B]);
  assert.deepEqual(await phones(await s.get(`/api/seller/relances/list?list=etiquette&tag=${t2.json.id}`)), [A]);
  const a = (await s.get(`/api/seller/relances/list?list=etiquette&tag=${t1.json.id}`)).json.customers.find((c) => c.phone === A);
  assert.deepEqual(a.tags.map((t) => t.name).sort(), ['Gros acheteur', 'Tabaski']);
  assert.equal((await s.get('/api/seller/relances/list?list=etiquette')).status, 400, 'étiquette obligatoire');
  assert.equal((await s.get(`/api/seller/relances/list?list=etiquette&tag=${crypto.randomUUID()}`)).status, 404);
  assert.equal((await s.get('/api/seller/relances')).json.tags.find((t) => t.name === 'Tabaski').count, 2);
  // un client à risque ou désinscrit reste hors des listes, même étiqueté
  assert.equal((await setTag(t1.json.id, E)).status, 200);
  assert.ok(!(await phones(await s.get(`/api/seller/relances/list?list=etiquette&tag=${t1.json.id}`))).includes(E));
  // cloisonnement
  assert.equal((await setTag(t1.json.id, A, true, s2)).status, 404, 'étiquette d\'un autre vendeur');
  assert.equal((await s2.post(`/api/seller/relances/tags/${t1.json.id}/delete`)).status, 404);
  assert.equal((await s2.get(`/api/seller/relances/list?list=etiquette&tag=${t1.json.id}`)).status, 404);
  // retirer, puis supprimer
  assert.equal((await setTag(t1.json.id, B, false)).status, 200);
  assert.deepEqual(await phones(await s.get(`/api/seller/relances/list?list=etiquette&tag=${t1.json.id}`)), [A]);
  assert.equal((await s.post(`/api/seller/relances/tags/${t2.json.id}/delete`)).status, 200);
  assert.equal((await s.get('/api/seller/relances')).json.tags.some((t) => t.name === 'Gros acheteur'), false);
  assert.equal((await s.get(`/api/seller/relances/list?list=etiquette&tag=${t2.json.id}`)).status, 404);
  assert.equal((await mk({ name: 'Gros acheteur', color: 'blue' })).status, 201, 'le nom d\'une étiquette supprimée peut servir de nouveau');
});

test('modèles de messages : seules les marques {prenom}, {boutique} et {fete} ; modifier, supprimer, jamais ceux d\'un autre vendeur', async () => {
  const save = (b, who = s) => who.post('/api/seller/relances/templates', b);
  const t = await save({ title: 'Merci', body: 'Bonjour {prenom}, merci de votre confiance chez {boutique}.' }); assert.equal(t.status, 201);
  assert.equal((await save({ title: 'Fête', body: 'Bonne {fete} {prenom} !' })).status, 201);
  assert.equal((await save({ title: 'Code', body: 'Votre code de livraison est {code}' })).status, 400, 'jamais de code de livraison');
  assert.equal((await save({ title: 'Cmd', body: 'Commande {ref} en route' })).status, 400, 'jamais d\'information de commande');
  assert.equal((await save({ title: '', body: 'x' })).status, 400); assert.equal((await save({ title: 'Long', body: 'x'.repeat(301) })).status, 400);
  assert.equal((await save({ id: t.json.id, title: 'Merci 2', body: 'Salut {prenom}' })).status, 200);
  assert.equal((await save({ id: t.json.id, title: 'Piraté', body: 'x' }, s2)).status, 404);
  assert.equal((await s2.get('/api/seller/relances')).json.templates.length, 0);
  assert.deepEqual((await s.get('/api/seller/relances')).json.templates.map((x) => x.title), ['Merci 2', 'Fête']);
  assert.equal((await s2.post(`/api/seller/relances/templates/${t.json.id}/delete`)).status, 404);
  assert.equal((await s.post(`/api/seller/relances/templates/${t.json.id}/delete`)).status, 200);
  assert.equal((await s.post(`/api/seller/relances/templates/${t.json.id}/delete`)).status, 404, 'déjà supprimé');
  assert.deepEqual((await s.get('/api/seller/relances')).json.templates.map((x) => x.title), ['Fête']);
});

test('fêtes : saisies par le vendeur (aucune date d\'avance), rappel affiché dans la vue d\'ensemble', async () => {
  assert.deepEqual((await s.get('/api/seller/relances')).json.feasts, [], 'aucune fête mise d\'avance');
  const f = await s.post('/api/seller/relances/feasts', { name: 'Tabaski', date: dayStr(6) }); assert.equal(f.status, 201);
  const o = (await s.get('/api/seller/relances')).json;
  assert.equal(o.feasts.length, 1); assert.equal(o.feasts[0].name, 'Tabaski'); assert.equal(o.feasts[0].days_left, 6);
  assert.equal((await s.post('/api/seller/relances/feasts', { name: 'Hier', date: dayStr(-1) })).status, 400);
  assert.equal((await s.post('/api/seller/relances/feasts', { name: 'Loin', date: dayStr(900) })).status, 400);
  assert.equal((await s.post('/api/seller/relances/feasts', { name: 'Bof', date: 'demain' })).status, 400);
  assert.equal((await s.post('/api/seller/relances/feasts', { id: f.json.id, name: 'Tabaski 2026', date: dayStr(8) })).status, 200);
  assert.equal((await s.get('/api/seller/relances')).json.feasts[0].days_left, 8);
  assert.equal((await s2.post('/api/seller/relances/feasts', { id: f.json.id, name: 'Piraté', date: dayStr(8) })).status, 404);
  assert.equal((await s2.get('/api/seller/relances')).json.feasts.length, 0);
  assert.equal((await s2.post(`/api/seller/relances/feasts/${f.json.id}/delete`)).status, 404);
  assert.equal((await s.post(`/api/seller/relances/feasts/${f.json.id}/delete`)).status, 200);
  assert.equal((await s.get('/api/seller/relances')).json.feasts.length, 0);
});

test('fiche du client : historique daté (commande, livraison, échec, relances), cloisonné par vendeur', async () => {
  const h = (await s.get(`/api/seller/relances/customer/${B}`)).json;
  const kinds = h.history.map((e) => e.kind);
  assert.ok(kinds.includes('order_created') && kinds.includes('delivered') && kinds.includes('relance'));
  assert.ok(h.history.some((e) => e.kind === 'relance' && e.channel === 'call' && e.outcome === 'answered'));
  assert.ok(h.history.every((e) => e.at), 'chaque ligne est datée');
  assert.deepEqual(h.auto_tags.sort(), ['livre', 'nouveau', 'paye']);
  assert.ok(Array.isArray(h.all_tags));
  const d = (await s.get(`/api/seller/relances/customer/${D}`)).json;
  assert.ok(d.history.some((e) => e.kind === 'failed'), 'échec dans l\'historique');
  const e = (await s.get(`/api/seller/relances/customer/${E}`)).json;
  assert.equal(e.risky, true); assert.ok(e.history.some((x) => x.kind === 'returned' || x.kind === 'failed'));
  await s.post(`/api/seller/customers/${B}/note`, { note: 'Préfère WhatsApp' });
  assert.ok((await s.get(`/api/seller/relances/customer/${B}`)).json.history.some((x) => x.kind === 'note'));
  assert.equal((await s2.get(`/api/seller/relances/customer/${B}`)).status, 404);
  assert.equal((await s.get('/api/seller/relances/customer/699999999')).status, 404);
  assert.equal((await s.get('/api/seller/relances/customer/12')).status, 400);
});

test('aucun argent de la plateforme n\'est touché par les relances', async () => {
  assert.deepEqual(await walletTotals(), seen, 'portefeuilles et frais inchangés depuis le début');
  assert.equal((await db.app.query(`SELECT count(*)::int AS n FROM fn_ledger_check()`)).rows[0].n, 0);
});

test('droits de la base : le compte applicatif ne touche pas directement aux tables de relances, et seul un vendeur appelle les fonctions du vendeur', async () => {
  for (const sql of [
    `INSERT INTO relance_log(seller_id, customer_phone, channel) VALUES ('${w.seller}', '622000001', 'sms')`,
    `INSERT INTO relance_optouts(seller_id, customer_phone) VALUES ('${w.seller}', '622000001')`,
    `INSERT INTO relance_prefs(seller_id, interval_days) VALUES ('${w.seller2}', 7)`,
    `UPDATE relance_log SET channel = 'call'`, `DELETE FROM relance_log`, `DELETE FROM relance_optouts`, `UPDATE relance_prefs SET interval_days = 7`, `DELETE FROM relance_tags`]) {
    await assert.rejects(() => db.app.query(sql), /permission/, sql);
  }
  await expectErr(call(db.app, 'fn_seller_relance_log', w.courier, B, 'sms', null, null, null), 'forbidden');
  await expectErr(call(db.app, 'fn_seller_relance_open', w.admin, B, 'sms'), 'forbidden');
  await expectErr(call(db.app, 'fn_seller_relance_customers', w.agent1), 'forbidden');
  await assert.rejects(() => db.app.query('SELECT _relance_check($1, $2, $3)', [w.seller, B, 'sms']), /permission/, 'la vérification interne n\'est pas appelable directement');
});

test('vie privée : l\'anonymisation d\'un compte vendeur supprime ses données de relance', async () => {
  const o = await db.owner.query(`INSERT INTO relance_prefs(seller_id, consent_version, consent_at) VALUES ($1, 1, now()) ON CONFLICT (seller_id) DO UPDATE SET consent_version = 1 RETURNING 1`, [w.seller2]); assert.equal(o.rowCount, 1);
  await db.owner.query(`INSERT INTO relance_log(seller_id, customer_phone, channel) VALUES ($1, '633333333', 'sms')`, [w.seller2]);
  await db.owner.query(`INSERT INTO relance_optouts(seller_id, customer_phone) VALUES ($1, '633333333')`, [w.seller2]);
  await db.owner.query(`INSERT INTO relance_templates(seller_id, title, body) VALUES ($1, 'T', 'Bonjour')`, [w.seller2]);
  await db.owner.query(`INSERT INTO relance_feasts(seller_id, name, on_date) VALUES ($1, 'F', current_date + 3)`, [w.seller2]);
  await call(db.app, 'fn_admin_anonymize_user', w.admin, w.seller2);
  for (const t of ['relance_prefs', 'relance_log', 'relance_optouts', 'relance_templates', 'relance_feasts', 'relance_tags', 'relance_reminders', 'relance_customer_tags']) {
    assert.equal((await rows(`SELECT count(*)::int AS n FROM ${t} WHERE seller_id = $1`, [w.seller2]))[0].n, 0, t);
  }
  assert.ok((await rows(`SELECT count(*)::int AS n FROM relance_log WHERE seller_id = $1`, [w.seller]))[0].n > 0, 'les données des autres vendeurs restent');
});

test('retour arrière 044 : refusé s\'il existe des données ou si la fonction est allumée, accepté sinon', async () => {
  const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-044.sql'), 'utf8');
  const run = async () => { await db.owner.query('BEGIN'); try { for (const q of splitSql(rb)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT'); } catch (e) { await db.owner.query('ROLLBACK'); throw e; } };
  await assert.rejects(run, /des données de relance existent/);
  for (const t of ['relance_customer_tags', 'relance_tags', 'relance_reminders', 'relance_feasts', 'relance_templates', 'relance_log', 'relance_optouts', 'relance_prefs']) await db.owner.query(`DELETE FROM ${t}`);
  await assert.rejects(run, /éteignez d'abord la fonction/);
  await db.owner.query(`UPDATE settings SET value = 0 WHERE key = 'feature_relances'`);
  await run();
  assert.equal((await rows(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name LIKE 'relance\\_%'`))[0].n, 0);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE '%relance%'`))[0].n, 0);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM settings WHERE key = 'feature_relances'`))[0].n, 0);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '044_relances.sql'`))[0].n, 0);
  assert.equal((await rows(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'users_relances_anonymized'`))[0].n, 0);
});
