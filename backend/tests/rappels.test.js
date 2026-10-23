// Rappel des colis non récupérés, alerte dans l'application, liste « pour bien démarrer » du vendeur.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, TEST_DB, APP_PW, call, world, approvedProduct } from './helpers.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';

let db, w, prod, srv, base, zone;
const PW = 'Secret123';
let n = 0; const ph = () => `67${String(5000000 + ++n)}`;
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
const loginAs = async (id) => { const c = new Client(); const phone = (await db.owner.query('SELECT phone FROM users WHERE id=$1', [id])).rows[0].phone; const r = await c.post('/api/auth/login', { identifier: phone, password: PW }); assert.equal(r.status, 200); return c; };
const assigned = async (courier) => {
  const o = await call(db.app, 'fn_seller_create_order', w.seller, prod, null, 150000, 1, 'Client Test', ph(), zone, 'Rue du Test', null, false);
  await call(db.app, 'fn_agent_take_order', w.agent1, o.id); await call(db.app, 'fn_agent_log_call', w.agent1, o.id, 'confirmed', 'OK');
  await call(db.app, 'fn_chief_assign', w.chief, o.id, courier); return o;
};
// l'historique est en ajout seul : pour vieillir une ligne dans le test, on suspend brièvement la protection (compte propriétaire)
const backdate = async (id, hours) => {
  await db.owner.query('ALTER TABLE order_history DISABLE TRIGGER USER');
  try { await db.owner.query(`UPDATE order_history SET at = now() - make_interval(hours => $2) WHERE order_id = $1 AND to_status = 'assigned'`, [id, hours]); }
  finally { await db.owner.query('ALTER TABLE order_history ENABLE TRIGGER USER'); }
};
const reminders = async () => (await db.owner.query(`SELECT count(*)::int AS n FROM messages WHERE template = 'pickup_reminder'`)).rows[0].n;

beforeEach(() => srv.resetLimits());
before(async () => {
  db = await freshDb('wld_rappels'); w = await world(db); prod = await approvedProduct(db, w, { qty: 50 });
  zone = (await db.owner.query(`SELECT commune FROM delivery_rates WHERE active LIMIT 1`)).rows[0].commune;
  await call(db.app, 'fn_seller_set_price', w.seller, prod, 150000);
  await db.owner.query(`UPDATE users SET password_hash = $1 WHERE id = ANY($2)`, [await hashPassword(PW), [w.admin, w.seller, w.courier, w.chief]]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-19' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_rappels', user: 'wld_app', password: APP_PW, max: 5 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });

test('rappel : un seul message au livreur, seulement après le délai, relancé par une nouvelle affectation', async () => {
  const o = await assigned(w.courier);
  assert.equal(await call(db.app, 'fn_pickup_reminders'), 0);               // trop tôt
  await backdate(o.id, 3);
  assert.equal(await call(db.app, 'fn_pickup_reminders'), 1);
  const msg = (await db.owner.query(`SELECT to_phone, body FROM messages WHERE template = 'pickup_reminder'`)).rows[0];
  assert.equal(msg.to_phone, (await db.owner.query('SELECT phone FROM users WHERE id=$1', [w.courier])).rows[0].phone);
  assert.match(msg.body, new RegExp(o.ref));
  assert.equal(await call(db.app, 'fn_pickup_reminders'), 0);               // pas de répétition
  assert.equal(await reminders(), 1);
  // récupéré : plus de rappel ; réaffecté : le compte à rebours repart de zéro
  await call(db.app, 'fn_chief_assign', w.chief, o.id, w.courier2);
  assert.equal(await call(db.app, 'fn_pickup_reminders'), 0);
  // on simule le temps qui passe : le premier rappel date de 10 h, la nouvelle affectation de 5 h
  await db.owner.query(`UPDATE orders SET pickup_reminded_at = now() - interval '10 hours' WHERE id = $1`, [o.id]);
  await backdate(o.id, 5);
  assert.equal(await call(db.app, 'fn_pickup_reminders'), 1);
  await call(db.app, 'fn_courier_pickup', w.courier2, o.id);
  await backdate(o.id, 9);
  assert.equal(await call(db.app, 'fn_pickup_reminders'), 0);
});

test('rappel désactivé quand le réglage vaut 0', async () => {
  const o = await assigned(w.courier); await backdate(o.id, 10);
  await call(db.app, 'fn_admin_set_setting', w.admin, 'pickup_alert_hours', 0);
  assert.equal(await call(db.app, 'fn_pickup_reminders'), 0);
  await call(db.app, 'fn_admin_set_setting', w.admin, 'pickup_alert_hours', 2);
  assert.equal(await call(db.app, 'fn_pickup_reminders'), 1);
});

test('alerte dans l\'application : livreur, chef et tableau de bord', async () => {
  const late = (await db.owner.query(`SELECT o.id FROM orders o WHERE o.status = 'assigned' ORDER BY o.created_at DESC LIMIT 1`)).rows[0].id;
  await backdate(late, 4);
  const c = await loginAs(w.courier);
  const mine = await c.get('/api/courier/orders');
  assert.equal(mine.json.pickup_alert_hours, 2);
  const row = mine.json.orders.find((x) => x.id === late);
  assert.ok(row.assigned_since && Date.now() - new Date(row.assigned_since).getTime() > 3.5 * 3600_000);
  const chief = await loginAs(w.chief);
  const co = (await chief.get('/api/chief/orders')).json;
  assert.equal(co.pickup_alert_hours, 2); assert.ok(co.orders.find((x) => x.id === late).assigned_since);
  const a = await loginAs(w.admin);
  assert.ok((await a.get('/api/admin/dashboard')).json.pickups_late >= 1);
});

test('liste « pour bien démarrer » du vendeur', async () => {
  const s = await loginAs(w.seller);
  const st = (await s.get('/api/seller/start')).json;
  assert.equal(st.steps.price, true); assert.equal(st.steps.order, true); assert.equal(st.steps.link, false); assert.equal(st.complete, false);
  await call(db.app, 'fn_seller_create_link', w.seller, prod);
  const st2 = (await s.get('/api/seller/start')).json;
  assert.equal(st2.steps.link, true);
  assert.equal((await (await loginAs(w.admin)).get('/api/seller/start')).status, 403);   // réservé aux vendeurs
});
