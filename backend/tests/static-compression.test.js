// Fichiers de l'interface : compressés (brotli ou gzip), empreinte stable, 304 si inchangé, images laissées telles quelles.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from '../src/http.js';

const staticDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'frontend');
let server; let port;
before(async () => {
  const app = new App({ prod: false, staticDir, log: () => {} });
  server = http.createServer((req, res) => app.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); port = server.address().port;
});
after(() => new Promise((r) => server.close(r)));
const get = (p, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ res, body: Buffer.concat(c) })); }).on('error', reject);
});

test('brotli si le navigateur le sait, sinon gzip, sinon le fichier brut ; le contenu reste identique', async () => {
  const raw = await get('/js/views/pf.js');
  assert.equal(raw.res.headers['content-encoding'], undefined);
  const br = await get('/js/views/pf.js', { 'accept-encoding': 'gzip, deflate, br' });
  assert.equal(br.res.headers['content-encoding'], 'br'); assert.equal(br.res.headers.vary, 'Accept-Encoding');
  assert.ok(br.body.length < raw.body.length / 3, 'au moins trois fois plus petit');
  assert.equal(zlib.brotliDecompressSync(br.body).toString(), raw.body.toString());
  const gz = await get('/js/views/pf.js', { 'accept-encoding': 'gzip' });
  assert.equal(gz.res.headers['content-encoding'], 'gzip'); assert.equal(zlib.gunzipSync(gz.body).toString(), raw.body.toString());
  assert.equal(Number(br.res.headers['content-length']), br.body.length);
});

test('revalidation : 304 avec la même empreinte, une empreinte différente par encodage', async () => {
  const a = await get('/css/app.css', { 'accept-encoding': 'br' });
  const again = await get('/css/app.css', { 'accept-encoding': 'br', 'if-none-match': a.res.headers.etag });
  assert.equal(again.res.statusCode, 304); assert.equal(again.body.length, 0);
  const plain = await get('/css/app.css');
  assert.notEqual(plain.res.headers.etag, a.res.headers.etag);
  assert.equal(a.res.headers['cache-control'], 'no-cache');
});

test('les images ne sont pas recompressées', async () => {
  const r = await get('/assets/logo-gold.png', { 'accept-encoding': 'br, gzip' });
  assert.equal(r.res.headers['content-encoding'], undefined); assert.equal(r.res.statusCode, 200);
});
