# Migration 068 : grille tarifaire de la livraison à la demande (base)

## Ce que ça fait
- Une grille par quartier de **départ** : des groupes de quartiers d'**arrivée**, chacun avec un prix **poids léger** et un prix **poids lourd** (comme la grille papier de Taouyah).
- Réglage **delivery_heavy_kg** (10 par défaut) : à partir de ce poids, le colis est « lourd ».
- Réglage **feature_livraison_demande** : éteint (0) par défaut. Tant qu'il est éteint, seul l'admin peut calculer un prix.
- Réglages > **Grille livraison** : ajouter, modifier, désactiver un groupe, ou coller toute la grille d'un départ.
- Un tarif n'est jamais supprimé, seulement désactivé. Un quartier ne peut être que dans un groupe actif par départ.
- N'a aucun effet sur les zones et frais des commandes de vendeurs.

## Retour arrière
`docs/retour-arriere-068.sql` : refusé si la fonction est allumée ; sinon retire la table, les fonctions et les réglages.
