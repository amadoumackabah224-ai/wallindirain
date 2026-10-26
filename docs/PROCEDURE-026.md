# Migration 026 — Modes de paie d'une tournée groupée (normal, A, B)

## Ce que ça fait
Le chef d'équipe (call center) choisit, **en créant la tournée**, comment le livreur est payé. Le choix est **figé** : ni le chef ni le réglage ne peuvent le changer ensuite.

| Mode | Paie du livreur |
|---|---|
| **Habituelle** (par défaut) | Chaque commande garde sa paie (et le bonus de la 025, à 0). Rien ne change. |
| **A — pourcentage de tournée** | Le livreur reçoit un pourcentage (réglage « mode A ») des frais de **chaque** commande livrée de la tournée. |
| **B — 1ʳᵉ normale, les autres partagées** | La 1ʳᵉ commande livrée garde la paie habituelle ; les suivantes sont partagées selon le réglage « mode B » (**5000 = 50/50**). |

- Le **livreur voit le mode et son gain total prévu avant d'accepter** (carte « À accepter »). Il peut refuser sans pénalité : c'est lui qui a le dernier mot.
- Le mode B suit **l'ordre de passage** : le chef règle l'ordre (↑↓) avant l'acceptation ; la 1ʳᵉ commande *livrée* garde la paie habituelle.
- **La paie par commande n'est pas modifiée.** L'écart (en plus ou en moins) est écrit **une seule fois à la clôture**, sous « Ajustement de tournée » (contrepartie sur la plateforme), et **seulement s'il y a au moins 2 commandes livrées**. Une seule commande livrée = paie habituelle.
- La paie d'une commande ne dépasse jamais ses frais de livraison. Les pourcentages sont limités à 90 % (9000) ; le contrôle comptable (`fn_ledger_check`) vérifie qu'un ajustement n'est pas écrit deux fois.

## Réglages (administrateur) — décision du propriétaire
- « Tournée groupée, mode A : part du livreur… » : **0 au départ = mode A indisponible**. Exemple : 6000 = 60 % au livreur, 40 % à Wallindirain.
- « Tournée groupée, mode B : part du livreur sur les commandes à partir de la 2ᵉ » : **5000** au départ (50/50, comme demandé). N'a d'effet que si le chef choisit le mode B.
- Aucun pourcentage existant (`courier_share_bps`, `courier_pay`, tarifs) n'est modifié.

Exemple (3 commandes à 20 000 GNF, paie habituelle 15 000) : habituelle 45 000 · A à 60 % = 36 000 · B = 15 000 + 10 000 + 10 000 = 35 000.

## Mise en production (uniquement après autorisation)
1. Fusionner `feature/tournee-modes-paie` **après** la 025 (cette branche contient la 025). Render applique la 026.
2. `SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 3;` → `026_tournee_modes_paie.sql` en premier.
3. `SELECT * FROM fn_ledger_check();` → 0 ligne.
4. Test sans risque : créer une tournée en mode « Habituelle » ; le mode A donne une erreur tant que son réglage est à 0.

## Retour arrière
`docs/retour-arriere-026.sql` (avant 025). **Il refuse de s'exécuter si un ajustement a été versé ou si une tournée en mode A ou B existe** (donnée financière).
