# Migration 046 : les vendeurs proposent leurs produits au catalogue

## Ce que ça fait
Un vendeur peut proposer ses propres produits aux autres vendeurs, exactement comme un fournisseur :
1. Dans l'espace vendeur, onglet **« Proposer un produit »** : nom, description, rayon, photos, **son prix** (ce qu'il veut toucher par unité), stockage (**chez Wallindirain** avec annonce d'arrivage compté par le magasinier, ou **chez lui** avec son stock et l'adresse de récupération).
2. L'administrateur voit le produit dans la liste habituelle (mention « (vendeur) » à côté du nom), le valide et **ajoute la marge de Wallindirain** comme pour un fournisseur.
3. Après validation, le produit apparaît dans le **Catalogue des autres vendeurs** au prix vendeur = prix du proposant + marge.
4. Quand un autre vendeur le livre, la part « fournisseur » est créditée au portefeuille du vendeur proposant (gains bloqués 48 h, retrait avec vérification d'identité, comme tout le monde).
5. Les changements de prix ou de nom d'un produit validé passent par l'administrateur, comme pour un fournisseur. Les colis à préparer (stock chez le vendeur) apparaissent sous ses produits, identifiés par leur seule référence WLD.

## Règles de sécurité
- **Pas de vente à soi-même** : un vendeur ne peut pas vendre, fixer un prix, acheter du stock ni créer un lien pour un produit qu'il a proposé (contrôle dans la base, par déclencheurs). Ces produits n'apparaissent pas dans son propre catalogue.
- Le vendeur ne modifie que **ses** produits (autre vendeur ou fournisseur : « introuvable »). Il ne valide pas ses produits et ne touche pas à la marge.
- **Aucune règle d'argent modifiée** : le calcul à la livraison lisait déjà `products.supplier_id`. Test : un autre vendeur livre le produit, le proposant reçoit exactement le prix × quantité, et le contrôle des comptes (`fn_ledger_check`) reste à zéro.
- Un vendeur qui a encore des produits validés ne peut pas être anonymisé (règle déjà en place pour les fournisseurs).

## À la mise en production
- **Éteint par défaut** (`feature_vendeur_produits` = 0) : l'onglet affiche « pas encore disponible », et un vendeur qui appelle les fonctions fournisseur est refusé exactement comme avant la migration. Pour l'allumer : réglage `feature_vendeur_produits` = 1.
- La migration réécrit **11 fonctions fournisseur existantes** (9 passent par un contrôle `_require_proposer`, 2 fonctions de lecture de photos acceptent aussi le propriétaire vendeur) à partir de leur texte actuel ; elle s'arrête si l'une n'est pas trouvée ou inchangée. Ajout : le réglage, `_require_proposer`, `trg_no_self_dealing` et ses 4 déclencheurs.

## Points restant à décider
1. Faut-il exiger un vendeur « vérifié » (pièce d'identité) avant qu'il puisse proposer ? Aujourd'hui, seule la validation du produit par l'administrateur filtre.
2. Mention « proposé par un vendeur » côté catalogue : non affichée (les vendeurs ne voient jamais le fournisseur).
3. La liste « Colis à préparer » du fournisseur existe aussi dans le menu fournisseur ; pour le vendeur elle est sous « Proposer un produit ».

## Retour arrière
`docs/retour-arriere-046.sql` : refuse s'il existe des produits proposés par des vendeurs (même retirés du catalogue) ou si le réglage n'est pas à 0 ; remet les 11 fonctions dans leur état d'avant. À appliquer avant celui de la 045.
