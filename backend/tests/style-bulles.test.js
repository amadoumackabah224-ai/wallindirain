// Style « bulles » : réglage éteint par défaut, activable par l'admin seul, exposé à l'interface, sans effet sur les données.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, world, call, expectErr } from './helpers.js';

let db, w;
before(async () => { db = await freshDb('wld_bulles'); w = await world(db); });
after(async () => { await db.owner.end(); await db.app.end(); });
const val = async () => (await db.owner.query(`SELECT value FROM settings WHERE key = 'feature_style_bulles'`)).rows[0]?.value;

test('éteint par défaut', async () => { assert.equal(Number(await val()), 0); });
test('seul l\'admin peut l\'allumer', async () => {
  await expectErr(call(db.app, 'fn_admin_set_setting', w.seller, 'feature_style_bulles', 1), 'forbidden');
  await call(db.app, 'fn_admin_set_setting', w.admin, 'feature_style_bulles', 1);
  assert.equal(Number(await val()), 1);
});
