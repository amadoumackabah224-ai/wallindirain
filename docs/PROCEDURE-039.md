# Migration 039 : stock du vendeur gardé à l'entrepôt

## Ce que ça fait
- Le vendeur annonce un dépôt (« Mon stock » → Envoyer du stock). Le magasinier le compte à la réception (« À faire » → Dépôts de vendeurs) ; seule la quantité comptée est disponible. Un écart avec l'annonce doit être expliqué.
- À la création d'une commande « Mon propre produit », le vendeur peut choisir « Sortir du stock gardé chez Wallindirain ». La quantité est réservée ; le livreur récupère le colis à l'entrepôt ; le magasinier le remet ; la quantité sort à la livraison. Une annulation ou un refus libère la réservation.
- Le stock reste la propriété du vendeur.

## Ce que ça ne fait pas
- **Aucun gain ne change** : la commande reste une commande « produit propre » (un test compare les gains avec une commande ordinaire).
- **Le frais de stockage n'est pas facturé.** Le réglage `seller_storage_fee` (GNF par unité et par mois) est enregistré à 0 et n'est utilisé par aucune facturation.
- Pas encore : inventaire du magasinier sur ces dépôts, déclaration de casse, retrait de dépôt par le vendeur, vue administrateur des dépôts.

## À la mise en production
- Render applique la migration automatiquement au démarrage après fusion. Elle modifie quatre fonctions existantes (sortie et libération de stock, remise du colis, notification du magasinier) en ajoutant seulement le cas « dépôt ».

## Retour arrière
`docs/retour-arriere-039.sql` : refuse s'il existe des dépôts ou des commandes liées ; sinon restaure les anciennes fonctions et retire la table.
