# Migration 049 : « Plan financier » de Mes finances (pour tous les rôles)

## Ce que ça fait
- **Prévision à 30 jours** : solde prévu = solde actuel + revenus attendus − dépenses prévues, d'après les récurrents.
- **Objectif du mois** : ce que la personne veut mettre de côté (revenus − dépenses du mois), avec barre de progression.
- **Budgets du mois** par catégorie de dépense, avec le dépensé du mois ; la barre devient rouge au dépassement.
- **Revenus et dépenses récurrents** (chaque jour, semaine ou mois ; jour 1 à 28 pour le mensuel ; 30 au plus). Ils servent à la prévision : **rien n'est débité ni noté automatiquement**, la personne note la vraie transaction.
- **Paramètres** (Plus → Paramètres) : accès direct aux jauges, comptes, budgets et objectif, récurrents, formule.
- Les anciens outils du vendeur (Tableau argent, Mes clients, Relances) ne sont pas modifiés.

## Règles contrôlées par la base
- Fonction éteinte : rien n'est possible. Chacun ne voit et ne modifie que ses données.
- **Pro requis** pour créer ou modifier budgets, objectif, récurrents (erreur `pro_required`). Sans Pro, les données restent visibles et un récurrent peut toujours être arrêté. Tant que `pf_price_monthly` = 0, tout le monde est Pro.
- Montants, catégories, noms, dates et fréquences validés ; 30 récurrents actifs au plus.
- Compte anonymisé : budgets, objectif et récurrents effacés.

## Ce que ça ne fait pas
Aucune écriture du portefeuille, aucun frais ni marge touché. Aucun nouveau réglage. Aucune table ni fonction existante modifiée.

## À la mise en production
3 tables (`pf_budgets`, `pf_goals`, `pf_recurring`), fonctions `fn_pf_budget_set`, `fn_pf_goal_set`, `fn_pf_recurring_save`, `fn_pf_recurring_stop`, `_pf_pro`, un déclencheur. Suit l'interrupteur « Mes finances » (éteint par défaut).
Retour arrière : `docs/retour-arriere-049.sql` (refuse s'il existe des données ; à appliquer avant celui de la 048).

## Étapes suivantes
Contacts (fiche unique, prospects, import de fichier, étiquettes, notes, appel/SMS/WhatsApp), puis règles automatiques et export (Pro).
