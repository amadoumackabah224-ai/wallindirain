# API HTTP

Base : `/api`. Format : JSON (UTF-8). Les champs exacts de chaque route sont validés en tête de la route correspondante dans `backend/src/routes.js` (fonctions `v.str`, `v.int`, `v.uuid`, `v.phone`, `v.oneOf`…) : le code fait foi.

## Règles communes

- **Authentification** : cookie `wld_session` (HttpOnly, SameSite=Strict, Secure en production), posé par `POST /api/auth/login`. Durée 12 h.
- **Protection CSRF** : toute requête autre que GET doit porter l'en-tête `X-WLD: 1` ; si un en-tête `Origin` est présent, il doit correspondre à l'hôte du serveur.
- **Erreurs** : `{ "error": "code", "message": "Texte en français" }` avec un statut HTTP : 400 entrée invalide, 401 non connecté, 403 interdit, 404 introuvable, 409 conflit d'état (ex. `already_taken`, `duplicate_order`), 413 corps trop gros (> 64 Ko), 423 compte bloqué, 429 trop de requêtes, 500 erreur interne (jamais de détail technique renvoyé).
- **Téléphones** : 9 chiffres (`624390707`) ; `+224` et espaces acceptés en entrée.
- **Montants** : entiers en GNF.

## Public (sans connexion)

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/public/info` | numéro de contact, communes et tarifs (sert aussi de contrôle de santé) |
| GET | `/public/link/:code` | produit, prix et disponibilité d'un lien vendeur (sans nom de vendeur ni de fournisseur) |
| POST | `/public/link/:code/order` | commande d'un client : `qty, name, phone, commune, address` |
| POST | `/auth/register` | inscription vendeur ou fournisseur : `role, name, phone, password, identity_doc` (compte en attente de validation) |
| POST | `/auth/login` | `phone, password` |
| POST | `/auth/forgot`, `/auth/reset` | code par message (15 min, un seul usage), puis nouveau mot de passe |

## Connecté (tous rôles)

`POST /auth/logout`, `GET /auth/me`.
**Portefeuille** (vendeur, fournisseur, agent, chef, livreur) : `GET /wallet`, `POST /withdrawals` (`amount, method, account`), `POST /withdrawals/:id/confirm` (`code` à 6 chiffres).

## Par rôle

| Rôle | Routes |
|---|---|
| **Fournisseur** | `GET/POST /supplier/products`, `POST /supplier/products/:id/arrival`, `POST /supplier/products/:id/stock`, `GET /supplier/orders` |
| **Vendeur** | `GET /seller/catalog`, `POST /seller/prices`, `POST /seller/links`, `POST /seller/stock` (achat de stock), `POST /seller/orders`, `GET /seller/orders`, `GET /seller/orders/:id` (appels et historique), `POST /seller/orders/:id/cancel` |
| **Agent / chef** | `GET /calls/queue`, `GET /calls/mine`, `POST /calls/:id/take`, `POST /calls/:id/log` (`result` = `confirmed`/`unreachable`/`refused`, `note`) |
| **Chef (et admin)** | `GET /chief/orders`, `POST /chief/orders/:id/assign`, `…/return`, `…/cancel` |
| **Livreur** | `GET /courier/orders`, `POST /courier/orders/:id/pickup`, `…/depart`, `…/deliver` (`code` à 4 chiffres), `…/fail` (`reason`) |
| **Magasinier (et admin)** | `GET /warehouse/arrivals`, `POST /warehouse/arrivals/:id/count`, `POST /warehouse/returns/:id` (`cause`) |
| **Administrateur** | `GET /admin/dashboard`, `GET/POST /admin/users`, `POST /admin/users/:id/status`, `POST /admin/users/:id/verify`, `GET /admin/products`, `POST /admin/products/:id/review`, `POST /admin/products/:id/margin`, `GET /admin/orders`, `GET /admin/orders/:id`, `POST /admin/orders/:id/cancel`, `POST /admin/deposits`, `GET /admin/cash`, `POST /admin/cash/:courierId`, `GET /admin/withdrawals`, `POST /admin/withdrawals/:id/pay`, `…/reject`, `GET/POST /admin/settings`, `POST /admin/rates`, `GET /admin/audit`, `GET /admin/messages` |

Chaque route de rôle est protégée côté serveur (`guard`) **et** à nouveau dans la fonction SQL appelée (`_require`) : un défaut dans l'un des deux ne suffit pas à contourner les droits.

## Ce que chaque rôle ne voit jamais (testé)

- **Fournisseur** : ni vendeur, ni client, ni prix de vente (il voit référence `WLD-n`, produit, quantité, montant qui lui est dû).
- **Vendeur** : ni fournisseur, ni prix fournisseur (il voit le « prix vendeur » = prix fournisseur + marge).
- **Agent** : ni gains, ni prix fournisseur. **Livreur** : ni prix fournisseur, ni gains du vendeur, ni le code de livraison. **Magasinier** : aucune donnée financière.
- Le texte des messages (qui contient des codes à usage unique) n'est jamais renvoyé par l'API, et il est masqué dans l'écran d'administration.
