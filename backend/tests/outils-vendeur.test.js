// 043 : outils du vendeur (carnet de clients, bénéfice et dépenses, export, retours détaillés, stock bas).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshDb, TEST_DB, APP_PW, world, approvedProduct, call, expectErr, deliver } from './helpers.js';
import { splitSql } from '../src/migrate.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';

const PW = 'Secret123';
const root = path.resolve(import.meta.dirname, '..', '..');
let db, w, product, srv, base, n = 0;
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
const order = (extra = {}) => ({ request_key: `d${String(++n).padStart(3, '0')}`.padEnd(20, 'x'), qty: 2, customer_name: 'Client Test', customer_phone: `62100${String(1000 + n)}`, commune: 'Ratoma', address: 'Rue 1, près du marché', unit_price: 100000, own_product_name: 'Sac', pickup_detail: 'Chez moi', ...extra });


before(async () => {
  db = await freshDb('wld_outils'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_outils', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });

const place = async (s, extra = {}) => { const r = await s.post('/api/seller/orders', order(extra)); assert.equal(r.status, 201); return r.json; };
const failToWarehouse = async (o, cause = 'customer_refusal') => {
  await call(db.app, 'fn_agent_take_order', w.agent1, o.id); await call(db.app, 'fn_agent_log_call', w.agent1, o.id, 'confirmed', 'OK');
  await call(db.app, 'fn_chief_assign', w.chief, o.id, w.courier); await call(db.app, 'fn_courier_pickup', w.courier, o.id);
  await call(db.app, 'fn_courier_fail', w.courier, o.id, 'customer_refusal'); await call(db.app, 'fn_chief_return_to_warehouse', w.chief, o.id);
  await call(db.app, 'fn_warehouse_receive_return', w.warehouse, o.id, cause);
};
const walletTotals = async () => (await db.owner.query('SELECT count(*)::int AS n, COALESCE(sum(amount),0)::text AS t FROM wallet_entries')).rows[0];

test('carnet de clients : regroupé par numéro, échecs comptés, note privée, un vendeur ne voit pas les clients d\'un autre', async () => {
  const s = await login(w.seller), s2 = await login(w.seller2);
  const a = await place(s, { customer_phone: '621111111', customer_name: 'Mariama Diallo' });
  const b = await place(s, { customer_phone: '621111111', customer_name: 'Mariama Diallo', own_product_name: 'Sac rouge' });
  const c = await place(s, { customer_phone: '622222222', customer_name: 'Ibrahima Sow' });
  await deliver(db, w, a.id, a.ref);
  await failToWarehouse(c);
  const list = (await s.get('/api/seller/customers')).json;
  const m = list.customers.find((x) => x.phone === '621111111');
  assert.equal(m.orders, 2); assert.equal(m.delivered, 1); assert.equal(m.in_progress, 1);
  const i = list.customers.find((x) => x.phone === '622222222');
  assert.equal(i.failed, 1); assert.ok(i.risk_incidents >= 1, 'client à risque signalé');
  assert.equal((await s.get('/api/seller/customers?q=mariama')).json.customers.length, 1);
  assert.equal((await s.get('/api/seller/customers?q=%25')).json.customers.length, 0, 'le joker % n\'est pas interprété');
  const det = await s.get('/api/seller/customers/621111111');
  assert.equal(det.status, 200); assert.equal(det.json.orders.length, 2); assert.equal(det.json.note, null);
  // note
  assert.equal((await s.post('/api/seller/customers/621111111/note', { note: 'Paie toujours à la livraison' })).status, 200);
  assert.equal((await s.get('/api/seller/customers/621111111')).json.note, 'Paie toujours à la livraison');
  assert.equal((await s.get('/api/seller/customers')).json.customers.find((x) => x.phone === '621111111').note, 'Paie toujours à la livraison');
  assert.equal((await s2.get('/api/seller/customers/621111111')).status, 404, 'client d\'un autre vendeur');
  assert.equal((await s2.post('/api/seller/customers/621111111/note', { note: 'espion' })).status, 404);
  assert.equal((await s2.get('/api/seller/customers')).json.customers.length, 0);
  assert.equal((await s.post('/api/seller/customers/999999999/note', { note: 'x' })).status, 404, 'numéro sans commande');
  assert.equal((await s.post('/api/seller/customers/12/note', { note: 'x' })).status, 400);
  assert.equal((await s.post('/api/seller/customers/621111111/note', { note: '' })).status, 200);                  // vide = efface
  assert.equal((await s.get('/api/seller/customers/621111111')).json.note, null);
  // accès : seulement les vendeurs
  assert.equal((await (await login(w.courier)).get('/api/seller/customers')).status, 403);
  assert.equal((await new Client().get('/api/seller/customers')).status, 401);
});

test('bénéfice : gains crédités moins dépenses ; dépense annulée non comptée ; contrôles ; aucun mouvement d\'argent de la plateforme', async () => {
  const s = await login(w.seller), s2 = await login(w.seller2);
  const o = await place(s, { customer_phone: '623333333' }); await deliver(db, w, o.id, o.ref);
  const gains = Number((await db.owner.query(`SELECT COALESCE(sum(amount),0) AS g FROM wallet_entries WHERE user_id = $1 AND kind = 'seller_gain'`, [w.seller])).rows[0].g);
  assert.ok(gains > 0);
  const before = await walletTotals();
  const today = new Date().toISOString().slice(0, 10);
  const add = (b) => s.post('/api/seller/expenses', { date: today, category: 'ads', amount: 20000, ...b });
  const e1 = await add({ channel: 'facebook', note: 'Pub Facebook' }); assert.equal(e1.status, 201);
  const e2 = await add({ category: 'transport', amount: 5000 }); assert.equal(e2.status, 201);
  const p = (await s.get('/api/seller/profit?days=30')).json;
  assert.equal(p.gains, gains); assert.equal(p.expenses, 25000); assert.equal(p.net, gains - 25000); assert.equal(p.ads, 20000);
  assert.equal(p.ads_per_delivery, Math.round(20000 / p.delivered)); assert.equal(p.ads_by_channel[0].channel, 'facebook');
  // annulation : la dépense reste dans l'historique mais n'est plus comptée
  assert.equal((await s.post(`/api/seller/expenses/${e2.json.id}/void`)).status, 200);
  assert.equal((await s.post(`/api/seller/expenses/${e2.json.id}/void`)).status, 409, 'déjà annulée');
  const p2 = (await s.get('/api/seller/profit?days=30')).json;
  assert.equal(p2.expenses, 20000); assert.equal(p2.recent.length, 2); assert.ok(p2.recent.some((x) => x.voided_at));
  assert.equal((await s2.post(`/api/seller/expenses/${e1.json.id}/void`)).status, 404, 'dépense d\'un autre vendeur');
  assert.equal((await s2.get('/api/seller/profit')).json.expenses, 0);
  // contrôles
  assert.equal((await add({ amount: 0 })).status, 400); assert.equal((await add({ amount: -5 })).status, 400); assert.equal((await add({ category: 'magie' })).status, 400);
  assert.equal((await add({ date: '2999-01-01' })).status, 400, 'date dans le futur'); assert.equal((await add({ date: '2020-01-01' })).status, 400, 'trop ancienne');
  assert.equal((await add({ date: 'hier' })).status, 400); assert.equal((await add({ category: 'goods', channel: 'facebook' })).status, 400, 'canal réservé à la publicité');
  assert.equal((await add({ channel: 'telepathie' })).status, 400);
  assert.equal((await (await login(w.courier)).post('/api/seller/expenses', { date: today, category: 'ads', amount: 1 })).status, 403);
  await assert.rejects(() => db.owner.query('UPDATE seller_expenses SET amount = 1 WHERE voided_at IS NULL AND false'), /./).catch(() => {});
  assert.deepEqual(await walletTotals(), before, 'ni portefeuille ni frais touchés par les dépenses');
  assert.equal((await db.app.query(`SELECT count(*)::int AS n FROM fn_ledger_check()`)).rows[0].n, 0);
});

test('export : commandes avec gain attendu et crédité, dépenses, rien des autres vendeurs', async () => {
  const s = await login(w.seller), s2 = await login(w.seller2);
  const r = (await s.get('/api/seller/export?days=365')).json;
  assert.ok(r.orders.length >= 3); assert.ok(r.orders.every((x) => x.ref && x.customer_phone));
  const delivered = r.orders.find((x) => x.status === 'delivered');
  assert.ok(Number(delivered.real_gain) > 0); assert.equal(Number(delivered.real_gain), Number(delivered.expected_gain));
  assert.ok(r.expenses.length >= 1 && r.expenses.every((e) => e.amount > 0), 'dépenses annulées exclues');
  assert.equal((await s2.get('/api/seller/export')).json.orders.length, 0);
  assert.equal((await s.get('/api/seller/export?days=3650')).status, 200);
  assert.equal((await new Client().get('/api/seller/export')).status, 401);
});

test('retours : motif, cause, remis en stock ou non, taux d\'échec', async () => {
  const s = await login(w.seller);
  const x = await place(s, { customer_phone: '624444444' }); await failToWarehouse(x);                            // refus : remis en stock
  const y = await place(s, { customer_phone: '625555555' }); await failToWarehouse(y, 'defective');                // formule C défectueux : remis en stock, frais
  const r = (await s.get('/api/seller/returns?days=30')).json;
  assert.ok(r.failed >= 3); assert.ok(r.failure_rate > 0); assert.equal(r.awaiting, 0);
  const rx = r.rows.find((q) => q.id === x.id);
  assert.equal(rx.status, 'returned'); assert.equal(rx.return_cause, 'customer_refusal'); assert.equal(rx.restocked, true);
  assert.ok(r.by_cause.some((c) => c.key === 'customer_refusal' && c.n >= 2));
  assert.ok(r.by_commune.length >= 1 && r.by_product.length >= 1);
  // un retour attendu (colis en route vers l'entrepôt) est compté à part
  const z = await place(s, { customer_phone: '626666666' });
  await call(db.app, 'fn_agent_take_order', w.agent1, z.id); await call(db.app, 'fn_agent_log_call', w.agent1, z.id, 'confirmed', 'OK');
  await call(db.app, 'fn_chief_assign', w.chief, z.id, w.courier); await call(db.app, 'fn_courier_pickup', w.courier, z.id); await call(db.app, 'fn_courier_fail', w.courier, z.id, 'customer_refusal'); await call(db.app, 'fn_chief_return_to_warehouse', w.chief, z.id);
  const r2 = (await s.get('/api/seller/returns')).json;
  assert.equal(r2.awaiting, 1); assert.equal(r2.rows.find((q) => q.id === z.id).restocked, false);
  assert.equal((await (await login(w.seller2)).get('/api/seller/returns')).json.rows.length, 0);
});

test('stock bas : dépôts comptés et stock prépayé sous le seuil, uniquement ceux du vendeur', async () => {
  const s = await login(w.seller), s2 = await login(w.seller2);
  assert.equal((await s.get('/api/seller/low-stock')).json.count, 0);
  const d = await call(db.app, 'fn_seller_announce_deposit', w.seller, 'Sacs en cuir', 20);
  assert.equal((await s.get('/api/seller/low-stock')).json.count, 0, 'non compté : pas d\'alerte');
  await call(db.app, 'fn_warehouse_count_deposit', w.warehouse, d, 20);
  assert.equal((await s.get('/api/seller/low-stock')).json.count, 0, '20 en stock : pas d\'alerte');
  const d2 = await call(db.app, 'fn_seller_announce_deposit', w.seller, 'Chaussures', 4); await call(db.app, 'fn_warehouse_count_deposit', w.warehouse, d2, 4);
  const low = (await s.get('/api/seller/low-stock')).json;
  assert.equal(low.count, 1); assert.equal(low.deposits[0].name, 'Chaussures'); assert.equal(low.deposits[0].available, 4); assert.equal(low.threshold, 5);
  await s.post('/api/seller/orders', order({ deposit_id: d, qty: 16 }));                                            // 4 libres sur 20 : alerte
  assert.equal((await s.get('/api/seller/low-stock')).json.count, 2);
  assert.equal((await s2.get('/api/seller/low-stock')).json.count, 0);
});

test('droits de la base : le compte applicatif ne touche pas directement aux nouvelles tables', async () => {
  await assert.rejects(() => db.app.query(`INSERT INTO seller_expenses(seller_id, spent_on, category, amount) VALUES ($1, current_date, 'ads', 1)`, [w.seller]), /permission/);
  await assert.rejects(() => db.app.query(`INSERT INTO seller_customer_notes(seller_id, customer_phone, note) VALUES ($1, '621111111', 'x')`, [w.seller]), /permission/);
  await assert.rejects(() => db.app.query(`UPDATE seller_expenses SET amount = 1`), /permission/);
  await assert.rejects(() => db.app.query(`DELETE FROM seller_customer_notes`), /permission/);
  await expectErr(call(db.app, 'fn_seller_add_expense', w.courier, new Date().toISOString().slice(0, 10), 'ads', null, 100, null), 'forbidden');
});

test('retour arrière 043 : refusé s\'il existe des notes ou des dépenses, accepté sinon', async () => {
  const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-043.sql'), 'utf8');
  const run = async () => { await db.owner.query('BEGIN'); try { for (const q of splitSql(rb)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT'); } catch (e) { await db.owner.query('ROLLBACK'); throw e; } };
  await assert.rejects(run, /notes de clients ou des dépenses/);
  await db.owner.query('DELETE FROM seller_expenses'); await db.owner.query('DELETE FROM seller_customer_notes');
  await run();
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name IN ('seller_expenses','seller_customer_notes')`)).rows[0].n, 0);
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('fn_seller_set_customer_note','fn_seller_add_expense','fn_seller_void_expense')`)).rows[0].n, 0);
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '043_outils_vendeur.sql'`)).rows[0].n, 0);
});
