// Migration 065 : comptabilité de la société. Lecture seule, administrateur seulement, aucune donnée personnelle, totaux cohérents.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { splitSql } from '../src/migrate.js';
import { freshDb, world, approvedProduct, call, expectErr, deliver } from './helpers.js';

let db, w, product, n = 0;
const root = path.resolve(import.meta.dirname, '..', '..');
const ph = () => `65${String(++n + 8000000).padStart(7, '0')}`;
const iso = (d) => d.toISOString().slice(0, 10);
const today = () => iso(new Date());
const ago = (k) => iso(new Date(Date.now() - k * 86400_000));

before(async () => { db = await freshDb('wld_compta'); w = await world(db); product = await approvedProduct(db, w, { price: 60000, qty: 60 }); await call(db.app, 'fn_seller_set_price', w.seller, product, 120000); });
after(async () => { await db.owner.end(); await db.app.end(); });

test('réservé à l\'administrateur, période valide', async () => {
  await expectErr(call(db.app, 'fn_admin_accounting', w.seller, ago(30), today(), null), 'forbidden');
  await expectErr(call(db.app, 'fn_admin_accounting', w.admin, today(), ago(3), null), 'invalid_input');
  await expectErr(call(db.app, 'fn_admin_accounting', w.admin, ago(400), today(), null), 'invalid_input');
});

test('produits automatiques en totaux, aucune donnée personnelle, cohérent avec le portefeuille de la plateforme', async () => {
  const o = await call(db.app, 'fn_seller_create_order', w.seller, product, null, null, 1, 'Cliente Secrète', ph(), 'Kaloum', 'Rue 7 Secrète', null, false);
  await deliver(db, w, o.id, o.ref);
  const a = await call(db.app, 'fn_admin_accounting', w.admin, ago(1), today(), null);
  const gross = Number((await db.owner.query(`SELECT COALESCE(sum(amount),0)::text AS s FROM wallet_entries WHERE kind = 'platform_revenue'`)).rows[0].s);
  assert.ok(gross > 0);
  const live = a.automatic.filter((x) => x.side === 'revenue' && x.label.startsWith('Livraisons'));
  assert.equal(live.reduce((s, x) => s + Number(x.amount), 0), gross);
  assert.equal(a.result, a.revenue - a.charges);
  const txt = JSON.stringify(a);
  for (const bad of ['Cliente Secrète', 'Rue 7 Secrète', o.ref]) assert.ok(!txt.includes(bad), `ne doit pas contenir ${bad}`);
  assert.equal(a.treasury.platform_wallet, Number((await db.owner.query(`SELECT COALESCE(sum(amount),0)::text AS s FROM wallet_entries WHERE user_id = '00000000-0000-0000-0000-000000000001'`)).rows[0].s));
});

test('écritures de l\'administrateur : comptes choisis, annulées exclues, prêts exclus, trésorerie', async () => {
  const acc = (await db.owner.query(`INSERT INTO pf_accounts(owner_id, name, kind, opening_balance) VALUES ($1,'Caisse société','cash',100000) RETURNING id`, [w.admin])).rows[0].id;
  const other = (await db.owner.query(`INSERT INTO pf_accounts(owner_id, name, kind, opening_balance) VALUES ($1,'Compte perso','cash',5000) RETURNING id`, [w.admin])).rows[0].id;
  const ins = (account, kind, amount, cat, note, voided = false) => db.owner.query(
    `INSERT INTO pf_transactions(owner_id, account_id, kind, amount, category, note, occurred_on, voided_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [w.admin, account, kind, amount, cat, note, today(), voided ? new Date() : null]);
  await ins(acc, 'income', 300000, 'sales', 'Vente directe');
  await ins(acc, 'expense', 120000, 'business', 'Loyer bureau');
  await ins(acc, 'expense', 999999, 'business', 'Annulée', true);
  await ins(other, 'expense', 77777, 'business', 'Hors sélection');
  const a = await call(db.app, 'fn_admin_accounting', w.admin, ago(1), today(), [acc]);
  const notes = a.manual.map((x) => x.note);
  assert.deepEqual(notes.sort(), ['Loyer bureau', 'Vente directe']);
  assert.equal(a.treasury.accounts_open, 100000);
  assert.equal(a.treasury.accounts_close, 100000 + 300000 - 120000);
  assert.deepEqual(a.selected, [acc]);
  const all = await call(db.app, 'fn_admin_accounting', w.admin, ago(1), today(), null);
  assert.equal(all.manual.length, 3);
  const none = await call(db.app, 'fn_admin_accounting', w.admin, ago(1), today(), []);
  assert.equal(none.manual.length, 0);
});

test('retour arrière : la fonction disparaît, rien d\'autre ne bouge', async () => {
  const before = (await db.owner.query('SELECT count(*)::int AS c FROM wallet_entries')).rows[0].c;
  const rb = fs.readFileSync(path.join(root, 'docs', 'retour-arriere-065.sql'), 'utf8');
  await db.owner.query('BEGIN'); for (const q of splitSql(rb)) { if (/^(begin|commit)$/i.test(q.trim())) continue; await db.owner.query(q); } await db.owner.query('COMMIT');
  assert.equal((await db.owner.query(`SELECT count(*)::int AS c FROM pg_proc WHERE proname = 'fn_admin_accounting'`)).rows[0].c, 0);
  assert.equal((await db.owner.query('SELECT count(*)::int AS c FROM wallet_entries')).rows[0].c, before);
});
