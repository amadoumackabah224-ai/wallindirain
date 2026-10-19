// Point d'entrée : node src/server.js
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { Pool } from './pg.js';
import { App } from './http.js';
import { registerRoutes } from './routes.js';
import { startWorker } from './messenger.js';
import { createLegal } from './legal.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function log(o) { console.log(JSON.stringify({ t: new Date().toISOString(), ...o })); }

export async function createServer(cfg = loadConfig(), { quiet = false, worker = true } = {}) {
  const db = new Pool(cfg.db);
  await db.query('SELECT 1');   // échoue vite si la base est injoignable
  const logger = quiet ? () => {} : log;
  const app = new App({ prod: cfg.prod, staticDir: path.resolve(here, '..', '..', 'frontend'), log: logger, legal: createLegal(cfg) });
  registerRoutes(app, { db, cfg });
  const server = http.createServer((req, res) => app.handle(req, res));
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  const w = worker ? startWorker({ db, cfg, log: logger }) : null;
  return {
    server, db, worker: w, resetLimits: () => app.resetLimits(),
    async close() { w?.stop(); await new Promise((r) => server.close(r)); await db.end(); }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig();
  const s = await createServer(cfg);
  s.server.listen(cfg.port, cfg.host, () => log({ level: 'info', msg: `Wallindirain démarré sur ${cfg.host}:${cfg.port}`, prod: cfg.prod }));
  const stop = () => { log({ msg: 'arrêt' }); s.close().then(() => process.exit(0)); setTimeout(() => process.exit(1), 10_000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
