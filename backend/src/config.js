// Configuration : uniquement des variables d'environnement, aucun secret dans le code.
// Voir docs/INSTALLATION.md pour la liste complète.
const env = process.env;

function intVar(name, def) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Variable ${name} invalide : entier positif attendu`);
  return n;
}

export function loadConfig() {
  const prod = env.NODE_ENV === 'production';
  // Hébergeurs gérés (Neon, Render…) : une seule adresse DATABASE_URL (postgres://utilisateur:motdepasse@hôte/base).
  // Elle décrit le compte PROPRIÉTAIRE ; le compte applicatif wld_app est créé par les migrations.
  let fromUrl = null;
  if (env.DATABASE_URL) {
    let u;
    try { u = new URL(env.DATABASE_URL); } catch { throw new Error('Configuration invalide : DATABASE_URL n\'est pas une adresse valide'); }
    if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error('Configuration invalide : DATABASE_URL doit commencer par postgres://');
    fromUrl = {
      host: u.hostname, port: Number(u.port) || 5432, database: decodeURIComponent(u.pathname.slice(1)),
      user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
      ssl: u.searchParams.get('sslmode') !== 'disable' && !['127.0.0.1', 'localhost', 'db'].includes(u.hostname),
    };
  }
  const base = fromUrl
    ? { host: fromUrl.host, port: fromUrl.port, database: fromUrl.database, ssl: fromUrl.ssl }
    : {
      host: env.DB_HOST || '127.0.0.1',
      port: intVar('DB_PORT', 5432),
      database: env.DB_NAME || 'wallindirain',
      // 'true' pour exiger TLS vers PostgreSQL (recommandé hors du même serveur)
      ssl: env.DB_SSL === 'true' ? true : false,
    };
  const cfg = {
    prod,
    port: intVar('PORT', 3000),
    host: env.HOST || '127.0.0.1',
    contactPhone: env.CONTACT_PHONE || '624390707',
    // vrai uniquement derrière un proxy de confiance (Caddy) qui renseigne X-Forwarded-For
    trustProxy: env.TRUST_PROXY === '1',
    // compte applicatif : n'a le droit que d'appeler les fonctions fn_* et rd_*
    db: { ...base, user: env.DB_APP_USER || 'wld_app', password: env.DB_APP_PASSWORD || '', max: intVar('DB_POOL_MAX', 10) },
    // compte propriétaire : migrations et création du premier administrateur uniquement
    owner: { ...base, user: fromUrl ? fromUrl.user : (env.DB_OWNER_USER || 'postgres'), password: fromUrl ? fromUrl.password : (env.DB_OWNER_PASSWORD || '') },
    // TEST uniquement : montre les codes (livraison, retrait, mot de passe) dans l'écran « Messages » de l'administrateur,
    // puisque rien n'est réellement envoyé. Refusé dès qu'un vrai fournisseur de messages est configuré.
    showTestCodes: env.SHOW_TEST_CODES === '1',
    messaging: {
      provider: env.MESSAGE_PROVIDER || 'simulated', // simulated | whatsapp
      whatsappToken: env.WHATSAPP_TOKEN || '',
      whatsappPhoneId: env.WHATSAPP_PHONE_ID || '',
    },
  };
  const problems = [];
  if (!['simulated', 'whatsapp'].includes(cfg.messaging.provider)) problems.push('MESSAGE_PROVIDER doit valoir simulated ou whatsapp');
  if (cfg.messaging.provider === 'whatsapp' && (!cfg.messaging.whatsappToken || !cfg.messaging.whatsappPhoneId)) {
    problems.push('WHATSAPP_TOKEN et WHATSAPP_PHONE_ID sont obligatoires avec MESSAGE_PROVIDER=whatsapp');
  }
  if (cfg.showTestCodes && cfg.messaging.provider !== 'simulated') problems.push('SHOW_TEST_CODES=1 est réservé à MESSAGE_PROVIDER=simulated (mode test)');
  if (prod && !cfg.db.password) problems.push('DB_APP_PASSWORD est obligatoire en production');
  if (!/^[0-9]{9}$/.test(cfg.contactPhone)) problems.push('CONTACT_PHONE doit contenir 9 chiffres');
  if (problems.length) throw new Error('Configuration invalide :\n - ' + problems.join('\n - '));
  return cfg;
}
