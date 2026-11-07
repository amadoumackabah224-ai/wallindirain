# Migration 048 : « Mes finances », gestion financière personnelle pour tous les rôles

## Ce que ça fait
- **Un outil plein écran, sombre, à 5 onglets** (Tableau de bord · Plan financier · Contacts · Statistiques · Plus), ouvert depuis l'entrée « Mes finances » du menu de chaque rôle (vendeur, fournisseur, agent, chef d'appel, livreur, magasinier, administrateur).
- **Comptes personnels** (espèces, mobile money, banque, épargne, autre) : autant que la formule le permet, avec nom, type, couleur et solde de départ. Archivage possible, rien n'est supprimé.
- **Transactions** : revenus, dépenses (10 catégories de dépense, 4 de revenu), virements entre ses comptes (qui ne changent ni revenus ni dépenses). Modifier, supprimer (annulée, conservée), recherche, filtres.
- **Tableau de bord** : trois jauges (Revenus, Flux de trésorerie, Solde) avec aiguille, courbe d'évolution du solde, comptes, flux, dernières transactions. Les objectifs qui placent les jauges se règlent dans Plus → Paramètres → Paramètres des jauges.
- **Statistiques** : résumé, dépenses et revenus par catégorie, courbe.
- **Compte « Wallindirain »** : le vrai portefeuille de la personne, en **lecture seule**, affiché à part. Il n'entre pas dans le solde ni dans les flux (pas de double comptage).
- **Formule gratuite / Pro** : gratuit = 2 comptes, 90 jours d'historique visibles, 30 jours de tableau de bord. Pro = comptes illimités, historique complet, statistiques sur 90 jours et 1 an. Un essai Pro démarre à la première utilisation.
- **Abonnement** : mensuel ou annuel, prélevé sur le portefeuille Wallindirain de la personne (écriture de type `pf_subscription`, séparée de l'abonnement vendeur), ou accordé / encaissé hors plateforme par l'administrateur (raison obligatoire, journalisée).
- **Administration** : Réglages → Fonctions (interrupteur) et Réglages → Mes finances (prix mensuel et annuel, jours d'essai, limites du gratuit, liste des personnes et bouton « Offrir / encaisser »).

## Règles contrôlées par la base (pas seulement par l'écran)
- Fonction éteinte : aucune action possible. Chaque personne ne voit et ne modifie que ses propres données.
- Limites de la formule gratuite (nombre de comptes, comptes en lecture seule au-delà, historique visible).
- Dates, montants, catégories, noms valides. Virement uniquement entre deux de ses comptes.
- Les tables ne sont pas modifiables directement par l'application, seulement par les fonctions de la base.

## Ce que ça ne fait pas
- Aucune écriture du portefeuille de la plateforme, aucun frais, marge, tarif ou part du livreur n'est touché, sauf l'abonnement lui-même.
- Pas de connexion bancaire, pas de lecture des SMS Orange Money. Saisie manuelle uniquement (le champ « origine » des transactions prépare l'import et la synchronisation pour plus tard).
- Une fois un abonnement terminé, rien n'est supprimé : retour à la formule gratuite.

## À la mise en production
- Migration : 4 tables (`pf_accounts`, `pf_transactions`, `pf_access`, `pf_prefs`), fonctions `fn_pf_*` et `fn_admin_pf_grant`, un déclencheur d'anonymisation, 6 réglages (`feature_finances_perso`, `pf_price_monthly`, `pf_price_yearly`, `pf_trial_days`, `pf_free_accounts`, `pf_free_history_days`). Aucune table ni fonction existante modifiée.
- **Éteint par défaut.** Tant que `pf_price_monthly` = 0, tout le monde a toutes les fonctions (pas de paiement). Fixez les prix en GNF dans Réglages → Mes finances quand vous êtes prêt.
- Les écrans Plan financier et Contacts renvoient pour l'instant vers les outils existants du vendeur (Tableau argent, Mes clients, Relances) ; ils sont refaits dans les prochaines étapes.

## Points restant à décider
1. Prix mensuel et annuel (en GNF), jours d'essai, limites du gratuit : valeurs de départ à ajuster avec les premiers retours.
2. Faire relire par un juriste les conditions sur les données personnelles avant l'ouverture au public.
3. Étapes suivantes : Plan financier (budgets, récurrents, objectifs pour tous), CRM Contacts, règles automatiques, export, paiement mobile money.

## Retour arrière
`docs/retour-arriere-048.sql` : refuse s'il existe des données de Mes finances ou si la fonction est allumée. À appliquer avant celui de la 047.
