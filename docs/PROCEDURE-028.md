# Migration 028 — Alertes automatiques dans la cloche

## Ce que ça fait
Le serveur lance toutes les 15 minutes une vérification qui écrit des **notifications** (celles de la 027), une seule fois par « période » (aucun doublon) :

| Alerte | Pour qui | Quand | Fréquence |
|---|---|---|---|
| **Stock bas** / **Rupture de stock** | le fournisseur | stock vendable ≤ réglage « stock bas » (5 par défaut), produit validé, stocké chez Wallindirain et déjà compté à l'entrepôt | 1 fois par semaine et par état (bas, puis rupture) |
| **Colis à récupérer** / **Colis non récupéré** | le livreur et les chefs d'équipe | colis affecté depuis plus de `pickup_alert_hours` (2 h) sans être récupéré | 1 fois par affectation |
| **Argent à reverser** | le livreur | argent encaissé depuis plus de 24 h, non reversé et sans reversement en attente de contrôle | 1 fois par jour tant que rien n'est reversé |
| **Numéro de versement manquant** | vendeur, fournisseur, livreur, agent, chef | compte de plus de 2 jours sans numéro Orange / MTN | 1 fois par semaine |

## Réglages (administrateur → Réglages)
- `alert_low_stock_qty` = 5 · `alert_cash_hours` = 24 · `alert_payout_days` = 2. **Mettre 0 désactive l'alerte.** `pickup_alert_hours` (013) pilote le colis non récupéré. Ce sont des seuils d'alerte : **aucun montant, tarif ni pourcentage n'est concerné**.

## Ce que ça NE fait PAS
- **Aucun calcul d'argent ni de stock n'est modifié** : la fonction lit l'état et écrit des notifications (testé : mêmes montants et mêmes stocks avant et après).
- Aucun envoi WhatsApp ou SMS (le rappel de colis par message de la 013 continue d'exister séparément).
- Une seule instance fait le travail à la fois (verrou en base).

## Mise en production (uniquement après autorisation)
**Cette branche contient la migration 027 si elle n'est pas déjà fusionnée. Render applique la migration automatiquement au démarrage, dès la fusion.**
1. Fusionner `feature/alertes-cloche`. Render applique la 028.
2. `SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 3;` → `028_alertes.sql` en premier.
3. `SELECT * FROM fn_ledger_check();` → 0 ligne.
4. Premier passage des alertes environ 2 minutes après le démarrage, puis toutes les 15 minutes : le journal du serveur affiche « alertes de la cloche » avec le nombre d'alertes créées.
5. Si trop d'alertes au premier passage (beaucoup de comptes sans numéro de versement, par exemple) : mettre le réglage correspondant à 0 dans Réglages.

## Retour arrière
`docs/retour-arriere-028.sql` (avant celui de la 027). Retire la fonction, la colonne anti-doublon et les 3 réglages ; les notifications déjà envoyées restent. Retirer aussi l'appel côté serveur (`src/messenger.js`).
