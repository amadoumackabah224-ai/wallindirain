# Guide du développeur

## Principes à respecter

1. **Toute règle métier et tout mouvement d'argent vit dans une fonction SQL.** Ne contournez jamais cette règle depuis Node.js (pas d'`UPDATE` ni d'`INSERT` direct dans les routes, sauf scripts d'administration comme `create-admin.js`).
2. **Jamais de SQL construit par concaténation de texte.** Valeurs toujours passées en paramètres `$1, $2…`.
3. **Ne modifiez jamais une migration déjà déployée.** Ajoutez un nouveau fichier numéroté.
4. **Tout nouveau comportement a un test** qui s'exécute sur une vraie base PostgreSQL.
5. **Les montants sont des entiers en GNF.**

## Environnement de développement

Node.js ≥ 20 et PostgreSQL ≥ 15 (testé en 16). Aucun `npm install` n'est nécessaire.

```bash
cd backend
export DB_OWNER_USER=postgres DB_OWNER_PASSWORD=... DB_APP_PASSWORD=dev-password DB_NAME=wallindirain_dev
createdb wallindirain_dev
node src/migrate.js && node src/seed-demo.js
node src/server.js                       # http://127.0.0.1:3000 ; comptes de démonstration : voir la sortie de seed-demo
```

Comptes de démonstration (mot de passe `Demo12345`) : admin `620000001`, agent `620000002`, chef `620000004`, livreur `620000005`, magasinier `620000007`, fournisseur `620000008`, vendeur `620000009`.

## Tests

```bash
cd backend
TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=5432 TEST_DB_USER=postgres TEST_DB_PASSWORD=... npm test
```

- `tests/rules.test.js` : règles métier appelées directement en SQL (prix, stock, appels, livraison, caisse, retours, retraits, intégrité, cohérence comptable).
- `tests/api.test.js` : démarre le vrai serveur HTTP et teste cookies, CSRF, rôles, cloisonnement, injection SQL, limitation de débit.
- `tests/sql/*.sql` : scénarios en SQL pur, exécutables avec `psql -f` sur une base migrée (voir `tests/db-reset.sh`).
- `tests/helpers.js` : `freshDb`, `world` (crée un compte par rôle), `approvedProduct`, `deliver`…

Les tests **détruisent et recréent** leurs bases : n'utilisez jamais les identifiants d'un serveur de production.

## Cookbook : ajouter une fonctionnalité

### Exemple : un nouveau réglage « frais de stockage »
1. `INSERT INTO settings(key, value, label) …` dans une nouvelle migration `005_….sql` (valeur par défaut 0).
2. Lire la valeur avec `_setting('cle')` dans la fonction concernée ; si elle doit être figée dans les commandes, ajouter une colonne à `orders`, la copier dans `_create_order` et l'ajouter à la liste de `trg_orders_frozen`.
3. Le réglage apparaît tout seul dans l'écran **Réglages** (qui liste la table `settings`) ; `fn_admin_set_setting` valide la valeur.
4. Test dans `rules.test.js`.

### Exemple : une nouvelle action pour un rôle
1. Migration : `CREATE FUNCTION fn_xxx(p_actor uuid, …)` avec `PERFORM _require(p_actor, ARRAY['role']::user_role[]);`, la règle, `_audit(…)` si l'action est sensible, puis droits (`SECURITY DEFINER SET search_path = public, pg_temp`, `REVOKE … FROM PUBLIC`, `GRANT EXECUTE … TO wld_app`).
2. Route dans `routes.js`, dans le bloc du rôle : `app.post('/api/…', guard(ROLES, async (ctx) => { … await fn('fn_xxx', ctx.user.id, v.uuid(…), …); return { ok: true }; }))`.
3. Écran dans `frontend/js/views/<role>.js` ; appel via `post('/…', {…})` de `js/api.js`.
4. Test API et test de règle.

### Exemple : un nouveau fournisseur de messages (SMS)
Dans `backend/src/messenger.js`, ajouter une clé à `PROVIDERS` (fonction `async ({ to, body, template }, cfg) => 'sent'`), ajouter la valeur acceptée dans `config.js` (`MESSAGE_PROVIDER`) et ses variables d'environnement.

### Exemple : retraits Orange Money / MTN MoMo automatiques
Le cycle actuel : `fn_withdrawal_confirm` débite le portefeuille et passe en `requested` ; l'administrateur paie à la main puis appelle `fn_admin_pay_withdrawal` avec la référence. Pour automatiser : appeler l'API de l'opérateur depuis un service qui lit les retraits `requested`, puis appelle `fn_admin_pay_withdrawal` (ou `fn_admin_reject_withdrawal` qui rembourse). Conserver la référence de transaction et rendre l'appel idempotent.

## Remplacer le client PostgreSQL maison par `pg` (optionnel)

`src/pg.js` expose `Pool` avec `query(text, params) → { rows }`, `tx(fn)`, `end()`. Le paquet `pg` expose la même forme. Installez `pg`, remplacez les imports `./pg.js`, et lancez la suite de tests : elle doit rester verte. Attention : `pg` renvoie les `bigint` en texte, alors que `pg.js` les convertit en nombres ; configurez `pg.types.setTypeParser(20, Number)`.

## Interface

- `js/main.js` : routage par hash (`#/login`, `#/app/<onglet>`, `#/c/<code>` page client publique) et barre de navigation selon le rôle.
- `js/ui.js` : helper `h(tag, attrs, …enfants)` pour construire le DOM **sans `innerHTML`** (protection XSS) ; composants (toasts, formulaires, montants GNF).
- Aucun `style=""` ni script en ligne (la politique de sécurité de contenu les bloquerait) : toute mise en forme passe par `css/app.css`.
- Couleurs : variables CSS en tête de `app.css` (bleu nuit, or, anthracite, blanc).
- Ajouter un écran : créer la vue dans `js/views/`, l'enregistrer dans la table des onglets du rôle dans `main.js`.

## Pièges connus

- Une exception SQL **annule toute la transaction** : une fonction qui doit mémoriser un échec (mauvais code de livraison, mauvais code de retrait) renvoie du `jsonb` au lieu de lever une erreur.
- Une commande « en route » dont le code est bloqué reste « en route » : le livreur doit signaler l'échec, puis le chef réaffecte (remet le compteur à zéro).
- Les verrous d'appel expirent après 15 minutes (tâche de fond `fn_release_stale_locks`).
- Une commande escaladée (5 appels injoignables) n'est reprise que par un chef.
