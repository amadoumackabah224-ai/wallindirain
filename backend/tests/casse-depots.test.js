// 040 : casse ou perte sur un dépôt de vendeur.
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
  db = await freshDb('wld_casse'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  product = await approvedProduct(db, w, { price: 60000, qty: 5 });
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_casse', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });

test('casse sur un dépôt : seules les unités libres, vendeur prévenu, historique visible, aucun argent', async () => {
  const id = await dep(10); await call(db.app, 'fn_warehouse_count_deposit', w.warehouse, id, 10);
  const s = await login(w.seller);
  const r = await s.post('/api/seller/orders', order({ deposit_id: id, qty: 4 }));
  assert.equal(r.status, 201);                                               // 4 réservées, 6 libres
  const wallet = async () => (await db.owner.query('SELECT count(*)::int AS n, COALESCE(sum(amount),0)::text AS t FROM wallet_entries')).rows[0];
  const w0 = await wallet();
  await expectErr(call(db.app, 'fn_warehouse_declare_deposit_loss', w.seller, id, 1, 'lost', 'Introuvable'), 'forbidden');
  await expectErr(call(db.app, 'fn_warehouse_declare_deposit_loss', w.warehouse, id, 7, 'lost', 'Trop'), 'invalid_input');           // 7 > 6 libres
  await expectErr(call(db.app, 'fn_warehouse_declare_deposit_loss', w.warehouse, id, 1, 'lost', 'x'), 'invalid_input');             // explication trop courte
  const wh = await login(w.warehouse);
  assert.equal((await wh.post(`/api/warehouse/deposits/${id}/loss`, { qty: 2, reason: 'damaged', note: 'Sacs mouillés' })).status, 201);
  const d = await row(id);
  assert.equal(d.qty, 8); assert.equal(d.reserved_qty, 4);
  assert.deepEqual(await wallet(), w0);                                      // aucune écriture d'argent
  const mine = (await s.get('/api/seller/deposits')).json.deposits.find((x) => x.id === id);
  assert.equal(mine.losses.length, 1); assert.equal(mine.losses[0].qty, 2);
  assert.ok((await wh.get('/api/warehouse/stock')).json.deposits.some((x) => x.id === id));
  const notif = (await db.owner.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND title = 'Stock retiré à l''entrepôt'`, [w.seller])).rows[0].n;
  assert.equal(notif, 1);
  await assert.rejects(() => db.owner.query('UPDATE seller_deposit_losses SET qty = 1'));                                          // historique non modifiable
  // dépôt non compté : refusé
  const nc = await dep(3); await expectErr(call(db.app, 'fn_warehouse_declare_deposit_loss', w.warehouse, nc, 1, 'lost', 'Perdu'), 'invalid_state');
});

test('retour arrière 040 : refusé s\'il existe une casse, accepté sinon', async () => {
  const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-040.sql'), 'utf8');
  const run = async () => { await db.owner.query('BEGIN'); try { for (const q of splitSql(rb)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT'); } catch (e) { await db.owner.query('ROLLBACK'); throw e; } };
  await assert.rejects(run, /casses sur dépôts/);
  await db.owner.query('ALTER TABLE seller_deposit_losses DISABLE TRIGGER seller_deposit_losses_immutable'); await db.owner.query('DELETE FROM seller_deposit_losses');
  await run();
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'seller_deposit_losses'`)).rows[0].n, 0);
});
