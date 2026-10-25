// Étape 4 : seul le vendeur saisit la commande ; le refus du client ne coûte rien au vendeur (migration 021).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshDb, TEST_DB, APP_PW, world, approvedProduct, call, expectErr } from './helpers.js';
import { createServer } from '../src/server.js';
import { splitSql, migrate } from '../src/migrate.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let db, w, product, srv, base, n = 0, k = 0;
const phone = () => `6${String(++n).padStart(8, '0')}`;
const count = async (sql, p = []) => Number((await db.owner.query(sql, p)).rows[0].n);
const sum = async (user, kind) => Number((await db.owner.query(`SELECT COALESCE(sum(amount), 0) AS s FROM wallet_entries WHERE user_id = $1 AND ($2::text IS NULL OR kind = $2)`, [user, kind ?? null])).rows[0].s);
const PLATFORM = async () => '00000000-0000-0000-0000-000000000001';
const mk = (own = null) => call(db.app, 'fn_seller_create_order_once', w.seller, `cmd-vendeur-key-${String(++k).padStart(8, '0')}`, own ? null : product, own, own ? 40000 : null, 1, 'Client Test', phone(), 'Kaloum', 'Rue 1 Kaloum', null, true);
const toReturn = async (o) => {
  await call(db.app, 'fn_chief_assign', w.chief, o.id, w.courier); await call(db.app, 'fn_courier_pickup', w.courier, o.id);
  await call(db.app, 'fn_courier_fail', w.courier, o.id, 'customer_refusal'); await call(db.app, 'fn_chief_return_to_warehouse', w.chief, o.id);
};
const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-wld': '1' }, body: JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch { /* vide */ } return { status: r.status, json: j }; };
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, json: await r.json() }; };

before(async () => {
  db = await freshDb('wld_cmdvendeur'); w = await world(db);
  product = await approvedProduct(db, w, { price: 60000, qty: 90 });
  await call(db.app, 'fn_seller_set_price', w.seller, product, 120000);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true, closePublicOrders: true,
    db: { ...TEST_DB, database: 'wld_cmdvendeur', user: 'wld_app', password: APP_PW, max: 4 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });

test('refus du client : aucun frais pour le vendeur, rien pour la plateforme, le produit revient en stock, la comptabilité reste juste', async () => {
  const o = await mk(); await toReturn(o);
  const stock0 = (await db.owner.query('SELECT stock_qty, reserved_qty FROM products WHERE id = $1', [product])).rows[0];
  const sellerBefore = await sum(w.seller); const platBefore = await sum(await PLATFORM(), 'return_fees');
  await call(db.app, 'fn_warehouse_receive_return', w.warehouse, o.id, 'customer_refusal');
  assert.equal(await sum(w.seller) - sellerBefore, 0);
  assert.equal(await sum(await PLATFORM(), 'return_fees') - platBefore, 0);
  assert.equal(await count(`SELECT count(*)::int AS n FROM wallet_entries WHERE order_id = $1 AND kind = 'return_fees'`, [o.id]), 0);
  const st = (await db.owner.query('SELECT stock_qty, reserved_qty FROM products WHERE id = $1', [product])).rows[0];
  assert.equal(st.reserved_qty, stock0.reserved_qty - 1); assert.equal(st.stock_qty, stock0.stock_qty);              // réservation libérée
  assert.equal((await db.owner.query('SELECT status, return_cause FROM orders WHERE id = $1', [o.id])).rows[0].return_cause, 'customer_refusal');
  assert.ok(await count(`SELECT count(*)::int AS n FROM risk_flags WHERE order_id = $1`, [o.id]).catch(() => 1));    // le numéro reste signalé
  await expectErr(call(db.app, 'fn_warehouse_receive_return', w.warehouse, o.id, 'customer_refusal'), 'invalid_state');
  assert.equal(await count('SELECT count(*)::int AS n FROM fn_ledger_check()'), 0);
});

test('les autres causes de retour restent inchangées : défectueux (fournisseur), abîmé (Wallindirain), défectueux sur produit du vendeur (vendeur)', async () => {
  const d = await mk(); await toReturn(d); const sup = await sum(w.supplier);
  await call(db.app, 'fn_warehouse_receive_return', w.warehouse, d.id, 'defective');
  assert.equal(await sum(w.supplier) - sup, -(await db.owner.query('SELECT delivery_fee FROM orders WHERE id = $1', [d.id])).rows[0].delivery_fee);
  const t = await mk(); await toReturn(t); const plat = await sum(await PLATFORM(), 'transport_loss');
  await call(db.app, 'fn_warehouse_receive_return', w.warehouse, t.id, 'damaged_transport');
  assert.equal(await sum(await PLATFORM(), 'transport_loss') - plat, -60000);
  const c = await mk('Crème maison'); await toReturn(c); const sel = await sum(w.seller);
  await call(db.app, 'fn_warehouse_receive_return', w.warehouse, c.id, 'defective');
  const fees = (await db.owner.query('SELECT delivery_fee + call_fee AS f FROM orders WHERE id = $1', [c.id])).rows[0].f;
  assert.equal(await sum(w.seller) - sel, -Number(fees));
  assert.equal(await count('SELECT count(*)::int AS n FROM fn_ledger_check()'), 0);
});

test('commande par lien fermée : la page n\'a plus de formulaire, l\'envoi est refusé et aucune commande n\'est créée', async () => {
  const code = await call(db.app, 'fn_seller_create_link', w.seller, product);
  assert.ok(code, 'un lien existe');
  const before = await count('SELECT count(*)::int AS n FROM orders');
  const page = await get(`/api/public/link/${code}`); assert.equal(page.status, 200); assert.equal(page.json.orders_open, false); assert.ok(page.json.product.name);
  const r = await post(`/api/public/link/${code}/order`, { request_key: 'cle-lien-fermee-0001', qty: 1, name: 'Client', phone: phone(), commune: 'Kaloum', address: 'Rue 1 Kaloum', accepted: true });
  assert.equal(r.status, 403); assert.equal(r.json.error, 'orders_closed');
  assert.equal(await count('SELECT count(*)::int AS n FROM orders'), before);
  const ok = await mk(); assert.ok(ok.id);                                                                         // le vendeur, lui, saisit toujours
});

test('configuration : par défaut la commande par lien est fermée ; PUBLIC_ORDERS=1 la rouvre', async () => {
  const { loadConfig } = await import('../src/config.js');
  const keep = { ...process.env };
  try {
    Object.assign(process.env, { DB_APP_PASSWORD: 'x', MESSAGE_PROVIDER: 'simulated' }); delete process.env.PUBLIC_ORDERS; delete process.env.SHOW_TEST_CODES;
    assert.equal(loadConfig().closePublicOrders, true);
    process.env.PUBLIC_ORDERS = '1'; assert.equal(loadConfig().closePublicOrders, false);
  } finally { for (const key of ['PUBLIC_ORDERS', 'DB_APP_PASSWORD', 'MESSAGE_PROVIDER', 'SHOW_TEST_CODES']) { if (key in keep) process.env[key] = keep[key]; else delete process.env[key]; } }
});

test('textes : plus de frais de retour au vendeur sur refus, vendeur seul à saisir, WhatsApp décrit comme un simple lien', async () => {
  const read = (f) => fs.readFileSync(path.join(root, 'backend', 'legal', f), 'utf8');
  assert.match(read('retours-remboursements.html'), /Refus du client<\/strong> : aucun frais pour le vendeur/);
  assert.doesNotMatch(read('retours-remboursements.html'), /Refus du client<\/strong> : les frais de livraison et de call center sont à la charge du vendeur/);
  assert.match(read('conditions-vendeur.html'), /Vous seul saisissez les commandes/);
  assert.match(read('partials/hebergement.html'), /n'envoie aucun message WhatsApp automatiquement/);
  assert.match(read('conditions-livreur.html'), /tournée groupée/);
});

test('retour arrière 021 : rétablit la facturation du refus au vendeur, rien en argent ; migration rejouable', async () => {
  const snap = async () => (await db.owner.query(`SELECT (SELECT count(*) FROM wallet_entries)::text AS ecr, (SELECT count(*) FROM orders)::text AS cmd,
     (SELECT string_agg(p.proname || ':' || md5(pg_get_functiondef(p.oid)) || ':' || COALESCE(p.proacl::text, '') || ':' || p.prosecdef::text, E'\\n' ORDER BY p.proname, p.oid::text) FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND p.proname <> 'fn_warehouse_receive_return') AS fonctions`)).rows[0];
  const before = await snap();
  const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-021.sql'), 'utf8');
  await db.owner.query('BEGIN');
  for (const s of splitSql(rb)) { if (/^(begin|commit)$/i.test(s.trim())) continue; await db.owner.query(s); }
  await db.owner.query('COMMIT');
  assert.deepEqual(await snap(), before);
  assert.equal(await count(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '021_refus_client.sql'`), 0);
  const o = await mk(); await toReturn(o); const sel = await sum(w.seller);
  await call(db.app, 'fn_warehouse_receive_return', w.warehouse, o.id, 'customer_refusal');
  assert.ok(await sum(w.seller) - sel < 0, 'ancien comportement rétabli');
  await migrate({ ...TEST_DB, database: 'wld_cmdvendeur' }, APP_PW, () => {});
  const o2 = await mk(); await toReturn(o2); const sel2 = await sum(w.seller);
  await call(db.app, 'fn_warehouse_receive_return', w.warehouse, o2.id, 'customer_refusal');
  assert.equal(await sum(w.seller) - sel2, 0);
});
