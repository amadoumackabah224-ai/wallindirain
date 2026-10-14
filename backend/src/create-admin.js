// Crée le premier administrateur. Usage :
//   ADMIN_PHONE=624390707 ADMIN_NAME="Nom" ADMIN_PASSWORD='MotDePasse123' node src/create-admin.js
import { loadConfig } from './config.js';
import { Pool } from './pg.js';
import { hashPassword, passwordProblem } from './security.js';

const { ADMIN_PHONE: phone, ADMIN_NAME: name, ADMIN_PASSWORD: pw } = process.env;
if (!/^[0-9]{9}$/.test(phone || '') || !name || passwordProblem(pw)) {
  console.error('Variables requises : ADMIN_PHONE (9 chiffres), ADMIN_NAME, ADMIN_PASSWORD (8+ caractères, lettres et chiffres)');
  process.exit(1);
}
const db = new Pool(loadConfig().owner);
try {
  const { rows } = await db.query(`INSERT INTO users(role, status, full_name, phone, password_hash, identity_verified)
    VALUES ('admin', 'active', $1, $2, $3, true) ON CONFLICT (phone) DO NOTHING RETURNING id`, [name, phone, await hashPassword(pw)]);
  console.log(rows.length ? `Administrateur créé : ${name} (${phone})` : 'Ce numéro existe déjà : rien n\'a été modifié.');
} finally { await db.end(); }
