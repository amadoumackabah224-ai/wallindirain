// Garde-fou : aucun secret (clé privée, jeton, adresse de base avec mot de passe réel) ne doit se retrouver dans les fichiers suivis par git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
  .filter((f) => !/\.(png|jpe?g|webp|pdf|ico|woff2?)$/i.test(f));
const PLACEHOLDER = /(exemple|example|changez|changeme|utilisateur|motdepasse|password|votre|xxx|\.\.\.|<|\$\{|\$[A-Z_]+|\{\{|test|demo|secret123)/i;
const RULES = [
  ['clé privée', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['clé AWS', /AKIA[0-9A-Z]{16}/],
  ['jeton GitHub', /gh[pousr]_[A-Za-z0-9]{30,}/],
  ['clé API longue', /(?:api[_-]?key|secret[_-]?token|access[_-]?token|auth[_-]?token)\s*[:=]\s*['"][A-Za-z0-9_\-]{24,}['"]/i],
];
const DB_URL = /postgres(?:ql)?:\/\/([^:\s'"\/]+):([^@\s'"]+)@([^\s'"\/]+)/g;

test('aucun secret dans les fichiers suivis par git', () => {
  const found = [];
  for (const f of files) {
    let txt; try { txt = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    if (f === 'backend/tests/secrets-scan.test.js') continue;
    for (const [name, re] of RULES) if (re.test(txt)) found.push(`${f} : ${name}`);
    for (const m of txt.matchAll(DB_URL)) if (!PLACEHOLDER.test(m[0])) found.push(`${f} : adresse de base avec mot de passe`);
  }
  assert.deepEqual(found, []);
});

test('les fichiers sensibles ne sont pas suivis par git', () => {
  const bad = files.filter((f) => /(^|\/)\.env(\.|$)/.test(f) && !/\.example$/.test(f) || /\.(pem|key|p12|pfx|dump)$/i.test(f));
  assert.deepEqual(bad, []);
});

test('les secrets de déploiement ne sont jamais écrits dans render.yaml', () => {
  const y = fs.readFileSync(path.join(root, 'render.yaml'), 'utf8');
  const blocks = y.split(/\n\s*- key: /).slice(1);
  for (const b of blocks) {
    const key = b.split('\n')[0].trim();
    if (/(PASSWORD|TOKEN|SECRET|API_KEY|DATABASE_URL)/.test(key)) assert.match(b, /(sync:\s*false|generateValue:\s*true)/, `${key} ne doit jamais avoir de valeur écrite (sync: false ou generateValue: true)`);
  }
});
