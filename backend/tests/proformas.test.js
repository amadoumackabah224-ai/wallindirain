// Migration 078 : proformas. Un devis ne touche ni stock, ni argent, ni statistiques ; la transformation passe par la création de commande existante.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { splitSql } from '../src/migrate.js';
import { freshDb, world, approvedProduct, call, expectErr } from './helpers.js';

const root = path.resolve(import.meta.dirname, '..', '..');
let db, w, product, n = 0;
const phone = () => `6${String(++n + 7000).padStart(8, '0')}`;
const create = (who = w.seller, over = {}) => call(db.app, 'fn_proforma_create', who, over.product === undefined ? product : over.product, over.price ?? 120000, over.qty ?? 2, 'Société Test', over.phone ?? phone(), 'Kaloum', 'Rue 5 Kaloum', null, over.days ?? 15);
const snap = async () => (await db.owner.query(`SELECT (SELECT count(*) FROM orders)::text AS o, (SELECT count(*) FROM wallet_entries)::text AS we, (SELECT COALESCE(sum(stock_qty+reserved_qty),0) FROM products)::text AS s, (SELECT count(*) FROM courier_cash_entries)::text AS c`)).rows[0];
const run = async (file) => { const rb = fs.readFileSync(path.join(root, 'docs', file), 'utf8'); await db.owner.query('BEGIN'); try { for (const q of splitSql(rb)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT'); } catch (e) { await db.owner.query('ROLLBACK'); throw e; } };

before(async () => {
  db = await freshDb('wld_proforma'); w = await world(db);
  product = await approvedProduct(db, w, { price: 60000, qty: 50 });
  await call(db.app, 'fn_seller_set_price', w.seller, product, 120000);
  await db.owner.query('UPDATE users SET identity_verified = true WHERE id = $1', [w.seller]);
});
after(async () => { await db.owner.end(); await db.app.end(); });

test('éteint par défaut : création et transformation refusées, la liste dit que la fonction est éteinte', async () => {
  await expectErr(create(), 'feature_off');
  assert.equal((await call(db.app, 'fn_proformas_mine', w.seller)).enabled, false);
  await call(db.app, 'fn_admin_set_setting', w.admin, 'feature_proformas', 1);
  assert.equal((await call(db.app, 'fn_proformas_mine', w.seller)).enabled, true);
});

test('création : réservée au vendeur, ne touche ni stock, ni argent, ni commandes', async () => {
  const before = await snap();
  const p = await create(); assert.match(p.number, /^PF-\d{4}-\d{5}$/); assert.equal(p.status, 'open'); assert.equal(p.total, 240000);
  assert.deepEqual(await snap(), before);
  for (const who of [w.admin, w.courier, w.supplier, w.agent1]) await expectErr(create(who), 'forbidden');
  await expectErr(create(w.seller, { product: null }), 'not_found');                        // un produit du catalogue est obligatoire
  await expectErr(create(w.seller, { product: '00000000-0000-0000-0000-0000000000aa' }), 'not_found');
  await expectErr(create(w.seller, { days: 0 }), 'invalid_input'); await expectErr(create(w.seller, { days: 61 }), 'invalid_input');
  await assert.rejects(create(w.seller, { qty: 0 })); await assert.rejects(create(w.seller, { phone: 'abc' }));
});

test('chacun ses proformas : un autre vendeur ne voit, n\'annule et ne transforme rien ; l\'administration lit tout', async () => {
  const p = await create();
  const mine = await call(db.app, 'fn_proformas_mine', w.seller2); assert.equal(mine.proformas.length, 0);
  await expectErr(call(db.app, 'fn_proforma_cancel', w.seller2, p.id), 'not_found');
  await expectErr(call(db.app, 'fn_proforma_convert', w.seller2, p.id), 'not_found');
  const adm = await call(db.app, 'fn_admin_proformas', w.admin); assert.ok(adm.proformas.length >= 2); assert.ok(adm.proformas[0].seller);
  await expectErr(call(db.app, 'fn_admin_proformas', w.seller), 'forbidden');
});

test('transformation : une seule vraie commande, avec les mêmes contrôles ; rejouer ne double pas ; annuler après est refusé', async () => {
  const p = await create(w.seller, { qty: 3 });
  const r = await call(db.app, 'fn_proforma_convert', w.seller, p.id);
  assert.ok(r.id); assert.equal(r.status, 'new');
  const again = await call(db.app, 'fn_proforma_convert', w.seller, p.id); assert.equal(again.id, r.id); assert.equal(again.replayed, true);
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM orders WHERE id = $1`, [r.id])).rows[0].n, 1);
  const o = (await db.owner.query(`SELECT qty, sale_total::text AS t, seller_id FROM orders WHERE id = $1`, [r.id])).rows[0];
  assert.equal(o.qty, 3); assert.equal(o.t, '360000'); assert.equal(o.seller_id, w.seller);
  const row = (await call(db.app, 'fn_proformas_mine', w.seller)).proformas.find((x) => x.id === p.id);
  assert.equal(row.status, 'converted'); assert.equal(row.order_ref, r.ref);
  await expectErr(call(db.app, 'fn_proforma_cancel', w.seller, p.id), 'invalid_state');
  assert.equal((await db.owner.query('SELECT count(*)::int AS n FROM fn_ledger_check()')).rows[0].n, 0);
});

test('annulée ou expirée : ne peut plus être transformée', async () => {
  const p = await create(); await call(db.app, 'fn_proforma_cancel', w.seller, p.id);
  await expectErr(call(db.app, 'fn_proforma_convert', w.seller, p.id), 'invalid_state');
  await expectErr(call(db.app, 'fn_proforma_cancel', w.seller, p.id), 'invalid_state');
  const q = await create(); await db.owner.query(`UPDATE proformas SET valid_until = current_date - 1 WHERE id = $1`, [q.id]);
  assert.equal((await call(db.app, 'fn_proformas_mine', w.seller)).proformas.find((x) => x.id === q.id).status, 'expired');
  await expectErr(call(db.app, 'fn_proforma_convert', w.seller, q.id), 'expired');
});

test('la transformation refuse si le produit ou le prix ne passent plus (même garde-fous qu\'une commande)', async () => {
  const p = await create(w.seller, { price: 1000 });                       // prix sous le plancher du produit
  await assert.rejects(call(db.app, 'fn_proforma_convert', w.seller, p.id));
  assert.equal((await call(db.app, 'fn_proformas_mine', w.seller)).proformas.find((x) => x.id === p.id).status, 'open');   // reste ouverte
  await call(db.app, 'fn_admin_set_setting', w.admin, 'feature_proformas', 0);
  const q = (await call(db.app, 'fn_proformas_mine', w.seller)).proformas.find((x) => x.status === 'open');
  await expectErr(call(db.app, 'fn_proforma_convert', w.seller, q.id), 'feature_off');
  await call(db.app, 'fn_admin_set_setting', w.admin, 'feature_proformas', 1);
});

test('retour arrière 078 : refusé s\'il existe des proformas, puis propre', async () => {
  await assert.rejects(run('retour-arriere-078.sql'), /refusé/);
  await db.owner.query('UPDATE proformas SET order_id = NULL, status = \'cancelled\'');
  await db.owner.query('DELETE FROM proformas');
  await run('retour-arriere-078.sql');
  assert.equal((await db.owner.query(`SELECT to_regclass('proformas') AS t`)).rows[0].t, null);
  assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '078_proformas.sql'`)).rows[0].n, 0);
  assert.equal((await db.owner.query('SELECT count(*)::int AS n FROM fn_ledger_check()')).rows[0].n, 0);
});
