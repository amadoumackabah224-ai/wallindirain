# Migration 056 : devises (Mes finances)

## Ce que ça fait
- **Devise de base : GNF.** Tous les totaux (tableau de bord, statistiques, budgets, prévision, jauges) restent en GNF.
- **Autres devises** : Paramètres → Devises, bouton « + » en haut. Dollar, euro, franc CFA, livre, yuan, dirham, riyal… ou une devise saisie à la main (code à 3 lettres). La personne saisit elle-même le taux (« 1 USD = X GNF ») et le met à jour quand elle veut.
- **Comptes en devise** : chaque compte a une devise, choisie à la création (elle ne change plus ensuite). Ses montants (solde de départ, revenus, dépenses) sont dans sa devise, avec les décimales de cette devise ; la liste affiche aussi l'équivalent en GNF.
- **Totaux** : convertis en GNF au **taux actuel**. Changer un taux recalcule les totaux (y compris l'historique) ; le solde d'un compte reste dans sa devise.
- **Virements** : seulement entre comptes de la même devise (pas de conversion automatique).
- **Compte relié à Wallindirain** : le compte qui reçoit les mouvements du portefeuille doit rester en GNF.
- **Bloc « Taux de change »** du tableau de bord (réglage Général) : liste les taux et leur date de mise à jour.
- **Mise à jour automatique des taux** : interrupteur enregistré, **sans effet pour l'instant** (aucun service de taux n'est connecté ; indiqué à l'écran). Les taux restent ceux que la personne saisit.
- **Formule gratuite** : une devise en plus du GNF (réglage `pf_free_currencies`) ; Pro : illimité (30 au plus). Les décimales d'une devise ne changent plus une fois un compte créé dedans ; une devise utilisée par un compte (même archivé) ne peut pas être retirée.

## Choix techniques
- Les montants d'un compte sont en plus petite unité (100 = 1,00 USD). Les comptes existants sont en GNF, donc inchangés.
- La vue `pf_all_tx` devient une vue enveloppe (l'ancienne devient `pf_all_tx_raw`) : `amount` reste en GNF pour tous les totaux existants ; `amount_orig` et `currency` donnent le montant du compte.
- `fn_pf_account_save` prend un 7e paramètre (devise). L'ancienne fonction est conservée en interne (`_pf_account_save_base`), utilisée aussi par la liaison Wallindirain.

## À la mise en production
1 table, 2 colonnes (`pf_accounts.currency`, `pf_prefs.rates_auto`), 1 réglage, 4 fonctions, 2 fonctions existantes adaptées (`fn_pf_transfer`, `fn_pf_wallet_link`), 1 vue enveloppe. Aucune donnée existante modifiée. Retour arrière : `docs/retour-arriere-056.sql` (refuse s'il existe des devises, des comptes en devise ou le réglage automatique activé). Le code de l'application doit revenir à la version précédente en même temps (la fonction de compte repasse à 6 paramètres).
