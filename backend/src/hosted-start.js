// Démarrage tout-en-un pour un hébergeur géré (Render, etc.) :
//   1. applique les migrations (compte propriétaire = DATABASE_URL)
//   2. crée le premier administrateur s'il n'existe aucun administrateur (ADMIN_PHONE / ADMIN_NAME / ADMIN_PASSWORD)
//   3. démarre le serveur
// Variables : DATABASE_URL, DB_APP_PASSWORD (obligatoire), ADMIN_*, HOST=0.0.0.0, TRUST_PROXY=1, NODE_ENV=production.
import { loadConfig } from './config.js';
import { Pool } from './pg.js';
import { migrate } from './migrate.js';
import { hashPassword, passwordProblem } from './security.js';
import { createServer, log } from './server.js';

const cfg = loadConfig();
if (!process.env.DB_APP_PASSWORD) { console.error('DB_APP_PASSWORD est obligatoire'); process.exit(1); }

try {
  await migrate(cfg.owner, process.env.DB_APP_PASSWORD, (m) => log({ msg: m }));
} catch (e) {
  console.error('Échec des migrations :', e.message);
  if (/permission denied|must be (owner|superuser)|42501/i.test(String(e.message) + String(e.code))) {
    console.error('Le compte de DATABASE_URL n\'a pas le droit de créer un rôle ou une extension : utilisez une base qui l\'autorise (ex. Neon).');
  }
  process.exit(1);
}

const { ADMIN_PHONE: phone, ADMIN_NAME: name, ADMIN_PASSWORD: pw, ADMIN_EMAIL: adminEmail } = process.env;
if (phone || name || pw) {
  if (!/^[0-9]{9}$/.test(phone || '') || !name || passwordProblem(pw)) {
    console.error('ADMIN_PHONE (9 chiffres), ADMIN_NAME et ADMIN_PASSWORD (8+ caractères, lettres et chiffres) sont invalides : administrateur non créé');
  } else {
    const db = new Pool(cfg.owner);
    try {
      const has = (await db.query(`SELECT 1 FROM users WHERE role = 'admin' LIMIT 1`)).rows.length > 0;
      if (!has) {
        await db.query(`INSERT INTO users(role, status, full_name, phone, password_hash, identity_verified)
          VALUES ('admin', 'active', $1, $2, $3, true) ON CONFLICT (phone) DO NOTHING`, [name, phone, await hashPassword(pw)]);
        log({ msg: `Administrateur créé : ${phone}` });
        // adresse e-mail facultative de l'administrateur : à confirmer ensuite dans Profil (code reçu par e-mail)
        if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(adminEmail || '')) {
          await db.query('UPDATE users SET email = $1 WHERE phone = $2 AND role = \'admin\'', [adminEmail.trim().toLowerCase(), phone]);
        }
      }
    } finally { await db.end(); }
  }
}

const s = await createServer(cfg);
s.server.listen(cfg.port, cfg.host, () => log({ level: 'info', msg: `Wallindirain démarré sur ${cfg.host}:${cfg.port}`, prod: cfg.prod }));
const stop = () => { s.close().then(() => process.exit(0)); setTimeout(() => process.exit(1), 10_000).unref(); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
