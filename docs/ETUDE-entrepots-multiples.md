# Étude : lieux de stockage multiples (fournisseurs et vendeurs avec leurs propres entrepôts)

Mise en attente volontaire (risque pour le stock, les commandes et l'inventaire). Voici ce qui est possible, par étapes, sans toucher aux circuits d'argent.

## Besoin
Des fournisseurs et des vendeurs ont des entrepôts dans d'autres zones. Une commande doit partir du stock le plus proche du client pour réduire le coût et le délai.

## État actuel
- Un produit a un seul mode de stockage : Wallindirain ou chez le fournisseur (`storage_mode`), avec un seul compteur de stock et un seul « lieu de récupération » (texte libre).
- Les frais de livraison dépendent de la zone du client, pas du point de départ.
- L'inventaire et les arrivages sont comptés pour le stock Wallindirain uniquement.

## Étape 1 (faible risque, utile tout de suite) : points de départ déclarés
Un fournisseur ou un vendeur déclare plusieurs **points de retrait** (nom, zone, adresse, contact), avec un stock indicatif par point. À la création d'une commande, le point le plus proche de la zone du client est proposé ; le livreur voit le bon lieu de récupération. Le stock total reste un seul compteur : aucune règle de stock ni d'argent ne change.

## Étape 2 : stock réellement séparé par point
Compteur par produit et par point, réservations par point, transferts entre points avec trace. Il faut adapter la réservation de stock, l'inventaire, les pertes, les retours et les arrivages. Test de non-régression complet obligatoire.

## Étape 3 : frais selon le départ
Grille de frais en fonction du couple départ / arrivée (la base de la grille existe déjà côté livraison). Cela touche une règle économique : décision de votre part obligatoire, avec période d'essai.

## Risques
- Stock négatif ou double réservation entre points.
- Inventaire physique par point (le magasinier doit savoir où il compte).
- Fournisseur qui déclare un stock qu'il n'a pas : contrôle par arrivage compté, comme aujourd'hui.

## Recommandation
Faire l'étape 1 sur une branche dédiée après le test terrain, puis juger si les étapes 2 et 3 sont nécessaires selon le volume réel.
