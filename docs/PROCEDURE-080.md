# Migration 080 : frais de livraison selon le point de départ

Suite de l'analyse `docs/ANALYSE-frais-selon-depart.md`. Choix retenus : le gain du frais réduit va **entièrement au vendeur** ; le départ est choisi par le **fournisseur** (point rattaché au produit) ; la rémunération du livreur ne change pas de règle.

- Réglage `feature_depart_fees`, **éteint par défaut** (Réglages > Fonctions). Éteint ou sans point rattaché : grille actuelle, rien ne change.
- Le fournisseur rattache un de ses points de retrait à un produit gardé chez lui (bouton « Choisir un point de retrait »). Saisir une adresse à la main détache le point.
- Paliers (Réglages > Tarifs) : même zone 15 000 ; même commune 20 000 ; autre commune = grille + supplément (0 par défaut) ; minimum 10 000. Un palier proche ne dépasse jamais la grille.
- Le frais est figé à la création de la commande ; la part du livreur est recalculée si elle est en pourcentage du frais.
- Produit au stock de l'entrepôt Wallindirain, ou vendeur ayant du stock à l'entrepôt : aucun changement.
- La zone d'un point doit être une zone de livraison active.
- Retour arrière : `docs/retour-arriere-080.sql` (refusé si des produits sont rattachés).
