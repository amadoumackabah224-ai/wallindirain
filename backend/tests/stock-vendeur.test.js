// 039 : stock du vendeur gardé à l'entrepôt (dépôts).
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
const dep = async (qty = 10, name = 'Sacs en cuir') => { const id = await call(db.app, 'fn_seller_announce_deposit', w.seller, name, qty); return id; };
const row = async (id) => (await db.owner.query('SELECT * FROM seller_deposits WHERE id = $1', [id])).rows[0];
const gain = async (orderId) => Number((await db.owner.query(`SELECT COALESCE(sum(amount),0) AS g FROM wallet_entries WHERE order_id = $1 AND user_id = $2 AND kind = 'seller_gain'`, [orderId, w.seller])).rows[0].g);

before(async () => {
  db = await freshDb('wld_depot'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  product = await approvedProduct(db, w, { price: 60000, qty: 5 });
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_depot', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });

test('annonce, comptage avec écart expliqué, quantités disponibles', async () => {
  assert.equal(Number((await db.owner.query(`SELECT value FROM settings WHERE key = 'seller_storage_fee'`)).rows[0].value), 0);
  const id = await dep(10);
  await expectErr(call(db.app, 'fn_warehouse_count_deposit', w.seller, id, 10), 'forbidden');                 // seul le magasinier compte
  await expectErr(call(db.app, 'fn_warehouse_count_deposit', w.warehouse, id, 8), 'invalid_input');          // écart sans explication
  await call(db.app, 'fn_warehouse_count_deposit', w.warehouse, id, 8, 'Deux sacs abîmés');
  const d = await row(id);
  assert.equal(d.qty, 8); assert.equal(d.reserved_qty, 0); assert.equal(d.status, 'stored');
  await expectErr(call(db.app, 'fn_warehouse_count_deposit', w.warehouse, id, 8, 'Encore'), 'invalid_state');  // un seul comptage
  await expectErr(call(db.app, 'fn_seller_announce_deposit', w.warehouse, 'X', 1), 'forbidden');
});

test('commande sortie du dépôt : réservation, remise au livreur, sortie à la livraison, gains identiques à un produit propre ordinaire', async () => {
  const id = await dep(10); await call(db.app, 'fn_warehouse_count_deposit', w.warehouse, id, 10);
  const s = await login(w.seller);
  const r = await s.post('/api/seller/orders', order({ deposit_id: id }));
  assert.equal(r.status, 201);
  assert.equal((await row(id)).reserved_qty, 2);
  const o = (await db.owner.query('SELECT * FROM orders WHERE id = $1', [r.json.id])).rows[0];
  assert.equal(o.deposit_id, id); assert.equal(o.pickup_detail, 'Entrepôt Wallindirain');
  const list = (await s.get('/api/seller/orders')).json.orders.find((x) => x.id === r.json.id);
  assert.equal(list.pickup_place, 'warehouse');
  // parcours jusqu'à l'affectation, puis remise par le magasinier
  await call(db.app, 'fn_agent_take_order', w.agent1, o.id);
  await call(db.app, 'fn_agent_log_call', w.agent1, o.id, 'confirmed', 'OK');
  await call(db.app, 'fn_chief_assign', w.chief, o.id, w.courier);
  const wh = await login(w.warehouse);
  assert.equal((await wh.get('/api/warehouse/arrivals')).json.handovers.find((x) => x.id === o.id).product_name, 'Sacs en cuir');
  assert.equal((await wh.post(`/api/warehouse/handovers/${o.id}`)).status, 200);
  await call(db.app, 'fn_courier_pickup', w.courier, o.id);
  await call(db.app, 'fn_courier_depart', w.courier, o.id);
  const codeRow = (await db.owner.query('SELECT 1')).rows; void codeRow;
  const { codeOf } = await import('./helpers.js');
  await call(db.app, 'fn_courier_deliver', w.courier, o.id, await codeOf(db, o.ref));
  const d = await row(id);
  assert.equal(d.qty, 8); assert.equal(d.reserved_qty, 0);
  // même commande en produit propre ordinaire : mêmes gains pour le vendeur
  const plain = await s.post('/api/seller/orders', order({ customer_phone: '621999001' }));
  assert.equal(plain.status, 201);
  await deliver(db, w, plain.json.id, plain.json.ref);
  assert.equal(await gain(o.id), await gain(plain.json.id));
  assert.ok(await gain(o.id) > 0);
  assert.equal((await db.owner.query('SELECT count(*)::int AS n FROM fn_ledger_check()')).rows[0].n, 0);
});

test('stock insuffisant, dépôt non compté, dépôt d\'un autre vendeur : refus sans créer de commande ; annulation libère la réservation', async () => {
  const s = await login(w.seller);
  const before = (await db.owner.query('SELECT count(*)::int AS n FROM orders')).rows[0].n;
  const nonCompte = await dep(5);
  assert.equal((await s.post('/api/seller/orders', order({ deposit_id: nonCompte, customer_phone: '621999002' }))).status, 409);
  await call(db.app, 'fn_warehouse_count_deposit', w.warehouse, nonCompte, 5);
  assert.equal((await s.post('/api/seller/orders', order({ deposit_id: nonCompte, qty: 6, customer_phone: '621999003' }))).status, 409);
  assert.equal((await s.post('/api/seller/orders', order({ deposit_id: '00000000-0000-4000-8000-000000000000', customer_phone: '621999004' }))).status, 404);
  assert.equal((await db.owner.query('SELECT count(*)::int AS n FROM orders')).rows[0].n, before);
  const ok = await s.post('/api/seller/orders', order({ deposit_id: nonCompte, qty: 3, customer_phone: '621999005' }));
  assert.equal(ok.status, 201); assert.equal((await row(nonCompte)).reserved_qty, 3);
  await call(db.app, 'fn_staff_cancel_order', w.chief, ok.json.id, 'Client injoignable');
  assert.equal((await row(nonCompte)).reserved_qty, 0);
  assert.equal((await row(nonCompte)).qty, 5);
  // un autre vendeur ne peut pas utiliser ce dépôt
  await expectErr(call(db.app, 'fn_seller_attach_deposit', w.agent1, ok.json.id, nonCompte), 'forbidden');
});

test('retour arrière : refusé si des dépôts existent, accepté sinon', async () => {
  const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-040.sql'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'docs', 'retour-arriere-039.sql'), 'utf8');   // la 040 dépend de la 039
  const run = async () => { await db.owner.query('BEGIN'); try { for (const q of splitSql(rb)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT'); } catch (e) { await db.owner.query('ROLLBACK'); throw e; } };
  await assert.rejects(run, /dépôts de vendeur existent/);
  await db.owner.query('UPDATE orders SET deposit_id = NULL'); await db.owner.query('DELETE FROM seller_deposits');
  await run();
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'seller_deposits'`)).rows[0].n, 0);
});
