// 035 : rayons du catalogue et zones classées (communes → quartiers, villes de l'intérieur).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, call, expectErr, world } from './helpers.js';

let db, w;
before(async () => { db = await freshDb('wld_rayons'); w = await world(db); });
after(async () => { await db.app.end(); await db.owner.end(); });
const cat = (name) => db.owner.query('SELECT id FROM product_categories WHERE name=$1', [name]).then((r) => r.rows[0]?.id);

test('rayons de départ ; un produit sans rayon va dans « Autres », avec un rayon il y est rangé', async () => {
  const names = (await db.owner.query('SELECT name FROM product_categories ORDER BY position')).rows.map((r) => r.name);
  assert.deepEqual(names, ['Bébé et enfant', 'Électroménager', 'Meubles et maison', 'Mode et beauté', 'Téléphones et électronique', 'Autres']);
  const p1 = await call(db.app, 'fn_supplier_add_product', w.supplier, 'Poussette', null, 50000, 'supplier', 3);
  assert.equal((await db.owner.query('SELECT category_id FROM products WHERE id=$1', [p1])).rows[0].category_id, await cat('Autres'));
  const bebe = await cat('Bébé et enfant');
  const p2 = await call(db.app, 'fn_supplier_add_product', w.supplier, 'Biberon', null, 5000, 'supplier', 3, bebe);
  assert.equal((await db.owner.query('SELECT category_id FROM products WHERE id=$1', [p2])).rows[0].category_id, bebe);
  await expectErr(call(db.app, 'fn_supplier_add_product', w.supplier, 'X produit', null, 5000, 'supplier', 1, '00000000-0000-0000-0000-0000000000aa'), 'invalid_input');
  // le fournisseur change le rayon de son produit ; un autre fournisseur ou un vendeur ne le peut pas
  await call(db.app, 'fn_set_product_category', w.supplier, p1, await cat('Meubles et maison'));
  await expectErr(call(db.app, 'fn_set_product_category', w.seller, p1, bebe), 'forbidden');
  await call(db.app, 'fn_set_product_category', w.admin, p1, bebe);
});

test('rayons : seul l\'administrateur crée, renomme, désactive ; un rayon désactivé n\'est plus choisissable', async () => {
  await expectErr(call(db.app, 'fn_admin_set_category', w.seller, null, 'Jouets', 10, true), 'forbidden');
  const id = await call(db.app, 'fn_admin_set_category', w.admin, null, 'Jouets', 10, true);
  await expectErr(call(db.app, 'fn_admin_set_category', w.admin, null, 'Jouets', 11, true), 'invalid_input');
  await call(db.app, 'fn_admin_set_category', w.admin, id, 'Jeux et jouets', 10, false);
  await expectErr(call(db.app, 'fn_supplier_add_product', w.supplier, 'Ballon', null, 3000, 'supplier', 1, id), 'invalid_input');
});

test('zones : communes, quartiers rattachés, villes de l\'intérieur ; aucun tarif inventé', async () => {
  const z = (await db.owner.query(`SELECT commune, kind, parent, fee, active FROM delivery_rates`)).rows;
  const by = Object.fromEntries(z.map((r) => [r.commune, r]));
  assert.equal(by.Ratoma.kind, 'commune'); assert.equal(Number(by.Ratoma.fee), 30000); assert.equal(by.Ratoma.active, true);
  assert.equal(by['Kipé'].parent, 'Ratoma'); assert.equal(Number(by['Kipé'].fee), 0); assert.equal(by['Kipé'].active, false);
  assert.equal(by['Labé'].kind, 'ville'); assert.equal(Number(by['Labé'].fee), 0); assert.equal(by['Labé'].active, false);
  assert.equal(by['Autre quartier / ville'].kind, 'autre');
  // le tarif de la commune s'applique aux quartiers sans tarif, sur demande de l'administrateur seulement
  await expectErr(call(db.app, 'fn_admin_zones_use_commune_fee', w.seller, 'Ratoma'), 'forbidden');
  const n = await call(db.app, 'fn_admin_zones_use_commune_fee', w.admin, 'Ratoma');
  assert.ok(n >= 10);
  const k = (await db.owner.query(`SELECT fee, active FROM delivery_rates WHERE commune='Kipé'`)).rows[0];
  assert.equal(Number(k.fee), 30000); assert.equal(k.active, true);
  assert.equal(Number((await db.owner.query(`SELECT fee FROM delivery_rates WHERE commune='Kaloum'`)).rows[0].fee), 25000);   // les autres communes ne bougent pas
  await expectErr(call(db.app, 'fn_admin_zones_use_commune_fee', w.admin, 'Labé'), 'not_found');
});

test('classer une zone : ville avec gare voiture, quartier rattaché ; une commune qui a des quartiers ne change pas de nature', async () => {
  await call(db.app, 'fn_admin_classify_zone', w.admin, 'Labé', 'ville', null, 'Gare voiture de Labé, près du marché');
  assert.equal((await db.owner.query(`SELECT pickup_point FROM delivery_rates WHERE commune='Labé'`)).rows[0].pickup_point, 'Gare voiture de Labé, près du marché');
  await call(db.app, 'fn_admin_classify_zone', w.admin, 'Km 36', 'quartier', 'Matoto', null);
  await expectErr(call(db.app, 'fn_admin_classify_zone', w.admin, 'Km 36', 'quartier', 'Labé', null), 'invalid_input');
  await expectErr(call(db.app, 'fn_admin_classify_zone', w.admin, 'Ratoma', 'ville', null, null), 'invalid_state');
  await expectErr(call(db.app, 'fn_admin_classify_zone', w.seller, 'Km 36', 'quartier', 'Matoto', null), 'forbidden');
  // une commande dans un quartier activé garde le tarif de la zone
  assert.equal((await db.app.query('SELECT count(*)::int n FROM fn_ledger_check()')).rows[0].n, 0);
});
