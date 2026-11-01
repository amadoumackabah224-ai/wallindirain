# Migration 043 : outils du vendeur

## Ce que ça fait
- **Mes clients** : tous les clients du vendeur regroupés par numéro (commandes, livrées, échecs, total livré, dernière commande), alerte « client à risque », note privée par client, boutons Appeler et WhatsApp.
- **Mon bénéfice** : gains réellement crédités sur le portefeuille moins les dépenses saisies par le vendeur (publicité, marchandise, transport, autre). Coût de publicité par livraison, et par canal si la publicité est rattachée à un canal. Une dépense n'est jamais effacée : elle est annulée et reste dans l'historique.
- **Export** : fichier CSV des ventes et des dépenses (s'ouvre dans Excel, séparateur « ; »). Version imprimable (PDF depuis le navigateur) du résumé de bénéfice.
- **Mes retours** : échecs et retours avec motif, cause, remis en stock ou non (refus du client : remis en stock ; défectueux ou abîmé : non, sauf produit propre du vendeur défectueux), quartiers et produits les plus touchés.
- **Stock bas** : encart sur l'accueil et sur « Mon stock » quand un dépôt compté ou un stock prépayé a 5 unités libres ou moins. Le seuil (5) est fixé dans le code, pas dans les réglages.

## Ce que ça ne fait pas
- Aucun montant de la plateforme n'est touché : ni portefeuille, ni frais, ni marge, ni tarif, ni part du livreur. Les dépenses sont des notes personnelles du vendeur.
- Pas de vrai fichier .xlsx : le CSV est ouvert par Excel. Le PDF passe par « Imprimer » du navigateur.
- Les gains comptés sont ceux déjà crédités ; le prix d'achat des produits propres du vendeur n'est compté que s'il l'ajoute en « Marchandise ».

## À la mise en production
- Render applique la migration au démarrage : deux tables (`seller_customer_notes`, `seller_expenses`) et trois fonctions (`fn_seller_set_customer_note`, `fn_seller_add_expense`, `fn_seller_void_expense`) ajoutées. Rien n'existant n'est modifié.
- Les écrans sont visibles par tous les vendeurs dès le déploiement (onglets « Mes clients », « Mon bénéfice », « Mes retours »).

## Retour arrière
`docs/retour-arriere-043.sql` : refuse s'il existe des notes de clients ou des dépenses (elles seraient perdues). À appliquer avant ceux de la 042 et de la 041.
