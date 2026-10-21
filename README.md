# Wallindirain

Plateforme guinéenne de vente avec **paiement à la livraison** : fournisseurs, vendeurs, call center, livreurs, magasinier et administration, avec portefeuilles, caisses et retraits. Référence fonctionnelle : `docs/cahier-des-charges-v2.pdf` (version 2.0, 12 octobre 2026).

- Contact affiché dans l'application : **624390707** (réglable : variable `CONTACT_PHONE`)
- Identité visuelle : bleu nuit `#0B1B3B`, or `#D4AF37`, gris anthracite `#1F1F1F`, blanc `#F5F5F5` (`docs/logo-charte.png`)

## En bref

| Élément | Choix |
|---|---|
| Serveur | Node.js 20+ (module ES), **aucune dépendance npm** : tout le code est dans ce dépôt |
| Base de données | PostgreSQL 16, règles métier et contrôles d'intégrité **dans la base** |
| Interface | JavaScript natif (modules ES), sans étape de compilation, adaptée au téléphone |
| Déploiement | Docker Compose : base, application, HTTPS automatique (Caddy), sauvegardes quotidiennes |

## Où trouver quoi

| Je veux… | Je lis… |
|---|---|
| Mettre l'application en ligne | `docs/INSTALLATION.md` |
| Comprendre comment c'est construit | `docs/ARCHITECTURE.md` |
| Modifier ou ajouter une fonctionnalité | `docs/DEVELOPER-GUIDE.md` |
| Connaître les tables et les règles de la base | `docs/DATABASE.md` |
| Appeler l'API | `docs/API.md` |
| Vérifier la sécurité | `docs/SECURITY.md` |
| Former les équipes | `docs/USER-GUIDE.md` |
| Voir ce qui est fait, testé, hypothétique ou à faire | `docs/CAHIER-DES-CHARGES-TRACABILITE.md` |
| Données personnelles, pages légales, accessibilité | `docs/CONFORMITE-DONNEES.md` |

## Démarrage rapide pour développer (sans Docker)

```bash
# 1. PostgreSQL 16 doit tourner et vous devez disposer d'un compte propriétaire (ex. postgres)
createdb wallindirain

# 2. Variables (voir docs/INSTALLATION.md pour la liste complète)
export DB_OWNER_USER=postgres DB_OWNER_PASSWORD=...  DB_APP_PASSWORD=un-mot-de-passe-fort
cd backend
node src/migrate.js                # crée les tables, fonctions et droits
node src/seed-demo.js              # données de démonstration (mot de passe de tous les comptes : Demo12345)
node src/server.js                 # http://127.0.0.1:3000
```

Production : **ne jamais** lancer `seed-demo.js` (il refuse de s'exécuter si `NODE_ENV=production`). Créez le premier administrateur avec `ADMIN_PHONE=… ADMIN_NAME=… ADMIN_PASSWORD=… node src/create-admin.js`.

## Tests

```bash
cd backend
TEST_DB_HOST=/chemin/socket-ou-hote TEST_DB_PORT=5432 TEST_DB_USER=postgres npm test      # 69 tests, vraie base PostgreSQL
sh ../ops/restore-test.sh                                                                  # test de restauration (critère 8)
```

Les tests créent et détruisent leurs propres bases (`wld_api`, `wld_rules`, …) : ne les pointez jamais vers une base de production.

## Organisation du dépôt

```
backend/
  migrations/   001 schéma · 002 comptes et catalogue · 003 commandes, appels, livraison, caisse, retours, retraits · 004 droits
  src/          server.js · routes.js · http.js · security.js · config.js · pg.js (client PostgreSQL) · messenger.js · migrate.js …
  tests/        tests d'API (HTTP) et de règles métier, plus tests/sql (scénarios directement en SQL)
frontend/       index.html · css/app.css · js/ (main, api, ui, views/ par rôle) · assets/ (logo et icônes)
ops/            Dockerfile · docker-compose.yml · Caddyfile · .env.example · backup.sh · restore.sh · restore-test.sh
docs/           toute la documentation + cahier des charges et charte graphique
```
