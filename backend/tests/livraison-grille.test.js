// Migration 068 : grille tarifaire de la livraison à la demande (départ, groupes d'arrivée, léger / lourd), droits, retour arrière.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { splitSql } from '../src/migrate.js';
import { freshDb, world, call, expectErr } from './helpers.js';

let db, w;
const root = path.resolve(import.meta.dirname, '..', '..');
const GRID = [
  { places: ['Concasseur', 'Ratoma', 'Taouyah', 'Minière', 'Hamdalaye'], light: 10000, heavy: 15000 },
  { places: ['Kaporo', 'Gbessia', 'Kenien', 'Aéroport'], light: 20000, heavy: 30000 },
  { places: ['Coyah', 'Dubréka'], light: 60000, heavy: 90000 }
];
before(async () => { db = await freshDb('wld_dlv'); w = await world(db); });
after(async () => { await db.owner.end(); await db.app.end(); });

test('seul l\'admin gère la grille ; fermé par défaut', async () => {
  await expectErr(call(db.app, 'fn_admin_dlv_import', w.seller, 'Taouyah', JSON.stringify(GRID)), 'forbidden');
  await expectErr(call(db.app, 'fn_admin_dlv_list', w.courier), 'forbidden');
  assert.equal((await call(db.app, 'fn_admin_dlv_list', w.admin)).enabled, false);
  await expectErr(call(db.app, 'fn_dlv_quote', w.seller, 'Taouyah', 'Ratoma', 3), 'forbidden');
});

test('import de la grille de Taouyah puis prix léger / lourd, accents et majuscules ignorés', async () => {
  assert.equal(await call(db.app, 'fn_admin_dlv_import', w.admin, 'Taouyah', JSON.stringify(GRID)), 3);
  const q = (to, kg) => call(db.app, 'fn_dlv_quote', w.admin, 'taouyah', to, kg);
  assert.deepEqual(await q('RATOMA', 2).then((r) => [r.weight_class, r.price]), ['light', 10000]);
  assert.deepEqual(await q('ratoma', 10).then((r) => [r.weight_class, r.price]), ['heavy', 15000]);
  assert.deepEqual(await q('aeroport', 5).then((r) => r.price), 20000);
  assert.deepEqual(await q('dubreka', 50).then((r) => r.price), 90000);
  await expectErr(q('Labé', 3), 'not_found');
  await expectErr(q('Ratoma', 0), 'invalid_input');
});

test('seuil lourd réglable ; fonction ouverte : un utilisateur actif peut demander un prix', async () => {
  await db.owner.query("UPDATE settings SET value = 20 WHERE key = 'delivery_heavy_kg'");
  assert.equal((await call(db.app, 'fn_dlv_quote', w.admin, 'Taouyah', 'Ratoma', 15)).weight_class, 'light');
  await db.owner.query("UPDATE settings SET value = 1 WHERE key = 'feature_livraison_demande'");
  assert.equal((await call(db.app, 'fn_dlv_quote', w.seller, 'Taouyah', 'Kaporo', 25)).price, 30000);
});

test('contrôles : lourd < léger refusé, quartier en double refusé, désactivation sans suppression', async () => {
  await expectErr(call(db.app, 'fn_admin_dlv_tariff_save', w.admin, null, 'Taouyah', ['Matam'], 20000, 10000, true), 'invalid_input');
  await expectErr(call(db.app, 'fn_admin_dlv_tariff_save', w.admin, null, 'Taouyah', ['Ratoma'], 1, 2, true), 'duplicate');
  const list = await call(db.app, 'fn_admin_dlv_list', w.admin);
  const t = list.tariffs.find((x) => x.places.includes('Coyah'));
  await call(db.app, 'fn_admin_dlv_tariff_save', w.admin, t.id, 'Taouyah', t.places, t.light, t.heavy, false);
  await expectErr(call(db.app, 'fn_dlv_quote', w.admin, 'Taouyah', 'Coyah', 3), 'not_found');
  assert.equal((await db.owner.query('SELECT count(*)::int AS n FROM dlv_tariffs')).rows[0].n, 3);
  await call(db.app, 'fn_admin_dlv_import', w.admin, 'Taouyah', JSON.stringify([GRID[0]]));
  assert.equal((await db.owner.query('SELECT count(*)::int AS n FROM dlv_tariffs')).rows[0].n, 4);   // anciens groupes désactivés, pas supprimés
  assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM audit_log WHERE action IN ('dlv_tariff_saved','dlv_grid_imported')")).rows[0].n > 0, true);
});

test('retour arrière 068 : refusé si la fonction est allumée, accepté sinon', async () => {
  const rb = ['074', '073', '072', '071', '070', '068'].map((n) => fs.readFileSync(path.join(root, 'docs', `retour-arriere-${n}.sql`), 'utf8')).join('\n');   // la 070 dépend de la grille
  const run = async () => { await db.owner.query('BEGIN'); try { for (const q of splitSql(rb)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT'); } catch (e) { await db.owner.query('ROLLBACK'); throw e; } };
  await assert.rejects(run, /Éteignez d'abord/);
  await db.owner.query("UPDATE settings SET value = 0 WHERE key = 'feature_livraison_demande'");
  await run();
  assert.equal((await db.owner.query("SELECT to_regclass('dlv_tariffs') AS t")).rows[0].t, null);
});
