# Migration 045 : tableau argent du vendeur (module Finances)

## Ce que ça fait
Une section « Tableau argent » en haut du **Portefeuille**, réservée aux vendeurs (les autres rôles ne voient aucun changement).
- **Argent à venir** à 30, 60 et 90 jours : *Sûr* (solde disponible, moins les retraits réservés, plus les gains bloqués qui se débloquent avant l'échéance, moins les dépenses récurrentes), puis *Prudent / Probable / Favorable* en ajoutant une estimation des commandes déjà en cours.
- **Estimation** = commandes en cours × gain moyen par livraison (90 derniers jours) × taux de livraison. Taux central : le taux réel du vendeur (si au moins 10 commandes terminées), sinon 60 %, sinon celui que le vendeur règle lui-même (5 à 100 %). Prudent = taux − 15 points ; Favorable = taux + 10 points.
- **Aucune vente future n'est devinée.** L'écran le dit.
- **Dépenses récurrentes** (jour, semaine, mois ; 30 au plus) : rien n'est débité, ce sont des repères. L'encart « À payer bientôt » montre la prochaine échéance de chaque dépense dans les 7 jours.
- **Budget du mois** par catégorie (publicité, marchandise, transport, autre). Le « réel » vient des dépenses saisies dans « Mon bénéfice ».
- **Objectif de gains du mois** : avancement, jours restants, nombre approximatif de livraisons qui manquent.
- **Alerte publicité** : si la publicité par livraison dépasse le gain moyen par livraison (30 derniers jours).

## Ce que ça ne fait pas
- Aucun montant de la plateforme n'est touché : ni portefeuille, ni frais, ni marge, ni tarif, ni part du livreur. Test dédié : aucune écriture de portefeuille créée ou modifiée.
- Pas de connexion bancaire. Pas de rappel dans les notifications pour l'instant (l'encart « À payer bientôt » s'affiche à l'ouverture du Portefeuille).
- La prévision est une estimation, pas une promesse.

## À la mise en production
- Migration : 4 tables (`finance_recurring`, `finance_budgets`, `finance_goals`, `finance_prefs`), 5 fonctions `fn_seller_finance_*`, une fonction interne `_finance_feature_on`, un déclencheur d'anonymisation (supprime les données d'un compte anonymisé), le réglage `feature_finances`. Aucune table ni fonction existante modifiée.
- **Éteint par défaut** (`feature_finances` = 0) : la section n'apparaît pas. Pour l'allumer : réglage `feature_finances` = 1 (écran admin des réglages).
- Chaque ligne porte un propriétaire (`owner_id`), aujourd'hui le compte vendeur, pour préparer le passage à des organisations (voir la feuille de route SaaS).

## Points restant à décider
1. Les écarts Prudent / Favorable (−15 / +10 points) et le taux par défaut (60 %) sont des choix de départ à ajuster après les premiers retours de vendeurs.
2. Rappels d'échéance dans les notifications (cloche) : possible dans une prochaine étape.
3. Export CSV de la prévision : non fait.

## Retour arrière
`docs/retour-arriere-045.sql` : refuse s'il existe des données de finances ou si `feature_finances` n'est pas à 0. À appliquer avant celui de la 044.
