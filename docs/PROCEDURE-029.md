# Migration 029 — Deux catégories de livreurs (indépendants et Wallindirain)

## Ce que ça fait
- Chaque livreur a une **catégorie** : *indépendant* (sa propre moto, comportement actuel) ou *Wallindirain* (moto de l'entreprise, pour le projet pilote). Tous les livreurs existants restent **indépendants**.
- La catégorie et le barème sont **retenus au moment de l'affectation** de la commande : un changement ultérieur ne modifie jamais une commande déjà affectée.
- Un **barème des livreurs Wallindirain** (paie par livraison, supplément de tournée, déplacement à vide, prime du jour) peut être enregistré avec une date d'effet. Les barèmes sont des versions datées, jamais rétroactives.
- **Sans barème** (ou paie par livraison = 0), les livreurs Wallindirain sont payés comme les indépendants.
- Une **simulation** (écran Livreurs → Barèmes et simulation) compare les modèles avant toute activation. Elle n'écrit rien. Les coûts de la moto (carburant, entretien, achat) sont saisis par vous : rien n'est prérempli.
- Un **journal des charges de la moto** par livreur (carburant, entretien…) : simple suivi de l'entreprise, rien n'est versé au livreur.
- Nouvel onglet administrateur **Livreurs** : liste, fiche (catégorie, historique, missions, paies, reversements, charges, examen de la pièce d'identité), barèmes.

## Ce que ça NE fait PAS
- **Aucun barème n'est actif** : tant que vous n'en enregistrez pas un, tout est payé exactement comme avant.
- Aucun tarif, pourcentage, frais, marge ni bonus existant n'est modifié.
- Aucune écriture d'argent passée n'est touchée.
- Aucun envoi WhatsApp.

## Mise en production (uniquement après autorisation)
**Render applique la migration automatiquement au démarrage, dès la fusion.**
1. Fusionner `feature/livreurs-categories`.
2. `SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 3;` → `029_livreurs_categories.sql` en premier.
3. `SELECT * FROM fn_ledger_check();` → 0 ligne.
4. `SELECT count(*) FROM courier_pay_scales;` → 0 (aucun barème actif).
5. Dans l'application : Livreurs → un livreur reste « Indépendant ».
6. Pour le pilote : fiche du livreur → « Passer en livreur de Wallindirain », puis simuler et enregistrer un barème seulement quand vous êtes d'accord.

## Retour arrière
`docs/retour-arriere-029.sql`. Il **refuse de s'exécuter** (rien n'est modifié) si un barème avec paie > 0, une commande de livreur Wallindirain, une écriture « déplacement à vide » ou « prime » ou un changement de catégorie vers Wallindirain existe déjà : on ne perd jamais de données d'argent. Sinon il restaure les anciennes fonctions et supprime les objets ajoutés.
