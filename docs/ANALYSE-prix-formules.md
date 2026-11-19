# Analyse : prix et formules de « Mes finances » (référence : grilles de Fiistore)

Avis de conception. **Aucun prix n'est fixé** : c'est une décision commerciale. Le seul changement de code livré avec ce document est une protection (période de grâce, section 5).

## 1. Ce que montre Fiistore
Quatre formules : Gratuit (0), Basic (70 000 GNF/mois), Pro (150 000), Max (250 000, tout illimité, accès API). Les limites portent sur des volumes (produits, factures, commandes, clients, utilisateurs, outils) ; les formules payantes ajoutent historique complet, recherche par dates, statistiques avancées, exports, sauvegarde automatique, support. Remise annuelle d'environ 7 %.

## 2. Pourquoi ne pas copier cette grille
1. **Le modèle économique est différent.** Fiistore vend un logiciel : l'abonnement est son revenu. Wallindirain gagne sur le flux de livraisons (marge, frais d'appel, livraison). « Mes finances » sert à fidéliser et à faire vendre davantage ; il ne doit pas freiner l'activité.
2. **Jamais de limite sur le cœur de métier.** Commandes, livraisons, portefeuille, retraits ne dépendent d'aucune formule. Les limites de Fiistore sur les commandes et les produits n'ont pas de sens chez nous.
3. **Le pouvoir d'achat.** 70 000 GNF par mois est un premier palier élevé pour un vendeur ou un livreur débutant.
4. **Le coût de la complexité.** Notre code connaît deux niveaux, gratuit et Pro, dans une dizaine de fonctions. Ajouter un niveau intermédiaire oblige à les revoir toutes, pour un gain de revenu qu'aucune donnée ne prouve encore.

## 3. Grille recommandée (à valider)
| | Gratuit | Pro |
|---|---|---|
| Prix | 0 | **20 000 GNF/mois** · **200 000 GNF/an** (deux mois offerts) |
| Essai | | 14 jours à la première utilisation (déjà en place) |
| Comptes | 2 | illimités |
| Historique | 90 jours | complet |
| Contacts | 30 | illimités |
| Catégories ajoutées | 5 | illimitées |
| Devises hors GNF | 1 | illimitées |
| Plan financier, espaces de groupe, paie | non | oui |

Raisonnement du prix : environ 30 % du premier palier de Fiistore (70 000), parce que notre Pro ne contient ni facturation ni stock. Un tarif d'entrée bas favorise l'adoption, et on peut toujours monter ensuite ; l'inverse est difficile. **Ces chiffres sont mon jugement, pas une mesure** : à confirmer lors du test terrain en demandant à 5 à 10 utilisateurs ce qu'ils paieraient (10 000, 20 000, 30 000).

Levier propre à Wallindirain (non construit) : offrir le Pro aux vendeurs qui dépassent un nombre de livraisons par mois. Cela aligne l'abonnement sur ce qui rapporte vraiment (le flux de livraisons).

## 4. Quand ajouter un palier intermédiaire
Seulement si, après deux ou trois mois : beaucoup d'utilisateurs gratuits butent sur les limites **et** disent que Pro est trop cher. Dans ce cas on ajoute un palier à environ 10 000 GNF, pas avant.

## 5. Piège à éviter au lancement (corrigé par la migration 081)
Aujourd'hui le prix est à 0 : tout le monde a tout. Dès qu'un prix est fixé, **tous ceux dont l'essai de 14 jours est fini passent en gratuit en même temps**, sans préavis. La migration 081 ajoute, dans Réglages > Mes finances, le bouton « Offrir une période de Pro à tous » : N jours (1 à 90) offerts à tous les utilisateurs actuels, sans jamais raccourcir un essai ou un abonnement plus long.

## 6. Ordre de lancement conseillé
1. Test terrain et question sur le prix.
2. Offrir 30 jours de Pro à tous (bouton ci-dessus), et prévenir les utilisateurs.
3. Fixer le prix mensuel puis annuel (Réglages > Mes finances).
4. Suivre : combien passent de l'essai au payant, combien butent sur les limites.
5. Réviser la grille après 60 jours.

Paiement : le Pro se paie déjà depuis le portefeuille Wallindirain ; l'administrateur peut aussi l'offrir ou l'encaisser hors plateforme avec une note.
