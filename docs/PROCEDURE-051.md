# Migration 051 : Mes finances reliées automatiquement au compte Wallindirain + montants masqués

## 1. Montants masqués (aucune migration)
- Bouton œil sur l'**Accueil**, le **Portefeuille** et **Mes finances** : les montants deviennent une barre. Le réglage se garde sur l'appareil.
- **Protection par mot de passe** (Profil → Sécurité, facultative) : à chaque ouverture les montants restent cachés ; pour les afficher il faut le mot de passe (valable 5 minutes, perdu en quittant l'écran). La désactiver demande aussi le mot de passe.
- Nouvelle route `POST /api/me/verify-password` : vérifie le mot de passe, ne change rien, 6 essais par 10 minutes.
- Limite à connaître : c'est une protection d'affichage (contre un regard par-dessus l'épaule, un téléphone prêté). Les chiffres restent chargés dans l'écran ; ce n'est pas un chiffrement.

## 2. Liaison automatique (migration 051, formule Pro)
- Une personne qui a un portefeuille Wallindirain (vendeur, fournisseur, agent, chef, livreur) peut **relier** son compte : Paramètres → Compte Wallindirain.
- Un compte « **Wallindirain** » apparaît, en lecture seule. Gains de vente, rémunérations, achats de stock, frais de retour et abonnements y sont classés tout seuls en revenus / dépenses (catégories automatiques) ; ils alimentent le tableau de bord, les statistiques et les budgets.
- **Dépôts et retraits = virements** avec un compte choisi (par défaut un compte « Mobile Money » créé à la liaison) : ni revenu ni dépense, le total ne bouge pas.
- **Lecture seule, sans copie** : une vue (`pf_all_tx`) lit `wallet_entries` ; rien n'est écrit dans le portefeuille ni dans le grand livre. Seules les entrées déjà disponibles comptent (même règle que le solde disponible). Chacun ne voit que les siennes.
- Délier retire toutes les lignes automatiques (y compris les virements reçus sur le compte choisi). Les comptes et transactions saisis à la main restent.
- Réservé Pro pour relier ; une liaison existante continue de fonctionner si la formule expire.

## À la mise en production
2 colonnes ajoutées à `pf_prefs`, 1 vue, 2 fonctions (`fn_pf_wallet_link`, `fn_pf_wallet_unlink`). Suit l'interrupteur « Mes finances » (éteint par défaut).
Retour arrière : `docs/retour-arriere-051.sql` (refuse si des comptes sont reliés ; à appliquer avant celui de la 050).
