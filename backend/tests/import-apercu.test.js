// Import : aperçu avant import, fichier Excel (.xlsx), rapport des lignes rejetées.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { freshDb, TEST_DB, APP_PW, world } from './helpers.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';

const PW = 'Secret123';
let db, w, srv, base;
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

const nOrders = async () => (await db.owner.query('SELECT count(*)::int AS n FROM orders')).rows[0].n;

// Fabrique un .xlsx minimal (zip + XML) sans dépendance
const xlsx = (rows) => {
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const sheet = `<?xml version="1.0"?><worksheet><sheetData>${rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => typeof v === 'number' ? `<c r="${String.fromCharCode(65 + j)}${i + 1}"><v>${v}</v></c>` : `<c r="${String.fromCharCode(65 + j)}${i + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`;
  const files = [['[Content_Types].xml', '<Types/>'], ['xl/worksheets/sheet1.xml', sheet]];
  const parts = [], central = []; let off = 0;
  for (const [name, data] of files) {
    const nb = Buffer.from(name), raw = Buffer.from(data), comp = zlib.deflateRawSync(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, nb, comp); central.push(ch, nb); off += 30 + nb.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]).toString('base64');
};
const HEAD = ['nom', 'téléphone', 'quartier', 'adresse', 'produit', 'quantité', 'prix', 'confirmé'];

before(async () => {
  db = await freshDb('wld_import'); w = await world(db);
  await db.owner.query(`UPDATE users SET password_hash = $1`, [await hashPassword(PW)]);
  await db.owner.query(`ALTER ROLE wld_app PASSWORD '${APP_PW}'`);
  srv = await createServer({ prod: false, port: 0, host: '127.0.0.1', contactPhone: '624390707', legal: { version: '2026-10-24' }, trustProxy: false, showTestCodes: true,
    db: { ...TEST_DB, database: 'wld_import', user: 'wld_app', password: APP_PW, max: 6 }, owner: {}, messaging: { provider: 'simulated' } }, { quiet: true });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
beforeEach(() => srv.resetLimits());
after(async () => { await srv.close(); await db.owner.end(); await db.app.end(); });

test('aperçu : rien n\'est créé ; les erreurs et les lignes en double sont signalées', async () => {
  const s = await login(w.seller);
  const csv = ['nom,téléphone,quartier,adresse,produit,quantité,prix,confirmé',
    'Aïssatou Diallo,621000101,Ratoma,Près du marché,Sac en cuir,1,90000,oui',
    'Mamadou Sow,12,Ratoma,Rue 2,Sac en cuir,1,90000,non',
    'Fatou Camara,621000103,Ratoma,Rue 3,Sac en cuir,1,90000,non',
    'Fatou Camara,621000103,Ratoma,Rue 3,Sac en cuir,1,90000,non',
    'Ibrahima Bah,621000105,Ratoma,Rue 5,Inconnu,1,,non'].join('\n');
  const before = await nOrders();
  const r = await s.post('/api/seller/import', { csv, dry_run: true });
  assert.equal(r.status, 200); assert.equal(r.json.dry_run, true);
  assert.equal(await nOrders(), before);                                                       // aucune commande créée
  const st = r.json.preview.map((x) => x.status);
  assert.deepEqual(st, ['ok', 'error', 'ok', 'duplicate', 'error']);
  assert.match(r.json.preview[1].message, /Téléphone invalide/);
  // import réel : mêmes résultats, et le rapport des lignes rejetées contient les données de la ligne
  const real = await s.post('/api/seller/import', { csv });
  assert.equal(real.json.created, 2); assert.equal(real.json.duplicates, 1); assert.equal(real.json.errors.length, 2);
  assert.equal(real.json.errors[0].row.name, 'Mamadou Sow'); assert.equal(await nOrders(), before + 2);
  // l'aperçu suivant signale que tout est déjà importé
  const again = await s.post('/api/seller/import', { csv, dry_run: true });
  assert.deepEqual(again.json.preview.map((x) => x.status), ['duplicate', 'error', 'duplicate', 'duplicate', 'error']);
});

test('fichier Excel : aperçu puis import ; fichier illisible refusé ; autre vendeur non concerné', async () => {
  const s = await login(w.seller);
  const file = xlsx([HEAD, ['Kadiatou Barry', 621000201, 'Ratoma', 'Rue 7', 'Sac en cuir', 2, 80000, 'oui'], ['Sékou Condé', '621000202', 'Ratoma', 'Rue 8', 'Montre', 1, 150000, 'non']]);
  const prev = await s.post('/api/seller/import', { xlsx: file, dry_run: true });
  assert.equal(prev.status, 200); assert.deepEqual(prev.json.preview.map((x) => x.status), ['ok', 'ok']);
  assert.equal(prev.json.preview[0].qty, 2);
  const before = await nOrders();
  const real = await s.post('/api/seller/import', { xlsx: file });
  assert.equal(real.json.created, 2); assert.equal(await nOrders(), before + 2);
  assert.equal((await s.post('/api/seller/import', { xlsx: Buffer.from('ceci n\'est pas un fichier excel du tout, vraiment pas').toString('base64'), dry_run: true })).status, 400);
  assert.equal((await s.post('/api/seller/import', { xlsx: Buffer.alloc(2000, 1).toString('base64'), dry_run: true })).status, 400);
  const other = new Client();                                                                   // non connecté : refusé
  assert.equal((await other.post('/api/seller/import', { xlsx: file, dry_run: true })).status, 401);
});
