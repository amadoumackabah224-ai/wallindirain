# Migration 022 — Lieu de récupération du colis

## Ce que ça fait
- **Stock chez le fournisseur** : le fournisseur indique l'adresse où le livreur récupère le colis (à la création du produit ou plus tard, bouton « Adresse de récupération »). Cette adresse n'est **jamais montrée au vendeur ni au client**.
- **Stock chez Wallindirain** : « Entrepôt Wallindirain », rien à saisir.
- **Produit du vendeur lui-même** : le vendeur doit indiquer où récupérer le colis en saisissant la commande (modifiable tant que le colis n'est pas parti).
- Le livreur, le chef d'équipe et le vendeur (pour ses propres produits) voient « À récupérer ». Si l'adresse manque, l'écran écrit « adresse non indiquée ».

## Ce que ça ne fait pas
- Aucune écriture d'argent, aucune règle de stock modifiée. Les commandes existantes sont inchangées.
- Pas encore d'images de produits.

## Mise en production (uniquement après autorisation)
1. Fusionner `feature/lieu-recuperation`. Render applique la 022.
2. `SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 3;` → `022_lieu_recuperation.sql` en premier.
3. `SELECT * FROM fn_ledger_check();` → 0 ligne.
4. Test : en fournisseur, renseigner l'adresse d'un produit gardé chez soi ; en vendeur, passer une commande de ce produit, l'affecter à un livreur : le livreur voit l'adresse, le vendeur ne la voit pas.

## Retour arrière
`docs/retour-arriere-022.sql` (avant 021, 020…) : retire les 2 colonnes et les 2 fonctions ; les adresses saisies sont perdues.
