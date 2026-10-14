// Tests de l'API HTTP réelle : sécurité, cloisonnement des rôles, parcours complet.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, TEST_DB, APP_PW } from './helpers.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';

let srv, base, db;
const PW = 'Secret123';

class Client {
  constructor() { this.cookie = ''; }
  async req(method, path, body, headers = {}) {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}), ...(method !== 'GET' ? { 'x-wld': '1' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.getSetCookie?.() ?? [];
    for (const c of sc) { const kv = c.split(';')[0]; this.cookie = kv.endsWith('=') ? '' : kv; }
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, json, headers: res.headers, text };
  }
  get(p) { return this.req('GET', p); }
  post(p, b = {}, h) { return this.req('POST', p, b, h); }
  async login(phone, password = PW) { const r = await this.post('/api/auth/login', { phone, password }); assert.equal(r.status, 200, JSON.stringify(r.json)); return this; }
}

const phones = {};
beforeEach(() => srv.resetLimits());

async function mkStaff(admin, role, team) {
  const phone = String(Math.floor(600000000 + Math.random() * 99999999));
  const r = await admin.post('/api/admin/users', { phone, name: `${role} test`, role, password: PW, team });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  phones[role + (team || '')] = phone;
  return phone;
}

before(async () => {
  db = await freshDb('wld_api');
  const hash = await hashPassword(PW);
  await db.owner.query(`INSERT INTO users(role,status,full_name,phone,password_hash,identity_verified) VALUES ('admin','active','Admin','620000000',$1,true)`, [hash]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  srv = await createServer({
    prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', trustProxy: false,
    db: { ...TEST_DB, database: 'wld_api', user: 'wld_app', password: APP_PW, max: 5 }, owner: {},
    messaging: { provider: 'simulated' }
  }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });

test('en-têtes de sécurité et fichiers statiques', async () => {
  const r = await new Client().get('/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal((await new Client().get('/../../etc/passwd')).status, 200);   // retombe sur l'application, jamais sur un fichier système
  assert.doesNotMatch((await new Client().get('/..%2f..%2fetc%2fpasswd')).text, /root:/);
});

test('authentification : mauvais mot de passe, verrouillage après 5 échecs', async () => {
  const c = new Client();
  assert.equal((await c.post('/api/auth/login', { phone: '620000000', password: 'faux' })).status, 401);
  assert.equal((await c.post('/api/auth/login', { phone: '699999999', password: 'faux' })).status, 401);   // numéro inconnu : même réponse
  for (let i = 0; i < 4; i++) await c.post('/api/auth/login', { phone: '620000000', password: 'faux' });
  const locked = await c.post('/api/auth/login', { phone: '620000000', password: PW });
  assert.equal(locked.status, 423);
  await db.owner.query(`UPDATE users SET locked_until = NULL, failed_attempts = 0 WHERE phone = '620000000'`);
});

test('droits : sans session ou sans en-tête CSRF, tout est refusé', async () => {
  assert.equal((await new Client().get('/api/admin/users')).status, 401);
  const admin = await new Client().login('620000000');
  assert.equal((await admin.req('POST', '/api/admin/settings', { key: 'call_fee', value: 1 }, { 'x-wld': '0' })).status, 403);
  assert.equal((await admin.req('POST', '/api/admin/settings', { key: 'call_fee', value: 5000 }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await admin.get('/api/auth/me')).json.user.role, 'admin');
});

test('parcours complet via HTTP + cloisonnement fournisseur / vendeur / client', async () => {
  const admin = await new Client().login('620000000');
  const agentPhone = await mkStaff(admin, 'agent', 'Alpha');
  const chiefPhone = await mkStaff(admin, 'call_chief', 'Alpha');
  const courierPhone = await mkStaff(admin, 'courier');
  const whPhone = await mkStaff(admin, 'warehouse');

  // inscriptions
  const sup = new Client(), sel = new Client();
  assert.equal((await sup.post('/api/auth/register', { phone: '621000001', name: 'Fournisseur Secret', role: 'supplier', password: PW, identity_doc: 'CNI-111111' })).status, 201);
  assert.equal((await sup.post('/api/auth/login', { phone: '621000001', password: PW })).status, 403);   // attend la validation
  assert.equal((await sel.post('/api/auth/register', { phone: '622000001', name: 'Vendeur Secret', role: 'seller', password: PW, identity_doc: 'CNI-222222' })).status, 201);
  assert.equal((await new Client().post('/api/auth/register', { phone: '622000002', name: 'X Y', role: 'admin', password: PW, identity_doc: 'CNI-3333' })).status, 400);   // pas d'inscription admin
  assert.equal((await new Client().post('/api/auth/register', { phone: '622000003', name: 'X Y', role: 'seller', password: 'court', identity_doc: 'CNI-3333' })).status, 400);
  const supId = (await admin.get('/api/admin/users?role=supplier')).json.users[0].id;
  await admin.post(`/api/admin/users/${supId}/status`, { status: 'active' });
  await sup.login('621000001'); await sel.login('622000001');

  // catalogue
  const added = await sup.post('/api/supplier/products', { name: 'Montre connectée', description: 'Étanche', supplier_price: 60000, storage: 'wallindirain' });
  assert.equal(added.status, 201);
  const pid = added.json.id;
  assert.equal((await sel.get('/api/seller/catalog')).json.products.length, 0);   // pas encore validé
  assert.equal((await admin.post(`/api/admin/products/${pid}/review`, { approve: true })).status, 200);
  const arr = (await sup.post(`/api/supplier/products/${pid}/arrival`, { qty: 5 })).json.id;
  const wh = await new Client().login(whPhone);
  assert.equal((await wh.post(`/api/warehouse/arrivals/${arr}/count`, { counted: 5 })).status, 200);

  // le vendeur fixe son prix ; le prix minimum est imposé
  const cat = (await sel.get('/api/seller/catalog')).json.products[0];
  assert.equal(cat.vendor_price, 69000); assert.equal(cat.min_price, 104000);
  assert.equal((await sel.post('/api/seller/prices', { product_id: pid, price: 100000 })).status, 400);
  assert.equal((await sel.post('/api/seller/prices', { product_id: pid, price: 150000 })).status, 200);
  const link = (await sel.post('/api/seller/links', { product_id: pid })).json.code;

  // page publique : aucun nom de vendeur ni de fournisseur
  const anon = new Client();
  const pub = await anon.get(`/api/public/link/${link}`);
  assert.equal(pub.status, 200); assert.equal(pub.json.product.unit_price, 150000);
  assert.doesNotMatch(pub.text, /Secret|supplier|seller|60000|69000/);
  const placed = await anon.post(`/api/public/link/${link}/order`, { qty: 1, name: 'Mariama Diallo', phone: '623000001', commune: 'Ratoma', address: 'Kipé, près de la pharmacie' });
  assert.equal(placed.status, 201); const ref = placed.json.ref;
  assert.match(ref, /^WLD-\d+$/);

  // le fournisseur ne voit ni le vendeur ni le client ni le prix de vente
  assert.equal((await sup.get('/api/supplier/orders')).json.orders.length, 0);   // pas encore confirmée

  // l'agent appelle
  const agent = await new Client().login(agentPhone);
  const queue = (await agent.get('/api/calls/queue')).json.orders;
  assert.equal(queue[0].ref, ref);
  assert.equal('supplier_price' in queue[0], false);
  assert.doesNotMatch(JSON.stringify(queue), /Secret|60000|69000/);
  const oid = queue[0].id;
  assert.equal((await agent.post(`/api/calls/${oid}/take`)).status, 200);
  const agent2 = await new Client().login(agentPhone);
  assert.equal((await agent2.post(`/api/calls/${oid}/take`)).status, 200);   // même agent : OK
  assert.equal((await agent.post(`/api/calls/${oid}/log`, { result: 'confirmed', note: 'Client OK' })).status, 200);

  // affectation et livraison
  const chief = await new Client().login(chiefPhone), courier = await new Client().login(courierPhone);
  const cid = (await chief.get('/api/chief/orders')).json.couriers[0].id;
  assert.equal((await agent.post(`/api/chief/orders/${oid}/assign`, { courier_id: cid })).status, 403);   // un agent ne peut pas affecter
  assert.equal((await chief.post(`/api/chief/orders/${oid}/assign`, { courier_id: cid })).status, 200);
  const mine = (await courier.get('/api/courier/orders')).json;
  assert.equal(mine.orders[0].amount_to_collect, 150000);
  assert.doesNotMatch(JSON.stringify(mine), /Secret|69000|60000|gain/);
  assert.equal((await courier.post(`/api/courier/orders/${oid}/pickup`)).status, 200);
  assert.equal((await courier.post(`/api/courier/orders/${oid}/depart`)).status, 200);
  const bad = await courier.post(`/api/courier/orders/${oid}/deliver`, { code: '0000' });
  const code = /Code de livraison : (\d{4})/.exec((await db.app.query(`SELECT body FROM messages WHERE template='delivery_code' AND body LIKE $1`, [`%${ref}%`])).rows[0].body)[1];
  if (code !== '0000') assert.equal(bad.status, 400);
  assert.equal((await courier.post(`/api/courier/orders/${oid}/deliver`, { code })).status, 200);

  // messages : le worker marque "simulated", l'administrateur ne voit jamais les codes
  await srv.worker.flushMessages();
  const msgs = (await admin.get('/api/admin/messages')).json.messages;
  assert.ok(msgs.some((m) => m.template === 'delivery_code' && m.status === 'simulated'));
  assert.doesNotMatch(JSON.stringify(msgs), new RegExp(`Code de livraison : ${code}`));

  // le vendeur voit appels, gain attendu, et rien du fournisseur
  const detail = (await sel.get(`/api/seller/orders/${oid}`)).json;
  assert.equal(detail.order.expected_gain, 46000);
  assert.equal(detail.calls[0].call_center, 'Alpha');
  assert.doesNotMatch(JSON.stringify(detail), /Fournisseur Secret|supplier/i);
  assert.equal((await sel.get('/api/supplier/products')).status, 403);   // le vendeur n'accède pas à l'espace fournisseur

  // le fournisseur voit la référence WLD seulement
  const so = (await sup.get('/api/supplier/orders')).json.orders[0];
  assert.deepEqual(Object.keys(so).sort(), ['created_at', 'product_name', 'qty', 'qty_to_prepare', 'ref', 'status']);
  assert.doesNotMatch(JSON.stringify(await (await sup.get('/api/supplier/orders')).json), /Vendeur|Mariama|Ratoma|150000/);

  // portefeuilles
  assert.equal((await sup.get('/api/wallet')).json.pending, 60000);
  assert.equal((await sel.get('/api/wallet')).json.pending, 46000);
  assert.equal((await wh.get('/api/wallet')).status, 403);   // le magasinier n'a pas de portefeuille
  const dash = (await admin.get('/api/admin/dashboard')).json;
  assert.equal(dash.delivered_today, 1); assert.equal(dash.platform_result, 38000); assert.equal(dash.ledger_problems, 0);
});

test('rôles : chaque espace est interdit aux autres rôles', async () => {
  const admin = await new Client().login('620000000');
  const sel = await new Client().login('622000001');
  const sup = await new Client().login('621000001');
  const forbidden = [[sel, '/api/admin/users'], [sel, '/api/supplier/products'], [sel, '/api/calls/queue'], [sel, '/api/courier/orders'], [sel, '/api/warehouse/arrivals'],
    [sup, '/api/seller/catalog'], [sup, '/api/admin/dashboard'], [sup, '/api/chief/orders']];
  for (const [c, p] of forbidden) assert.equal((await c.get(p)).status, 403, p);
  assert.equal((await admin.get('/api/seller/catalog')).status, 403);   // l'admin n'agit pas comme vendeur
});

test('injection SQL et entrées invalides', async () => {
  const c = new Client();
  assert.equal((await c.post('/api/auth/login', { phone: "'; DROP TABLE users;--", password: 'x' })).status, 400);
  const admin = await new Client().login('620000000');
  assert.equal((await admin.get(`/api/admin/orders?search=${encodeURIComponent("' OR 1=1 --")}`)).status, 200);
  const inj = await admin.get('/api/admin/users?role=admin%27%20OR%201=1');
  assert.equal(inj.status, 200); assert.deepEqual(inj.json.users, []);   // la valeur est un paramètre lié, jamais du SQL
  assert.equal(Number((await db.owner.query('SELECT count(*) FROM users')).rows[0].count) > 3, true);
  assert.equal((await c.req('POST', '/api/auth/login', undefined, { 'content-type': 'text/plain' })).status, 400);
  const big = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: 'x'.repeat(100_000) }) });
  assert.equal(big.status, 413);
});

test('mot de passe oublié : code par message, un seul usage', async () => {
  const c = new Client();
  assert.equal((await c.post('/api/auth/forgot', { phone: '622000001' })).status, 200);
  assert.equal((await c.post('/api/auth/forgot', { phone: '699999998' })).status, 200);   // même réponse pour un numéro inconnu
  const code = /est (\d{6})/.exec((await db.app.query(`SELECT body FROM messages WHERE template='password_reset' ORDER BY id DESC LIMIT 1`)).rows[0].body)[1];
  assert.equal((await c.post('/api/auth/reset', { phone: '622000001', code: '000000', password: 'Nouveau123' })).status, 400);
  assert.equal((await c.post('/api/auth/reset', { phone: '622000001', code, password: 'Nouveau123' })).status, 200);
  assert.equal((await c.post('/api/auth/reset', { phone: '622000001', code, password: 'Autre12345' })).status, 400);
  await new Client().login('622000001', 'Nouveau123');
});

test('déconnexion : la session est révoquée côté serveur', async () => {
  const c = await new Client().login('620000000');
  const stolen = c.cookie;
  await c.post('/api/auth/logout');
  const thief = new Client(); thief.cookie = stolen;
  assert.equal((await thief.get('/api/auth/me')).status, 401);
});

test('limitation de débit : trop de connexions depuis la même adresse', async () => {
  const c = new Client();
  let last;
  for (let i = 0; i < 25; i++) last = await c.post('/api/auth/login', { phone: `61000000${i % 10}`, password: 'faux' });
  assert.equal(last.status, 429);
  const flood = new Client();
  let st;
  for (let i = 0; i < 12; i++) st = (await flood.post('/api/public/link/inconnu/order', { qty: 1, name: 'Abc', phone: '623999999', commune: 'Ratoma', address: 'Rue 1' })).status;
  assert.equal(st, 429);
});
