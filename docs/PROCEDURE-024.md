# Migration 024 — Reversement en espèces, ordre des tournées, montants prévus

## Ce que ça fait
1. **Reversement du livreur en espèces** : à côté de « Reverser par transfert », un bouton « Remettre en espèces ». Le livreur indique **à qui** il a remis l'argent (obligatoire) et peut préciser le lieu et l'heure. L'administrateur vérifie, saisit la somme réellement reçue et valide : un manque est débité au livreur, exactement comme pour un transfert. Pas de capture d'écran pour les espèces.
2. **Ordre de passage d'une tournée** : sur chaque tournée en cours, des flèches ↑ ↓ permettent au chef d'équipe de dire « tu passes ici avant ici ». Le livreur voit le nouvel ordre.
3. **Montants prévus dès la création** : la tournée affiche tout de suite les frais de livraison, la paie du livreur (celle de chaque commande) et la marge de livraison prévus ; la liste de création montre aussi frais et paie de chaque commande.

## Ce que ça ne fait pas
- **Aucune paie modifiée** : la rémunération des tournées groupées (pourcentage plus élevé) et l'acceptation par le livreur ne sont **pas** faites : décision à prendre d'abord (voir les propositions).
- Pas de notification automatique du livreur.

## Mise en production (uniquement après autorisation)
1. Fusionner `feature/versement-especes-ordre-tournee`. Render applique la 024.
2. `SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 3;` → `024_versement_especes_ordre.sql` en premier.
3. `SELECT * FROM fn_ledger_check();` → 0 ligne.
4. Test : en livreur, remettre une livraison en espèces en indiquant le nom ; en administrateur, valider ; en chef, créer une tournée de 2 commandes et inverser l'ordre.

## Retour arrière
`docs/retour-arriere-024.sql` (avant 023, 022…). **Il refuse de s'exécuter si un reversement en espèces existe déjà** : c'est une donnée financière qu'on ne supprime pas.
