# Migration 047 : « Mes produits proposés », partage et vente par le propriétaire

## Ce que ça fait
- Le propriétaire d'un produit proposé (vendeur) peut **le partager aux autres vendeurs ET le vendre lui-même**, sur **un seul stock partagé** : pas de copie du produit, donc pas de double vente. La restriction « vous ne pouvez pas vendre ce produit vous-même » disparaît.
- **Argent** : la vente du propriétaire passe par le même circuit de commande et de règlement. Seule la marge Wallindirain de cette commande est à 0 ; frais de livraison, d'appel et de plateforme restent dus. Le prix minimum du propriétaire n'inclut donc pas la marge. Les ventes des autres vendeurs ne changent pas. `fn_ledger_check()` reste vide (testé).
- **Suspendre / reprendre** : les autres vendeurs ne voient plus le produit et ne peuvent plus le commander (ni acheter du stock prépayé). Le propriétaire continue de vendre. Un vendeur qui avait déjà du stock prépayé peut encore le vendre.
- **Retirer** : plus aucune nouvelle commande pour personne. Définitif pour le catalogue ; rien n'est supprimé.
- **Les commandes déjà prises ne sont jamais annulées** et les quantités réservées restent protégées (suspension et retrait).
- **Restitution de stock gardé chez Wallindirain** : le propriétaire demande une quantité (au plus le disponible, hors réservé) ; l'administrateur accepte (les unités sont alors bloquées, non vendables) ou refuse (motif obligatoire) ; le magasinier remet les unités, qui sortent du stock. Une seule demande à la fois par produit ; annulable avant la remise.
- **Suivi du propriétaire** : en stock, réservé, disponible, vendu (livré), dont par d'autres vendeurs, en cours, montant à recevoir après livraison. Notification « Nouvelle vente » / « Vente livrée » quand un autre vendeur vend son produit, **sans nom de vendeur ni de client**.
- Nom de la section et bouton inchangés ; nouveau texte de description.

## Ce qui ne change pas
- Le proposant ne voit jamais la marge. Le fournisseur classique n'a aucun nouveau bouton ni notification.
- L'achat de stock prépayé de son propre produit reste interdit.
- Frais de stockage : pas de facturation pour l'instant.

## À la mise en production
- Migration : 3 colonnes sur `products` (`paused_at`, `retired_at`, `availability_note`), table `stock_returns`, 6 fonctions `fn_*` + `_min_unit_price_for`, un déclencheur de notification, 3 déclencheurs d'interdiction de la 046 retirés, 3 fonctions existantes réécrites (`_create_order`, `fn_seller_buy_stock`, `fn_seller_set_price`). La migration s'arrête si une réécriture ne trouve pas son texte.
- Reste sous le réglage `feature_vendeur_produits` (éteint par défaut).

## Points restant à décider
1. Exiger une identité vérifiée avant de proposer un produit.
2. Facturation de stockage plus tard.

## Retour arrière
`docs/retour-arriere-047.sql` : refuse s'il existe des demandes de restitution ou des produits suspendus / retirés. À appliquer avant celui de la 046.
