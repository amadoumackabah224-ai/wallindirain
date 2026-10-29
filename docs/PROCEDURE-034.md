# Migration 034 — Agent payé à la livraison, call center facturé seulement si livré, trophées

## Ce que ça change
- **Rémunération de l'agent** : elle n'est plus versée à la confirmation, mais **seulement quand la commande est confirmée ET livrée**. Une commande confirmée puis annulée, échouée ou retournée ne rapporte rien à l'agent.
- **Frais de call center** : déjà prélevés seulement à la livraison ; ils ne sont **plus** non plus facturés au vendeur lors d'un retour (cas « produit défectueux du vendeur lui-même » : seuls les frais de livraison restent).
- Les libellés des réglages sont mis à jour (« …confirmée et livrée », « …par commande livrée »).
- **Trophées** : nouveau dessin Wallindirain : coupe au monogramme W posée sur un colis (flèche de livraison), étoiles de rang, couronne et gemme pour les niveaux élevés. Visuel seulement.

## Ce que ça NE change PAS
- Aucun montant, tarif, pourcentage, frais, marge ni bonus (1 000 GNF par agent, 5 000 call center : valeurs inchangées).
- Aucune écriture d'argent passée n'est touchée.
- Une commande déjà confirmée avant la mise à jour dont l'agent a déjà été payé **n'est pas payée deux fois**. Une commande confirmée mais pas encore livrée au moment de la mise à jour : l'agent a déjà reçu sa paie, rien de plus ne lui est versé.

## Mise en production (uniquement après autorisation)
**Render applique la migration automatiquement au démarrage, dès la fusion.**
1. Fusionner `feature/medaillons-agent-livre` (après les 5 branches précédentes, dont elle dépend).
2. `SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 2;` → `034_agent_paye_a_la_livraison.sql` en premier.
3. `SELECT * FROM fn_ledger_check();` → 0 ligne.
4. Réglages : les libellés « confirmée et livrée » apparaissent.
5. Profil vendeur : le trophée s'affiche dans Statistiques.

## Retour arrière
`docs/retour-arriere-034.sql`. Il **refuse de s'exécuter** si un agent a déjà été payé à la livraison (aucune donnée d'argent perdue).
