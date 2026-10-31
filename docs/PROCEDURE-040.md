# Migration 040 : casse ou perte sur un dépôt de vendeur

## Ce que ça fait
- Le magasinier (ou l'administrateur) peut retirer des unités **libres** d'un dépôt de vendeur (abîmé, perdu, périmé, autre) avec une explication obligatoire. Les unités réservées par une commande ne peuvent pas être retirées.
- Le vendeur est prévenu et voit le retrait dans « Mon stock » ; l'administration est prévenue.
- L'historique est conservé et non modifiable.

## Ce que ça ne fait pas
- **Aucune écriture d'argent.** Qui supporte la perte (vendeur, Wallindirain) reste une décision de l'administration, à prendre à la main.
- Pas encore : inventaire de rayon sur les dépôts, retrait de dépôt par le vendeur, vue administrateur dédiée (l'administrateur peut utiliser l'écran de stock de l'entrepôt).

## À la mise en production
- Render applique la migration automatiquement au démarrage après fusion : elle ajoute une table et une fonction, sans modifier l'existant.

## Retour arrière
`docs/retour-arriere-040.sql` : refuse s'il existe des casses enregistrées. À appliquer **avant** le retour arrière 039.
