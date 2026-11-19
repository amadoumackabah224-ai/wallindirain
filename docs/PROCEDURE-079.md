# Migration 079 : points de retrait multiples (étape 1)

Un fournisseur (ou un vendeur) **déclare** plusieurs lieux de retrait : nom, zone, adresse, téléphone. **Aucun stock, aucun frais, aucun mouvement d'argent n'est lié à un point** : le compteur de stock reste unique.

- Réglage `feature_pickup_points`, éteint par défaut (Réglages > Fonctions).
- Le fournisseur peut appliquer un de ses points au lieu de récupération d'un produit gardé chez lui (copie du texte `pickup_detail`).
- `fn_pickup_suggest` propose, en lecture seule, le point du fournisseur le plus proche de la zone du client (même zone, sinon même ville).
- Vingt points actifs au maximum par compte ; retirer un point le désactive sans rien supprimer.
- Retour arrière : `docs/retour-arriere-079.sql` (refusé s'il existe des points).
