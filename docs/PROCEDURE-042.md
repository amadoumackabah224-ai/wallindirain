# Migration 042 : renommage d'un produit validé soumis à l'administrateur

## Ce que ça fait
- Un fournisseur qui renomme un produit **déjà validé** envoie une demande ; l'ancien nom reste affiché jusqu'à l'accord de l'administrateur (carte « Changements de nom à valider » dans Produits). La description reste modifiable tout de suite.
- Produit non validé : renommage immédiat. L'administrateur peut toujours renommer directement.

## Ce que ça ne fait pas
- Aucun montant n'est touché.

## À la mise en production
- Render applique la migration au démarrage : une table et une fonction ajoutées, la fonction de modification du fournisseur est remplacée (elle renvoie maintenant « applied » ou « pending »).

## Retour arrière
`docs/retour-arriere-042.sql` : refuse s'il existe des demandes de changement de nom ; restaure l'ancienne fonction. À appliquer avant celui de la 041.
