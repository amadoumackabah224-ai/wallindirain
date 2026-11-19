# Analyse : frais de livraison selon le point de départ

Demande : avec plusieurs lieux de stockage, les frais ne peuvent plus être les mêmes partout. Quand une commande ne part pas de notre point de repère (l'entrepôt Wallindirain), le montant de livraison doit être revu. **Rien n'est construit : c'est une règle économique, donc la décision est la vôtre.** Les chiffres ci-dessous sont des exemples à calibrer, pas des propositions fermes.

## 1. Comment les frais fonctionnent aujourd'hui
- Le frais de livraison dépend **uniquement de la zone du client** (table `delivery_rates`, par quartier ou ville). Il est fixé à la création de la commande.
- Le vendeur ne le saisit jamais. Il entre dans trois calculs :
  - le **prix minimum de vente** : prix ≥ (prix fournisseur + marge) × quantité + frais d'appel + frais de livraison ;
  - le **gain du vendeur** : vente − livraison − appel − part du fournisseur ;
  - le **brut de la plateforme** : livraison + appel + marge.
- Le livreur touche un montant fixe par livraison (réglage `courier_pay`, 5 000 GNF), quel que soit le trajet.
- Le frais sert aussi aux retours : en cas de retour, il est prélevé au vendeur ; pour un produit défectueux, il est prélevé au fournisseur.
- Tout cela suppose implicitement un départ de l'entrepôt Wallindirain.

## 2. Ce qui change avec plusieurs points de départ
1. Un colis parti d'un point **proche du client** coûte moins cher à livrer : trajet plus court, délai plus court.
2. Un colis parti d'un point **éloigné** coûte plus cher que la grille actuelle. Si on garde le tarif unique, la plateforme perd sur ces commandes.
3. Le livreur est payé au forfait : sur un long trajet il est sous-payé, sur un court il est sur-payé.
4. Gain pour le vendeur : un frais plus bas baisse le prix minimum et le rend plus compétitif. C'est l'objectif des fournisseurs avec plusieurs entrepôts.

## 3. L'idée « le vendeur saisit le montant de livraison »
Elle est simple, mais elle pose un vrai problème : **le frais est retiré du gain du vendeur**. Le vendeur a donc intérêt à saisir un montant bas. Il augmente son gain et baisse son prix minimum, au détriment de la plateforme et du livreur. Un vendeur pourrait aussi se tromper, ou saisir 0.

Si on garde cette idée, il faut au minimum :
- un **plancher** (au moins la rémunération du livreur plus une marge de sécurité) et un **plafond** (la grille actuelle) ;
- une vérification de l'administration pour les commandes hors entrepôt ;
- une trace dans le journal, et le montant figé comme aujourd'hui.

## 4. Options comparées
| Option | Principe | Avantage | Risque |
|---|---|---|---|
| A. Le vendeur saisit | Il tape le frais si le départ n'est pas l'entrepôt | Très simple, rapide | Conflit d'intérêt, erreurs, perte pour la plateforme |
| B. Grille départ → arrivée (recommandée) | L'administration définit des paliers ; le système calcule | Pas de saisie, équitable, vérifiable | Il faut calibrer la grille |
| C. Calcul par distance GPS | Prix au kilomètre | Précis | Complexe, adresses imprécises à Conakry |
| D. Devis par l'administration | L'admin fixe chaque cas | Sûr | Lent, ne passe pas à l'échelle |

## 5. Recommandation : option B, par paliers, en deux temps
**Départ de l'entrepôt Wallindirain : rien ne change** (grille actuelle, même calcul). Pour un point externe, le système compare la zone du point à la zone du client et applique un palier choisi par l'administration. Exemple de paliers (à calibrer) :
- même quartier : le plus bas ;
- même commune : bas ;
- commune voisine : égal à la grille actuelle ;
- zone éloignée : au-dessus de la grille.

Règles de sécurité :
- Plancher : le frais couvre toujours au moins la rémunération du livreur plus une marge.
- Le vendeur voit le frais calculé, il ne peut pas le modifier. Une exception éventuelle passe par l'administration.
- Le frais est figé à la création, comme aujourd'hui.
- Fonction éteinte par défaut, **période d'essai** avec quelques fournisseurs, retour arrière possible.

## 6. Prérequis technique
Pour calculer le départ d'une commande, il faut savoir **quel point expédie**. Aujourd'hui (étape 1, déjà en ligne) le stock est un seul compteur et le point n'est qu'un texte sur le produit. Deux voies :
- **Simple** : un produit est rattaché à **un seul** point (nouveau lien produit → point). Le frais se calcule depuis ce point. Pas de stock par point.
- **Complète** : stock par point (étape 2 de l'étude). Nécessaire si un même produit est stocké à plusieurs endroits.

Je recommande d'abord la voie simple.

## 7. Ce que ça touche (à tester)
Prix minimum de vente, gain du vendeur, brut plateforme, factures, retours (frais prélevés au vendeur ou au fournisseur), paie du livreur (forfait ou par palier), statistiques et rapports, tournées. Aucune de ces règles ne doit changer pour les commandes parties de l'entrepôt.

## 8. Décisions à prendre par vous
1. Qui profite du frais réduit : **tout le gain va au vendeur**, ou la plateforme garde une part ?
2. Les paliers et leurs montants (à calibrer sur des données réelles).
3. Qui choisit le point de départ : le fournisseur (au niveau du produit), ou l'administration ?
4. La rémunération du livreur reste-t-elle au forfait, ou varie-t-elle par palier ?
5. La durée de l'essai, et avec qui.

## 9. Étapes proposées
1. **Test terrain** (avec l'entrepôt seul) : relever le temps et le coût réels par zone.
2. Lien produit → point de départ, sans effet sur l'argent.
3. Grille de paliers, éteinte par défaut, essai limité, retour arrière.
4. Seulement ensuite, si besoin, stock réellement séparé par point.
