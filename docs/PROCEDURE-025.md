# Migration 025 — Tournée proposée au livreur et bonus de tournée

## Ce que ça fait
1. **La tournée est proposée** : le chef la crée (arrêts dans l'ordre choisi). Le livreur voit une carte « À accepter » avec ses arrêts, sa paie par commande et le bonus possible. Il clique **« J'accepte la tournée »** ou **« Refuser »** (sans pénalité).
2. **Avant acceptation, il ne peut pas récupérer les colis** (message : « Acceptez d'abord la tournée »).
3. **Refus du livreur, ou annulation par le chef avant acceptation** : les commandes redeviennent « confirmées » et reviennent à affecter.
4. **Bonus de tournée** : un réglage de l'administrateur, **à 0 au départ**, « Tournée groupée : bonus versé au livreur pour chaque commande livrée à partir de la 2ᵉ ». Il est **figé à la création** de la tournée, versé **une seule fois** à la clôture (ou à l'annulation d'une tournée déjà commencée), **seulement pour les commandes livrées**, et **jamais au-delà de la marge de livraison** : la création d'une tournée est refusée si paie + bonus dépasse les frais de livraison.
5. Le portefeuille du livreur affiche « Bonus de tournée ». Le contrôle comptable (`fn_ledger_check`) vérifie aussi qu'un bonus n'est pas versé deux fois.

## Ce que ça ne fait pas
- **La paie par commande n'est pas modifiée.** Tant que le réglage reste à 0, rien ne change dans l'argent.
- Pas de notification automatique du livreur (il voit la tournée en ouvrant l'application).

## Comment fixer le bonus (décision du propriétaire)
Réglages de l'administrateur → « Tournée groupée : bonus… ». Exemple : 2 000 GNF. Pour 5 commandes livrées : 4 × 2 000 = 8 000 GNF de bonus. Je recommande de commencer par quelques tournées avec le coût réel saisi, puis d'ajuster.

## Mise en production (uniquement après autorisation)
1. Fusionner `feature/tournee-acceptation-bonus`. Render applique la 025.
2. `SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 3;` → `025_tournee_acceptation_bonus.sql` en premier.
3. `SELECT * FROM fn_ledger_check();` → 0 ligne.
4. Test : créer une tournée de 2 commandes → côté livreur, accepter, récupérer, livrer ; vérifier qu'aucun bonus n'apparaît (réglage à 0).

## Retour arrière
`docs/retour-arriere-025.sql` (avant 024, 023…). **Il refuse de s'exécuter si un bonus a déjà été versé** (donnée financière). Les tournées « proposées » ou « refusées » deviennent « annulées ».
