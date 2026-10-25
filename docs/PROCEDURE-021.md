# Migration 021 et commande réservée au vendeur

## Ce qui change
1. **Refus du client = aucun frais pour le vendeur** (migration 021). Wallindirain ne gagne que sur une commande livrée : quand le client refuse le colis, ni la livraison ni le call center ne sont facturés au vendeur. Le produit revient en stock et le numéro reste signalé. Inchangé : produit défectueux (frais au fournisseur), colis abîmé au transport (perte Wallindirain), produit défectueux d'un vendeur qui vend son propre produit (frais au vendeur).
2. **Seul le vendeur saisit la commande.** La page du lien produit montre seulement le produit et dit au client de contacter le vendeur ; l'envoi d'une commande par lien est refusé (403 `orders_closed`). Pour rouvrir : variable Render `PUBLIC_ORDERS=1` (aucune migration).
3. **WhatsApp** : le bouton qui ouvre le WhatsApp du client (vendeur, call center, livreur) existe déjà et reste. Aucun envoi automatique. Les textes légaux sont corrigés (mentions, conditions client/vendeur/livreur, retours, cookies, hébergeurs).

## Mise en production (uniquement après autorisation)
1. Fusionner `feature/commande-vendeur` ; Render applique la 021.
2. `SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 3;` → `021_refus_client.sql` en premier.
3. `SELECT * FROM fn_ledger_check();` → 0 ligne.
4. Ouvrir un lien produit : plus de formulaire, un message invite à contacter le vendeur.

## Retour arrière
`docs/retour-arriere-021.sql` (avant 020, 019…) rétablit la facturation du refus au vendeur. Pour rouvrir la commande par lien : `PUBLIC_ORDERS=1`.
