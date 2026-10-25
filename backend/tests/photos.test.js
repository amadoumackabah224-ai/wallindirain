// Étape 6 : photos des produits (migration 023) — le fournisseur publie jusqu'à 4 photos ; lecture contrôlée par rôle.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshDb, TEST_DB, APP_PW, world, approvedProduct, call, expectErr } from './helpers.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';
import { splitSql, migrate } from '../src/migrate.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PW = 'Secret123';
let db, w, product, pending, supplier2, srv, base;
const count = async (sql, p = []) => Number((await db.owner.query(sql, p)).rows[0].n);
const jpeg = (size = 3000, fill = 7) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size - 4, fill)]);
const png = (size = 3000) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(size - 8, 1)]);
const uri = (buf, mime = 'jpeg') => `data:image/${mime};base64,${buf.toString('base64')}`;
const add = (actor, prod, buf = jpeg(), mime = 'image/jpeg') => call(db.app, 'fn_supplier_add_product_image', actor, prod, mime, buf);

class Client {
  constructor() { this.cookie = ''; }
  async req(method, p, body, raw = false) {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}), ...(method !== 'GET' ? { 'x-wld': '1' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    for (const c of res.headers.getSetCookie?.() ?? []) { const kv = c.split(';')[0]; this.cookie = kv.endsWith('=') ? '' : kv; }
    if (raw) return { status: res.status, type: res.headers.get('content-type'), cache: res.headers.get('cache-control'), buf: Buffer.from(await res.arrayBuffer()) };
    let json = null; try { json = await res.json(); } catch { /* vide */ }
    return { status: res.status, json };
  }
  get(p) { return this.req('GET', p); }
  raw(p) { return this.req('GET', p, undefined, true); }
  post(p, b = {}) { return this.req('POST', p, b); }
}
const login = async (id) => { const c = new Client(); const ph = (await db.owner.query('SELECT phone FROM users WHERE id = $1', [id])).rows[0].phone; assert.equal((await c.post('/api/auth/login', { identifier: ph, password: PW })).status, 200); return c; };

before(async () => {
  db = await freshDb('wld_photos'); w = await world(db);
  supplier2 = await call(db.app, 'fn_register', '622900001', 'Fournisseur Deux', 'supplier', 'x', 'CNI-654321');
  await call(db.app, 'fn_admin_set_user_status', w.admin, supplier2, 'active');
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  product = await approvedProduct(db, w, { price: 60000, qty: 50 });
  await call(db.app, 'fn_seller_set_price', w.seller, product, 120000);
  pending = await call(db.app, 'fn_supplier_add_product', w.supplier, 'Produit en attente', 'Pas encore validé', 50000, 'wallindirain', 0);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_photos', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });

test('fournisseur : ajoute jusqu\'à 4 photos, la 5e est refusée, une place libérée est réutilisée, uniquement sur ses produits', async () => {
  const ids = []; for (let i = 0; i < 4; i++) ids.push(await add(w.supplier, product, i % 2 ? png() : jpeg(3000 + i, i), i % 2 ? 'image/png' : 'image/jpeg'));
  assert.deepEqual((await db.owner.query('SELECT position FROM product_images WHERE product_id = $1 ORDER BY position', [product])).rows.map((r) => r.position), [1, 2, 3, 4]);
  await expectErr(add(w.supplier, product), 'invalid_state');
  await call(db.app, 'fn_supplier_delete_product_image', w.supplier, ids[1]);                         // la place 2 se libère
  const again = await add(w.supplier, product);
  assert.equal((await db.owner.query('SELECT position FROM product_images WHERE id = $1', [again])).rows[0].position, 2);
  await expectErr(add(supplier2, product), 'not_found');                                                // pas son produit
  await expectErr(call(db.app, 'fn_supplier_delete_product_image', supplier2, again), 'not_found');
  for (const actor of [w.seller, w.admin, w.courier, w.chief]) await expectErr(add(actor, product), 'forbidden');
  await expectErr(add(w.supplier, '00000000-0000-0000-0000-000000000009'), 'not_found');
  await expectErr(add(w.supplier, pending, Buffer.alloc(10, 1)), 'invalid_input');                      // trop petite
  await expectErr(add(w.supplier, pending, jpeg(460000)), 'invalid_input');                             // trop lourde
  await expectErr(add(w.supplier, pending, jpeg(3000), 'image/gif'), 'invalid_input');
  for (const id of await db.owner.query('SELECT id FROM product_images WHERE product_id = $1', [product]).then((r) => r.rows.map((x) => x.id))) await call(db.app, 'fn_supplier_delete_product_image', w.supplier, id);
  assert.equal(await count('SELECT count(*)::int AS n FROM product_images WHERE product_id = $1', [product]), 0);
});

test('lecture contrôlée : administration et propriétaire toujours ; équipe et vendeurs seulement si le produit est validé ; autre fournisseur jamais', async () => {
  const okImg = await add(w.supplier, product); const pendImg = await add(w.supplier, pending);
  const read = (actor, id) => call(db.app, 'fn_product_image_get', actor, id).catch((e) => e);
  for (const actor of [w.admin, w.supplier]) { assert.ok(await db.app.query('SELECT * FROM fn_product_image_get($1, $2)', [actor, pendImg]).then((r) => r.rows.length === 1)); }
  for (const actor of [w.seller, w.agent1, w.courier, w.chief, w.warehouse]) {
    assert.equal((await db.app.query('SELECT * FROM fn_product_image_get($1, $2)', [actor, okImg])).rows.length, 1);                  // produit validé : visible
    await assert.rejects(db.app.query('SELECT * FROM fn_product_image_get($1, $2)', [actor, pendImg]), /WLD01|Action non autorisée/);   // produit non validé : non
  }
  await assert.rejects(db.app.query('SELECT * FROM fn_product_image_get($1, $2)', [supplier2, okImg]), /Action non autorisée/);         // un autre fournisseur ne voit rien
  assert.equal((await db.app.query('SELECT * FROM fn_product_image_get($1, $2)', [w.admin, '00000000-0000-0000-0000-000000000009'])).rows.length, 0);
  await read(w.seller, okImg);
  await call(db.app, 'fn_supplier_delete_product_image', w.supplier, pendImg); await call(db.app, 'fn_supplier_delete_product_image', w.supplier, okImg);
});

test('HTTP : envoi, liste, lecture par rôle, page publique du lien, suppression ; rien sur le fournisseur', async () => {
  const supplier = await login(w.supplier), seller = await login(w.seller), admin = await login(w.admin), anon = new Client(), other = await login(supplier2);
  assert.equal((await anon.post(`/api/supplier/products/${product}/images`, { image: uri(jpeg()) })).status, 401);
  assert.equal((await seller.post(`/api/supplier/products/${product}/images`, { image: uri(jpeg()) })).status, 403);
  assert.equal((await other.post(`/api/supplier/products/${product}/images`, { image: uri(jpeg()) })).status, 404);
  assert.equal((await supplier.post(`/api/supplier/products/${product}/images`, { image: 'pas une image' })).status, 400);
  assert.equal((await supplier.post(`/api/supplier/products/${product}/images`, { image: uri(Buffer.alloc(3000, 5)) })).status, 400);          // signature absente
  assert.equal((await supplier.post(`/api/supplier/products/${product}/images`, { image: uri(jpeg(500000)) })).status, 413);                  // trop lourde
  const up = await supplier.post(`/api/supplier/products/${product}/images`, { image: uri(jpeg(4000, 9)) }); assert.equal(up.status, 201); assert.ok(up.json.id);
  const up2 = await supplier.post(`/api/supplier/products/${product}/images`, { image: uri(png(5000), 'png') }); assert.equal(up2.status, 201);
  const mine = (await supplier.get('/api/supplier/products')).json.products.find((p) => p.id === product); assert.deepEqual(mine.image_ids, [up.json.id, up2.json.id]);
  const cat = (await seller.get('/api/seller/catalog')).json.products.find((p) => p.id === product); assert.deepEqual(cat.image_ids, [up.json.id, up2.json.id]);
  assert.deepEqual((await admin.get('/api/admin/products')).json.products.find((p) => p.id === product).image_ids, [up.json.id, up2.json.id]);
  const img = await seller.raw(`/api/product-images/${up.json.id}`); assert.equal(img.status, 200); assert.equal(img.type, 'image/jpeg'); assert.equal(img.buf.length, 4000); assert.match(img.cache, /private/);
  assert.equal((await seller.raw(`/api/product-images/${up2.json.id}`)).type, 'image/png');
  assert.equal((await anon.raw(`/api/product-images/${up.json.id}`)).status, 401);
  assert.equal((await other.raw(`/api/product-images/${up.json.id}`)).status, 403);
  assert.equal((await seller.raw(`/api/product-images/00000000-0000-0000-0000-000000000009`)).status, 404);
  assert.equal((await seller.raw(`/api/product-images/pas-un-id`)).status, 400);
  // page publique du lien : couverture seulement
  const code = await call(db.app, 'fn_seller_create_link', w.seller, product);
  const page = await anon.get(`/api/public/link/${code}`); assert.equal(page.json.product.has_photo, true); assert.doesNotMatch(JSON.stringify(page.json), /supplier|fournisseur/i);
  const cover = await anon.raw(`/api/public/link/${code}/photo`); assert.equal(cover.status, 200); assert.equal(cover.buf.length, 4000);
  assert.equal((await anon.raw('/api/public/link/inconnu/photo')).status, 404);
  assert.equal((await seller.post(`/api/supplier/images/${up.json.id}/delete`)).status, 403);
  assert.equal((await other.post(`/api/supplier/images/${up.json.id}/delete`)).status, 404);
  assert.equal((await supplier.post(`/api/supplier/images/${up.json.id}/delete`)).status, 200);
  assert.equal((await anon.raw(`/api/public/link/${code}/photo`)).buf.length, 5000);                              // la photo suivante devient la couverture
  assert.equal((await supplier.post(`/api/supplier/images/${up2.json.id}/delete`)).status, 200);
  assert.equal((await anon.get(`/api/public/link/${code}`)).json.product.has_photo, false);
  assert.equal((await anon.raw(`/api/public/link/${code}/photo`)).status, 404);
});

test('aucun effet sur l\'argent ni sur la validation ; octets illisibles hors fonctions ; droits SQL corrects', async () => {
  assert.equal(await count('SELECT count(*)::int AS n FROM fn_ledger_check()'), 0);
  assert.equal((await db.owner.query('SELECT status FROM products WHERE id = $1', [pending])).rows[0].status, 'pending');               // une photo ne valide rien
  await assert.rejects(db.app.query('SELECT data FROM product_images'), /permission denied/);
  await db.app.query('SELECT id, product_id, position, mime FROM product_images');
  for (const priv of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) assert.equal((await db.owner.query(`SELECT has_table_privilege('wld_app', 'product_images', $1) AS p`, [priv])).rows[0].p, false);
  for (const f of ['fn_supplier_add_product_image', 'fn_supplier_delete_product_image', 'fn_product_image_get', 'fn_public_product_photo']) {
    const r = (await db.owner.query(`SELECT prosecdef, proconfig::text AS c, has_function_privilege('wld_app', oid, 'EXECUTE') AS e FROM pg_proc WHERE proname = $1`, [f])).rows[0];
    assert.equal(r.prosecdef, true); assert.match(r.c, /search_path=public, pg_temp/); assert.equal(r.e, true);
  }
});

test('retour arrière 023 : retire la table et les fonctions, rien d\'autre ; migration rejouable', async () => {
  await add(w.supplier, product);
  const snap = async () => (await db.owner.query(`SELECT (SELECT count(*) FROM wallet_entries)::text AS ecr, (SELECT count(*) FROM orders)::text AS cmd, (SELECT count(*) FROM products)::text AS prod,
     (SELECT md5(string_agg(key || value::text, ',' ORDER BY key)) FROM settings) AS s,
     (SELECT string_agg(p.proname || ':' || md5(pg_get_functiondef(p.oid)) || ':' || COALESCE(p.proacl::text, ''), E'\\n' ORDER BY p.proname, p.oid::text) FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND p.proname NOT IN ('fn_supplier_add_product_image','fn_supplier_delete_product_image','fn_product_image_get','fn_public_product_photo')) AS fonctions`)).rows[0];
  const before = await snap();
  const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-023.sql'), 'utf8');
  await db.owner.query('BEGIN');
  for (const s of splitSql(rb)) { if (/^(begin|commit)$/i.test(s.trim())) continue; await db.owner.query(s); }
  await db.owner.query('COMMIT');
  assert.deepEqual(await snap(), before);
  assert.equal(await count(`SELECT (SELECT count(*) FROM pg_class WHERE relname = 'product_images') + (SELECT count(*) FROM schema_migrations WHERE name = '023_photos_produits.sql') AS n`), 0);
  await migrate({ ...TEST_DB, database: 'wld_photos' }, APP_PW, () => {});
  assert.equal(await count(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '023_photos_produits.sql'`), 1);
  await assert.rejects(db.app.query('SELECT data FROM product_images'), /permission denied/);
});
