# Étude préparatoire : mode hors connexion, conseiller IA, multi-boutiques

Rien de ce qui suit n'est construit : ce sont des évolutions à risque plus élevé, mises en attente volontairement (consigne : risque pour données, sécurité ou finances).

## 1. Mode hors connexion
**Existant** : `offline.js` met en file les écritures de « Mes finances » et de la boutique ; le service worker ne met volontairement jamais `/api` en cache (aucune donnée sensible sur l'appareil).
**Proposition** (consultation seulement, optionnelle) :
- Livreur : liste des colis du jour (réf., zone, téléphone client masqué sauf au moment de l'appel, montant à encaisser) gardée en mémoire de l'application pendant la tournée.
- Vendeur : dernières commandes et catalogue.
- Effacement à la déconnexion et après 24 h ; aucune validation d'argent hors ligne (livraison, caisse, retrait restent en ligne).
**Risques** : données personnelles de clients sur un téléphone partagé ou volé ; conflits si une commande change pendant la coupure.
**Prérequis** : réglage administrateur éteint par défaut, chiffrement local, effacement à distance à la déconnexion, test sur vrais téléphones.

## 2. Conseiller IA
**Existant** : l'assistant est une base de connaissances (non générative).
**Proposition** : conseiller en lecture seule, rôle par rôle, qui ne reçoit que les chiffres que le rôle a déjà le droit de voir (jamais la marge pour un vendeur ou un fournisseur), n'écrit rien, ne déclenche aucun mouvement d'argent.
**Risques** : fuite de données vers un fournisseur externe, coût par requête, réponses inexactes sur des montants.
**Prérequis** : clé du fournisseur en secret serveur (jamais dans le code), quota par utilisateur, journal des questions, mention « suggestion non contractuelle », réglage éteint par défaut, décision juridique sur le transfert de données.

## 3. Multi-boutiques
**Existant** : un vendeur = un espace ; les produits, commandes et portefeuilles sont rattachés à l'utilisateur.
**Proposition** : table `shops` (propriétaire, nom, statut) et colonne `shop_id` facultative sur commandes et produits propres ; portefeuille unique par propriétaire (ne pas multiplier les circuits d'argent) ; statistiques par boutique.
**Risques** : touche aux tables centrales (orders, products), aux factures et aux règles de retrait ; migration lourde.
**Prérequis** : validation du modèle économique (un portefeuille ou plusieurs), sauvegarde et répétition de migration sur une copie de production, phase pilote.
