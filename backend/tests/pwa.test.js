// Application installable (PWA) : manifeste, service worker et liste des fichiers gardés hors connexion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'frontend');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const shell = JSON.parse(`[${/const SHELL = \[([\s\S]*?)\];/.exec(sw)[1].replace(/'/g, '"')}]`);
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

test('manifeste : installable, plein écran, icônes présentes dont une « maskable »', () => {
  const m = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.display, 'standalone'); assert.equal(m.lang, 'fr'); assert.equal(m.scope, '/'); assert.equal(m.start_url, '/#/app/');
  assert.match(m.theme_color, /^#0B1B3B$/i);
  for (const i of m.icons) assert.ok(fs.existsSync(path.join(root, i.src)), i.src);
  assert.ok(m.icons.some((i) => i.sizes === '192x192') && m.icons.some((i) => i.sizes === '512x512' && i.purpose === 'any') && m.icons.some((i) => i.purpose === 'maskable'));
  assert.match(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), /rel="manifest"/);
});

test('service worker : tous les fichiers de l\'application sont listés (et existent), rien d\'autre n\'est mis en cache', () => {
  const js = walk(path.join(root, 'js')).map((f) => '/' + path.relative(root, f).split(path.sep).join('/'));
  for (const f of js) assert.ok(shell.includes(f), `${f} manque dans la liste du service worker (sw.js)`);
  for (const f of shell) assert.ok(f === '/' || fs.existsSync(path.join(root, f)), `${f} n'existe pas`);
  for (const f of ['/css/app.css', '/css/legal.css']) assert.ok(shell.includes(f), f);
  // règles de sécurité : jamais les appels /api, jamais autre chose que GET, jamais un autre site
  assert.match(sw, /startsWith\('\/api\/'\)/); assert.match(sw, /req\.method !== 'GET'/); assert.match(sw, /url\.origin !== self\.location\.origin/);
  assert.ok(!shell.some((f) => f.startsWith('/api')), 'aucun appel API dans la liste');
});

test('enregistrement : le service worker est servi à la racine, la politique de sécurité n\'est pas affaiblie', () => {
  assert.ok(fs.existsSync(path.join(root, 'sw.js')));
  const pwa = fs.readFileSync(path.join(root, 'js', 'pwa.js'), 'utf8');
  assert.match(pwa, /register\('\/sw\.js'\)/);
  assert.ok(!/innerHTML|eval\(|style=/.test(pwa), 'pas de code interdit par la politique de sécurité');
  assert.ok(!/localStorage\.(set|get)Item\([^)]*(token|password|mot)/i.test(pwa), 'rien de sensible gardé dans le navigateur');
});
