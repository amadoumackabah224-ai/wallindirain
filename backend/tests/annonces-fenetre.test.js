// Migration 074 : annonces en fenêtre (image, texte, bouton, public, dates, fréquence, statistiques), éteintes par défaut.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { splitSql } from '../src/migrate.js';
import { freshDb, world, call, expectErr } from './helpers.js';

const root = path.resolve(import.meta.dirname, '..', '..');
const run = async (file) => { const rb = fs.readFileSync(path.join(root, 'docs', file), 'utf8'); await db.owner.query('BEGIN'); try { for (const q of splitSql(rb)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT'); } catch (e) { await db.owner.query('ROLLBACK'); throw e; } };
let db, w;
before(async () => { db = await freshDb('wld_popups'); w = await world(db); });
after(async () => { await db.owner.end(); await db.app.end(); });

const save = (over = {}) => { const a = { title: 'Offre de novembre', body: 'Profitez-en', audience: 'all', label: null, target: null, starts: null, ends: null, freq: 'once', mime: null, img: null, ...over };
  return call(db.app, 'fn_admin_popup_save', w.admin, a.id ?? null, a.title, a.body, a.audience, a.label, a.target, a.starts, a.ends, a.freq, a.mime, a.img); };
const publish = (id, on = true) => call(db.app, 'fn_admin_popup_active', w.admin, id, on);
const next = (u) => call(db.app, 'fn_popup_next', u);
const flag = (v) => db.owner.query("UPDATE settings SET value = $1 WHERE key = 'feature_popups'", [v]);

test('éteint par défaut : même publiée, aucune fenêtre ne s\'affiche', async () => {
  const id = await save(); await publish(id);
  assert.equal(await next(w.seller), null);
  await flag(1);
  assert.equal((await next(w.seller)).title, 'Offre de novembre');
  await publish(id, false);
});

test('un brouillon ne s\'affiche pas ; publiée, seulement au bon public', async () => {
  const id = await save({ title: 'Pour les livreurs', audience: 'courier' });
  assert.equal(await next(w.courier), null);          // brouillon
  await publish(id);
  assert.equal((await next(w.courier)).title, 'Pour les livreurs');
  assert.equal(await next(w.seller), null);
  await publish(id, false);
});

test('une seule fois : après « vu », plus jamais ; chaque jour : revient le lendemain', async () => {
  const once = await save({ title: 'Une fois' }); await publish(once);
  const r = await next(w.seller); assert.equal(r.id, once);
  await call(db.app, 'fn_popup_event', w.seller, once, 'seen');
  assert.equal(await next(w.seller), null);
  assert.equal((await next(w.courier)).id, once);   // un autre utilisateur la voit encore
  await publish(once, false);
  const daily = await save({ title: 'Chaque jour', freq: 'daily' }); await publish(daily);
  await call(db.app, 'fn_popup_event', w.seller, daily, 'seen');
  assert.equal(await next(w.seller), null);
  await db.owner.query("UPDATE popup_views SET last_seen_at = now() - interval '1 day' WHERE popup_id = $1", [daily]);
  assert.equal((await next(w.seller)).id, daily);
  await publish(daily, false);
});

test('dates : pas avant le début, plus après la fin', async () => {
  const future = await save({ title: 'Bientôt', starts: new Date(Date.now() + 864e5).toISOString() }); await publish(future);
  assert.equal(await next(w.seller), null);
  const ended = await save({ title: 'Terminée', starts: new Date(Date.now() - 2 * 864e5).toISOString(), ends: new Date(Date.now() - 864e5).toISOString() }); await publish(ended);
  assert.equal(await next(w.seller), null);
  await expectErr(save({ starts: new Date().toISOString(), ends: new Date(Date.now() - 1000).toISOString() }), 'invalid_input');
  await publish(future, false); await publish(ended, false);
});

test('statistiques : vues, clics, fermetures', async () => {
  const id = await save({ title: 'Stats', label: 'Découvrir', target: 'tab:pf' }); await publish(id);
  await call(db.app, 'fn_popup_event', w.seller, id, 'seen'); await call(db.app, 'fn_popup_event', w.seller, id, 'click');
  await call(db.app, 'fn_popup_event', w.courier, id, 'seen'); await call(db.app, 'fn_popup_event', w.courier, id, 'close');
  const list = (await call(db.app, 'fn_admin_popups', w.admin)).popups.find((p) => p.id === id);
  assert.deepEqual([Number(list.views), Number(list.clicks), Number(list.closed), list.live], [2, 1, 1, true]);
  await expectErr(call(db.app, 'fn_popup_event', w.seller, id, 'hack'), 'invalid_input');
  await publish(id, false);
});

test('bouton : seulement une adresse https ou un écran de l\'application, et il faut texte + destination', async () => {
  await expectErr(save({ label: 'Cliquer', target: 'javascript:alert(1)' }), 'invalid_input');
  await expectErr(save({ label: 'Cliquer', target: 'http://exemple.com' }), 'invalid_input');
  await expectErr(save({ label: 'Cliquer', target: null }), 'invalid_input');
  await expectErr(save({ label: null, target: 'tab:pf' }), 'invalid_input');
  assert.ok(await save({ label: 'Cliquer', target: 'https://wallindirain.onrender.com/' }));
});

test('seul l\'administrateur crée et publie ; image servie, archive retire', async () => {
  await expectErr(call(db.app, 'fn_admin_popup_save', w.seller, null, 'Titre ok', null, 'all', null, null, null, null, 'once', null, null), 'forbidden');
  const jpg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
  const id = await save({ title: 'Avec image', mime: 'image/jpeg', img: jpg });
  const img = await db.app.query('SELECT * FROM fn_popup_image_get($1, $2)', [w.seller, id]);
  assert.equal(img.rows[0].mime, 'image/jpeg'); assert.ok(Buffer.from(img.rows[0].data).equals(jpg));
  await expectErr(call(db.app, 'fn_admin_popup_active', w.seller, id, true), 'forbidden');
  await publish(id); assert.equal((await next(w.seller))?.has_image, true);
  await call(db.app, 'fn_admin_popup_archive', w.admin, id);
  assert.equal((await db.app.query('SELECT * FROM fn_popup_image_get($1, $2)', [w.seller, id])).rows.length, 0);
});

test('retour arrière : refusé s\'il existe des annonces, puis possible une fois la table vide', async () => {
  await assert.rejects(run('retour-arriere-074.sql'), /refusé/);
  await db.owner.query('DELETE FROM popup_views'); await db.owner.query('DELETE FROM popups');
  await run('retour-arriere-074.sql');
  assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'fn\\_popup%' OR proname LIKE 'fn\\_admin\\_popup%'")).rows[0].n, 0);
});
