# Migration 018 — profil et zones du livreur

**Dépend de la 017** : à fusionner et appliquer après elle (les migrations s'appliquent dans l'ordre). Aucune donnée financière, aucune commande, aucun réglage n'est touché.

## Ce qui est ajouté
- Deux tables : `courier_profiles` (véhicule, disponibilité) et `courier_zones` (zones couvertes).
- Création du livreur (bouton « + Créer un livreur » dans « Utilisateurs ») : compte, véhicule et zones en une fois ; « Modifier » permet de les changer ; la ligne du livreur affiche véhicule, zones et disponibilité.
- Espace livreur : bouton « Me mettre disponible / indisponible » et rappel de ses zones.
- Le chef voit disponibilité et zones dans la liste d'affectation. L'affectation reste libre.

## Essai sur une copie Neon (comme pour la 017)
1. Créer une branche Neon depuis la production, y lancer la migration.
2. Vérifier : la requête 6 du rapport 017 donne les mêmes valeurs ; aucune commande, écriture ni réglage modifié.
3. Dans l'application : créer un livreur, lui donner des zones, le rendre indisponible, affecter une commande de test.
4. Retour arrière : `docs/retour-arriere-018.sql` (supprime profils et zones saisis, rien d'autre).

## Décisions encore nécessaires
- Un livreur sans zone sera exclu de la répartition automatique (étape 020) mais reste affectable à la main (décision déjà prise).
- Faut-il, plus tard, avertir le chef quand il affecte un livreur indisponible ou hors zone ? Aujourd'hui : simple indication dans la liste.
