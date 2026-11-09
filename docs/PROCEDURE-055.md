# Migration 055 : réglages de Mes finances (général, tableau de bord, jauges)

## Ce que ça fait
Un écran **Paramètres → Général, tableau de bord et jauges** (aussi accessible par l'icône de réglages du tableau de bord). Tout est personnel et facultatif : sans réglage, rien ne change.
- **Décimales** : affiche les montants avec deux décimales (désactivé par défaut). Le franc guinéen n'a pas de centimes ; l'option prendra tout son sens avec les autres devises (étape suivante).
- **Période par défaut** : Aujourd'hui, Cette semaine, Ce mois-ci, Cette année, 7 jours, 30 jours, 12 semaines, 6 mois, 1 an. Sert au tableau de bord et aux statistiques ; la personne peut aussi changer de période en haut de chaque écran. La semaine commence le lundi ; « ce mois-ci » et « cette année » partent du 1er. Formule gratuite : limité à 30 jours (comme avant), la période plus longue est verrouillée avec un renvoi vers Pro.
- **Blocs du tableau de bord** : évolution du solde, comptes, flux de trésorerie, solde, dépenses, dépense principale, dernières transactions (gratuits) ; paiements planifiés, prévision de trésorerie, budget (Pro) ; taux de change (arrive avec les devises, non activable pour l'instant). Par défaut : les mêmes blocs qu'avant.
- **Seuils des jauges** : chaque jauge compare les **30 derniers jours aux 30 jours d'avant** (solde : maintenant et il y a 30 jours). Deux seuils réglables par jauge : « faible en dessous de » (rouge) et « élevé à partir de » (vert), 0,9 et 1,2 par défaut. Le rapport est affiché sous les jauges (×1,27). Revenus = revenus d'exploitation seulement : les financements et remboursements de prêt (catégories « hors exploitation ») sont exclus. Les objectifs fixes de l'ancien écran restent possibles (« Objectifs des jauges ») et remplacent la comparaison.

## À savoir
- Le calcul des aiguilles change légèrement par rapport à avant (avant : période affichée contre la précédente, et revenus contre objectif). Les valeurs affichées (revenus, flux, solde) ne changent pas.
- Le paramètre `days` de l'ancienne API reste accepté.

## À la mise en production
1 fonction (`fn_pf_settings_set`), 9 colonnes ajoutées à `pf_prefs` (valeurs par défaut, aucune donnée existante modifiée). Retour arrière : `docs/retour-arriere-055.sql` (refuse s'il existe des réglages personnalisés).
