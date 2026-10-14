# Architecture

## Vue d'ensemble

```
Navigateur ──HTTPS──▶ Caddy ──▶ Application Node.js ──▶ PostgreSQL 16
(interface JS)        (certificat)  (API JSON + fichiers statiques)   (règles métier + intégrité)
                                         │
                                         └─ tâche de fond : envoi des messages, libération des verrous d'appel
```

Principe directeur : **les règles qui touchent à l'argent, aux stocks et aux droits sont dans la base de données**, sous forme de fonctions SQL. L'application Node.js ne fait que authentifier, valider les entrées et appeler ces fonctions. Conséquence : même si le code serveur contenait un défaut, la base refuserait une opération contraire aux règles (prix sous le minimum, livraison sans code, retrait sans identité vérifiée, modification d'un montant déjà figé…).

## Les trois couches

### 1. PostgreSQL (`backend/migrations/`)
- **Tables** : comptes, catalogue, commandes, portefeuille, retraits, caisses, journal. Détail dans `DATABASE.md`.
- **Fonctions `fn_*`** : seul moyen d'écrire. Chacune vérifie le rôle de l'appelant (`_require`), applique la règle, écrit dans le journal. Une erreur métier est levée avec le code SQLSTATE `WLD01` et un message `code|Texte en français`.
- **Triggers** : portefeuille, historique des statuts, appels, journal et caisses sont en **ajout seul** (UPDATE/DELETE interdits) ; les montants d'une commande sont figés après création ; pas de suppression physique des comptes, produits, commandes, retraits.
- **Droits** : l'application se connecte avec `wld_app`, qui ne peut qu'exécuter les fonctions publiées et lire des colonnes limitées (jamais les mots de passe, codes de livraison, codes à usage unique ni sessions).

### 2. Serveur Node.js (`backend/src/`)
| Fichier | Rôle |
|---|---|
| `server.js` | assemble pool, application HTTP, routes, tâche de fond ; point d'entrée |
| `http.js` | routeur minimal, lecture du corps JSON (taille limitée), fichiers statiques sûrs, erreurs, validation (`v.*`) |
| `routes.js` | toutes les routes `/api/*`, groupées par rôle, avec garde de rôle (`guard`) |
| `security.js` | PBKDF2, jetons de session, limiteur de débit, cookies, en-têtes de sécurité |
| `pg.js` | client PostgreSQL maison (protocole v3, requêtes paramétrées, SCRAM-SHA-256, TLS) |
| `messenger.js` | file d'envoi des messages et fournisseurs (simulé, WhatsApp) ; libération des verrous d'appel périmés |
| `config.js` | lecture des variables d'environnement |
| `migrate.js` | applique les migrations dans l'ordre, une fois chacune |
| `create-admin.js`, `seed-demo.js` | création du premier administrateur ; données de démonstration |

**Pourquoi un client PostgreSQL maison (`pg.js`) et zéro dépendance ?** Moins de code tiers = moins de risque de chaîne d'approvisionnement, et aucune installation npm à faire. Le choix a un coût : ce client couvre ce dont l'application a besoin (requêtes paramétrées, transactions, SCRAM, TLS) mais n'est pas aussi éprouvé que le paquet `pg`. Voir `DEVELOPER-GUIDE.md` pour le remplacer si l'équipe le souhaite.

### 3. Interface (`frontend/`)
Application monopage en modules ES natifs, sans compilation : `js/main.js` (routage par `#/…`), `js/api.js` (appels), `js/ui.js` (composants), `js/views/*.js` (une vue par rôle : `seller`, `supplier`, `calls`, `courier`, `warehouse`, `admin`, `wallet`, `auth`). Aucun script ni style en ligne, ce qui permet une politique de sécurité de contenu stricte. Mobile d'abord (navigation en bas pour vendeur, agent, livreur).

## Flux d'une commande (formule A, de bout en bout)

1. Le client ouvre le lien du vendeur (`/#/c/<code>`) et commande → `fn_public_order` fige prix, frais et code de livraison, réserve le stock.
2. Un agent prend la commande (`fn_agent_take_order`, verrou) puis consigne l'appel (`fn_agent_log_call`). À la confirmation, le code à 4 chiffres part au client par message et la rémunération de l'agent est créditée.
3. Le chef affecte un livreur (`fn_chief_assign`) ; le livreur récupère (`fn_courier_pickup`), part (`fn_courier_depart`), puis livre avec le code (`fn_courier_deliver`, 5 essais).
4. À la livraison, `_settle_delivery` répartit l'argent (fournisseur, vendeur, Wallindirain, livreur), contrôle que le total est exact, et crée l'entrée de caisse du livreur. Les gains se débloquent 48 h plus tard.
5. L'administrateur compte la caisse (`fn_admin_count_cash`) ; tout manque est débité au livreur.

En cas d'échec : le livreur signale, le chef réaffecte ou renvoie en entrepôt, le magasinier saisit la cause (`fn_warehouse_receive_return`) qui décide qui paie.

## Concurrence

- Deux agents sur une même commande : `UPDATE … WHERE` conditionnel, le verrou de ligne départage ; le perdant reçoit `already_taken`.
- Ventes simultanées d'un dernier article : réservation de stock sous verrou de ligne (`FOR UPDATE`) ; jamais de survente (testé).
- Retraits et achats de stock : verrou consultatif par portefeuille, pour qu'un solde ne soit jamais dépensé deux fois.
- Envoi des messages : `FOR UPDATE SKIP LOCKED` dans une transaction, plusieurs instances ne se marchent pas dessus.
