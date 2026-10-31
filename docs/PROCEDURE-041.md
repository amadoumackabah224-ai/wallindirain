# Migration 041 : modification des produits et des prix

## Ce que ça fait
- **Fournisseur** : « Modifier le produit » (nom, description, immédiat) et « Changer mon prix ».
  - Produit pas encore validé : le prix change tout de suite.
  - Produit validé : le changement est une **demande**. L'ancien prix reste actif jusqu'à l'accord de l'administrateur ; les commandes déjà créées gardent leur prix.
- **Administrateur** : carte « Changements de prix à valider » (Accepter avec la marge par défaut ou une marge choisie, ou Refuser avec un motif) ; boutons « Modifier » (nom, description) et « Prix » sur chaque produit.
- **Vendeur** : « Corriger » un dépôt de stock tant que le magasinier ne l'a pas compté. Ses prix de vente restaient déjà modifiables dans le catalogue.

## Règles d'argent
- À l'acceptation, la marge est **recalculée comme à la validation d'un produit** (marge par défaut du réglage, ou celle que vous indiquez). Aucun pourcentage n'est inventé.
- Même verrou que pour la marge : un changement de prix est refusé tant que du stock prépayé de vendeur ou des commandes en cours existent pour ce produit.
- Après une hausse de prix, le prix de vente d'un vendeur peut passer sous le nouveau minimum : le vendeur doit alors le réajuster.

## À la mise en production
- Render applique la migration au démarrage : une table et six fonctions ajoutées, rien d'existant modifié.

## Retour arrière
`docs/retour-arriere-041.sql` : refuse s'il existe des demandes de changement de prix. À appliquer avant celui de la 040.
