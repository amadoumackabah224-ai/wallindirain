// Utilitaires de test : base vierge + comptes de chaque rôle.
import { Pool } from '../src/pg.js';
import { migrate } from '../src/migrate.js';

export const TEST_DB = {
  host: process.env.TEST_DB_HOST || '/tmp/pgsock',
  port: Number(process.env.TEST_DB_PORT || 54329),
  user: process.env.TEST_DB_USER || 'postgres',
  password: process.env.TEST_DB_PASSWORD || ''
};
export const APP_PW = 'test-app-password';

export async function freshDb(name) {
  const admin = new Pool({ ...TEST_DB, database: 'postgres' });
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const owner = { ...TEST_DB, database: name };
  await migrate(owner, APP_PW, () => {});
  return { owner: new Pool(owner), app: new Pool({ ...owner, user: 'wld_app', password: APP_PW }) };
}

/** Appelle une fonction SQL fn_* et renvoie sa valeur ; lève { code, message } pour une erreur métier. */
export async function call(pool, fn, ...args) {
  const ph = args.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await pool.query(`SELECT ${fn}(${ph}) AS r`, args);
  return rows[0].r;
}

export async function expectErr(promise, code) {
  try { await promise; } catch (e) {
    const got = (e.message || '').split('|')[0];
    if (got !== code) throw new Error(`Erreur attendue "${code}", reçue "${got}" (${e.message})`);
    return;
  }
  throw new Error(`Erreur "${code}" attendue, mais l'appel a réussi`);
}

let n = 100000000;
const phone = () => String(++n);

/** Crée tous les rôles et un produit approuvé en stock. */
export async function world(db) {
  const { owner, app } = db;
  const id = async (q, p) => (await owner.query(q, p)).rows[0].id;
  const admin = await id(`INSERT INTO users(role,status,full_name,phone,password_hash,identity_verified) VALUES ('admin','active','Admin Test',$1,'x',true) RETURNING id`, [phone()]);
  const w = { admin };
  for (const [key, role, team] of [['agent1','agent','Alpha'],['agent2','agent','Alpha'],['chief','call_chief','Alpha'],['courier','courier',null],['courier2','courier',null],['warehouse','warehouse',null]]) {
    w[key] = await call(app, 'fn_admin_create_staff', admin, phone(), key, role, 'x', team);
  }
  w.supplier = await call(app, 'fn_register', phone(), 'Fournisseur Un', 'supplier', 'x', 'CNI-123456');
  await call(app, 'fn_admin_set_user_status', admin, w.supplier, 'active');
  w.seller = await call(app, 'fn_register', phone(), 'Vendeur Un', 'seller', 'x', 'CNI-654321');
  w.seller2 = await call(app, 'fn_register', phone(), 'Vendeur Deux', 'seller', 'x', 'CNI-777777');
  return w;
}

export async function approvedProduct(db, w, { price = 60000, storage = 'wallindirain', qty = 10 } = {}) {
  const { app } = db;
  const product = await call(app, 'fn_supplier_add_product', w.supplier, 'Montre connectée', 'Étanche', price, storage, 0);
  await call(app, 'fn_admin_review_product', w.admin, product, true, null);
  if (storage === 'wallindirain') {
    const arrival = await call(app, 'fn_supplier_announce_arrival', w.supplier, product, qty);
    await call(app, 'fn_warehouse_count_arrival', w.warehouse, arrival, qty);
  } else {
    await call(app, 'fn_supplier_set_stock', w.supplier, product, qty);
  }
  return product;
}

export async function codeOf(db, orderRef) {
  const { rows } = await db.app.query(`SELECT body FROM messages WHERE template='delivery_code' AND body LIKE $1 ORDER BY id DESC LIMIT 1`, [`%${orderRef}%`]);
  return /Code de livraison : (\d{4})/.exec(rows[0].body)[1];
}

export async function deliver(db, w, orderId, ref, courier = w.courier) {
  const { app } = db;
  await call(app, 'fn_agent_take_order', w.agent1, orderId);
  await call(app, 'fn_agent_log_call', w.agent1, orderId, 'confirmed', 'OK');
  await call(app, 'fn_chief_assign', w.chief, orderId, courier);
  await call(app, 'fn_courier_pickup', courier, orderId);
  await call(app, 'fn_courier_depart', courier, orderId);
  return call(app, 'fn_courier_deliver', courier, orderId, await codeOf(db, ref));
}
