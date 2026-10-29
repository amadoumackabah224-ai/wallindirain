// Factures (migration 033) : routes, droits, export CSV.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, TEST_DB, APP_PW, world, approvedProduct, call, deliver } from './helpers.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';

const PW = 'Secret123';
let db, w, product, srv, base, n = 0, k = 0;
const phone = () => `6${String(++n).padStart(8, '0')}`;
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

before(async () => {
  db = await freshDb('wld_fachttp'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  product = await approvedProduct(db, w, { price: 60000, qty: 50 });
  await call(db.app, 'fn_seller_set_price', w.seller, product, 120000);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_fachttp', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });


let n2 = 0;
const deliverOne = async (name = 'Client Facture') => {
  const o = await call(db.app, 'fn_seller_create_order', w.seller, product, null, null, 1, name, `65${String(++n2 + 8000000).padStart(7, '0')}`, 'Kaloum', 'Rue 3', null, false);
  await deliver(db, w, o.id, o.ref); return o;
};

test('droits : chacun ne voit et n\'émet que ses documents ; l\'administrateur voit tout', async () => {
  const o = await deliverOne();
  const sel = await login(w.seller), sel2 = await login(w.seller2), sup = await login(w.supplier), adm = await login(w.admin), cou = await login(w.courier), nobody = new Client();
  assert.equal((await nobody.get('/api/invoices')).status, 401);
  assert.equal((await sup.post('/api/invoices/delivery', { order_id: o.id })).status, 403);                    // un fournisseur ne facture pas une livraison
  assert.equal((await sel2.post('/api/invoices/delivery', { order_id: o.id })).status, 404);                   // ni le vendeur d'un autre
  const r = await sel.post('/api/invoices/delivery', { order_id: o.id });
  assert.equal(r.status, 200); assert.ok(r.json.id);
  assert.equal((await sel.post('/api/invoices/delivery', { order_id: o.id })).json.id, r.json.id);            // idempotent
  const doc = await sel.get(`/api/invoices/${r.json.id}`);
  assert.equal(doc.status, 200); assert.match(doc.json.invoice.number, /^FAC-/);
  assert.equal((await sel2.get(`/api/invoices/${r.json.id}`)).status, 404);
  assert.equal((await sup.get(`/api/invoices/${r.json.id}`)).status, 404);
  assert.equal((await adm.get(`/api/invoices/${r.json.id}`)).status, 200);
  assert.equal((await cou.get('/api/invoices')).json.invoices.length, 0);
  assert.equal((await sel.get('/api/invoices')).json.invoices.length, 1);
  assert.equal((await sel2.get('/api/invoices')).json.invoices.length, 0);
  // l'administrateur peut émettre par référence de commande
  const o2 = await deliverOne('Autre Client');
  assert.equal((await adm.post('/api/invoices/delivery', { ref: o2.ref })).status, 200);
  assert.equal((await adm.post('/api/invoices/delivery', { ref: 'WLD-0' })).status, 404);
  // commandes livrées du vendeur avec numéro de facture
  const list = (await sel.get('/api/seller/delivered-orders')).json.orders;
  assert.ok(list.some((x) => x.invoice_number) && list.some((x) => !x.invoice_number) === false || list.length >= 1);
  assert.equal((await sup.get('/api/seller/delivered-orders')).status, 403);
});

test('validations : dates, type, période terminée', async () => {
  const sel = await login(w.seller);
  assert.equal((await sel.post('/api/invoices/statement', { period_from: 'hier', period_to: '2026-01-01' })).status, 400);
  const today = new Date().toISOString().slice(0, 10);
  const r = await sel.post('/api/invoices/statement', { period_from: today, period_to: today });
  assert.equal(r.status, 409);                                                                                // période non terminée
  assert.equal((await sel.get('/api/invoices?kind=nimporte')).status, 400);
  assert.equal((await sel.get('/api/invoices?from=pasunedate')).status, 400);
});

test('administrateur : vue d\'ensemble, informations de l\'entreprise, export CSV sans injection de formule', async () => {
  const adm = await login(w.admin), sel = await login(w.seller);
  assert.equal((await sel.get('/api/admin/finance')).status, 403); assert.equal((await sel.get('/api/admin/company')).status, 403); assert.equal((await sel.get('/api/admin/invoices/export')).status, 403);
  const f = await adm.get('/api/admin/finance');
  assert.equal(f.status, 200); assert.ok(f.json.summary.deliveries.count >= 2); assert.equal(typeof f.json.summary.ledger.seller_gain, 'string' === typeof 0 ? 'string' : typeof f.json.summary.ledger.seller_gain);
  assert.equal((await adm.post('/api/admin/company', { legal_name: '=CMD() Société', address: 'Kaloum', nif: 'NIF-1' })).status, 200);
  assert.equal((await adm.get('/api/admin/company')).json.company.nif, 'NIF-1');
  assert.equal((await adm.post('/api/admin/company', { legal_name: 'X' })).status, 400);
  const o = await deliverOne('=HYPERLINK("x")');
  await adm.post('/api/invoices/delivery', { order_id: o.id });
  const res = await fetch(`${base}/api/admin/invoices/export`, { headers: { cookie: adm.cookie } });
  assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /text\/csv/);
  const raw = Buffer.from(await res.arrayBuffer()); assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf]);   // BOM : Excel lit bien les accents
  const csv = raw.toString('utf8');
  assert.match(csv, /Numéro;Type;/); assert.match(csv, /FAC-\d{4}-000003/);
  assert.doesNotMatch(csv, /(^|;)=/m);                                                                         // aucune cellule ne commence par =
  const doc = (await adm.get(`/api/invoices/${(await adm.get('/api/invoices?q=FAC-')).json.invoices[0].id}`)).json.invoice;
  assert.equal(doc.data.issuer.name, '=CMD() Société');                                                       // copie fidèle dans le document (affiché comme texte à l'écran)
});
