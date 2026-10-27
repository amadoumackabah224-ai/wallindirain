# Migration 027 — Notifications dans l'application et annonces

## Ce que ça fait
- Une **cloche** en haut de l'écran (tous les rôles) avec le nombre de notifications non lues, et une page **Notifications**.
- Les notifications sont créées **automatiquement** à partir de changements qui existent déjà :
  - **Vendeur** : commande confirmée, livreur affecté, livrée, échec de livraison, colis refusé, retour attendu, colis retourné.
  - **Livreur** : nouveau colis affecté, nouvelle tournée proposée, bonus reçu.
  - **Tout le monde** : retrait payé ou refusé, bonus de parrainage reçu, identité vérifiée ou refusée, réponse du support.
  - **Fournisseur** : produit validé ou refusé.
- Les **annonces** (onglet « Annonces » de l'administrateur) : un message envoyé dans les notifications de tout le monde ou d'un groupe (vendeurs, livreurs, agents…). Chaque envoi est tracé dans le journal.

## Ce que ça NE fait PAS
- **Aucun calcul d'argent n'est touché.** Les déclencheurs ne font que lire un changement déjà fait et écrire une ligne dans `notifications`.
- **Une notification qui échoue ne bloque jamais l'action** (chaque déclencheur avale ses propres erreurs) : testé.
- Aucun numéro de téléphone ni adresse dans les textes (référence de commande, statut, montant d'un bonus seulement) : testé.
- **Aucun envoi WhatsApp ou SMS** : tout reste dans l'application.

## Données personnelles
- Une personne ne voit que ses notifications. Elles sont **effacées après 90 jours**.
- Les annonces gardent le titre, le texte, le groupe visé et le nombre de destinataires.

## Mise en production (uniquement après autorisation)
**Attention : Render applique la migration automatiquement au démarrage, dès la fusion.**
1. Fusionner `feature/notifications`. Render applique la 027.
2. `SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 3;` → `027_notifications.sql` en premier.
3. `SELECT * FROM fn_ledger_check();` → 0 ligne.
4. Test sans risque : en administrateur, onglet « Annonces » → envoyer une annonce à « Les vendeurs » → un vendeur voit la pastille sur la cloche.

## Retour arrière
`docs/retour-arriere-027.sql` : retire les déclencheurs, les fonctions et les deux tables. Aucune donnée financière n'est concernée ; seules les notifications et l'historique des annonces sont perdus. Retirer aussi le code déployé correspondant.
