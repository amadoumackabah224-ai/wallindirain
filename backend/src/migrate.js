// Applique les migrations SQL dans l'ordre, une seule fois chacune (table schema_migrations).
// Usage : node src/migrate.js        (variables DB_OWNER_* et DB_APP_PASSWORD)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from './pg.js';
import { loadConfig } from './config.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate(ownerOpts, appPassword, log = console.log) {
  const pool = new Pool(ownerOpts);
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      log(`Migration ${file}…`);
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      // les fichiers contiennent plusieurs instructions : protocole simple via une transaction par fichier
      await pool.tx(async (tx) => { await runScript(tx, sql); await tx.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]); });
    }
    if (appPassword) {
      const pw = String(appPassword).replace(/'/g, "''");
      await pool.query(`DO $$ BEGIN EXECUTE format('ALTER ROLE wld_app LOGIN PASSWORD %L', '${pw}'); END $$`);
      await pool.query(`DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO wld_app', current_database()); END $$`);
    }
  } finally { await pool.end(); }
}

// Découpe un script SQL en instructions (gère $$ ... $$, chaînes et commentaires).
export function splitSql(sql) {
  const out = []; let cur = ''; let i = 0; let dollar = null;
  while (i < sql.length) {
    const ch = sql[i];
    if (dollar) {
      if (sql.startsWith(dollar, i)) { cur += dollar; i += dollar.length; dollar = null; } else { cur += ch; i++; }
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; continue; }
    if (ch === "'") {
      cur += ch; i++;
      while (i < sql.length) { cur += sql[i]; if (sql[i] === "'") { if (sql[i + 1] === "'") { cur += "'"; i += 2; continue; } i++; break; } i++; }
      continue;
    }
    if (ch === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) { dollar = m[0]; cur += dollar; i += dollar.length; continue; }
    }
    if (ch === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

async function runScript(tx, sql) { for (const stmt of splitSql(sql)) await tx.query(stmt); }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig();
  migrate(cfg.owner, process.env.DB_APP_PASSWORD).then(() => console.log('Base à jour.'), (e) => { console.error(e); process.exit(1); });
}
