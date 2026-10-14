// Données de démonstration (JAMAIS en production). Mot de passe de tous les comptes : Demo12345
// Usage : node src/seed-demo.js
import { loadConfig } from './config.js';
import { Pool } from './pg.js';
import { hashPassword } from './security.js';

const cfg = loadConfig();
if (cfg.prod) { console.error('Refusé : seed-demo ne s\'exécute pas en production.'); process.exit(1); }
const db = new Pool(cfg.owner);
const call = async (fn, ...a) => (await db.query(`SELECT ${fn}(${a.map((_, i) => `$${i + 1}`).join(',')}) AS r`, a)).rows[0].r;
const PW = await hashPassword('Demo12345');

const mkUser = async (phone, name, role, team) => {
  const ex = (await db.query('SELECT id FROM users WHERE phone = $1', [phone])).rows[0];
  if (ex) return ex.id;
  const { rows } = await db.query(`INSERT INTO users(role,status,full_name,phone,password_hash,team,identity_doc,identity_verified) VALUES ($1,'active',$2,$3,$4,$5,$6,true) RETURNING id`,
    [role, name, phone, PW, team || null, ['seller', 'supplier'].includes(role) ? 'CNI-DEMO' : null]);
  return rows[0].id;
};
const admin = await mkUser('620000001', 'Administrateur Démo', 'admin');
const U = {
  agent: await mkUser('620000002', 'Aïssatou Bah', 'agent', 'Alpha'), agent2: await mkUser('620000003', 'Ibrahima Camara', 'agent', 'Alpha'),
  chief: await mkUser('620000004', 'Mamadou Sylla', 'call_chief', 'Alpha'), courier: await mkUser('620000005', 'Sékou Diallo', 'courier'),
  courier2: await mkUser('620000006', 'Fanta Touré', 'courier'), warehouse: await mkUser('620000007', 'Kadiatou Barry', 'warehouse'),
  supplier: await mkUser('620000008', 'Fournisseur Démo', 'supplier'), seller: await mkUser('620000009', 'Vendeur Démo', 'seller')
};
const prod = async (name, desc, price, storage, qty) => {
  const ex = (await db.query('SELECT id FROM products WHERE name = $1', [name])).rows[0]; if (ex) return ex.id;
  const id = await call('fn_supplier_add_product', U.supplier, name, desc, price, storage, 0);
  await call('fn_admin_review_product', admin, id, true, null);
  if (storage === 'wallindirain') { const a = await call('fn_supplier_announce_arrival', U.supplier, id, qty); await call('fn_warehouse_count_arrival', U.warehouse, a, qty); }
  else await call('fn_supplier_set_stock', U.supplier, id, qty);
  return id;
};
const watch = await prod('Montre connectée', 'Étanche, suivi du sommeil et du rythme cardiaque', 60000, 'wallindirain', 40);
const lamp = await prod('Lampe solaire rechargeable', 'Idéale pour les coupures de courant', 35000, 'supplier', 60);
await call('fn_seller_set_price', U.seller, watch, 150000).catch(() => {});
await call('fn_seller_set_price', U.seller, lamp, 95000).catch(() => {});
const link = await call('fn_seller_create_link', U.seller, watch);
if (!(await db.query('SELECT 1 FROM orders LIMIT 1')).rows.length) {
  await call('fn_admin_deposit', admin, U.seller, 400000, 'OM-DEMO-001');
  const mk = (p, n, ph, c) => call('fn_seller_create_order', U.seller, p, null, null, n, 'Client Démo', ph, c, 'Kipé, près de la pharmacie centrale', null);
  for (let i = 0; i < 4; i++) await mk(watch, 1, `62200000${i}`, ['Ratoma', 'Kaloum', 'Matoto', 'Dixinn'][i]);
  const o5 = await mk(lamp, 2, '622000005', 'Matam');
  await call('fn_seller_create_order', U.seller, null, 'Sac artisanal', 60000, 1, 'Mariama Sow', '622000006', 'Ratoma', 'Taouyah', null);
  const first = (await db.query(`SELECT id FROM orders ORDER BY created_at LIMIT 1`)).rows[0].id;
  await call('fn_agent_take_order', U.agent, first); await call('fn_agent_log_call', U.agent, first, 'confirmed', 'Adresse confirmée');
  await call('fn_chief_assign', U.chief, first, U.courier);
}
console.log(`Démo prête. Connexion (mot de passe Demo12345) :
  Admin 620000001 · Agent 620000002 · Chef 620000004 · Livreur 620000005 · Magasinier 620000007 · Fournisseur 620000008 · Vendeur 620000009
  Lien client : /#/c/${link}`);
await db.end();
