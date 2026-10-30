# Migration 036 — Accords individuels de rémunération

## Ce que ça fait
- Chaque compte peut avoir **ses propres conditions**, conclues avec la personne, que vous **activez** vous-même :
  - **Livreur** (indépendant ou de Wallindirain) : paie par livraison, supplément de tournée, déplacement à vide, prime du jour. Fiche du livreur → « Accord de rémunération ».
  - **Agent ou chef d'équipe** : rémunération par commande confirmée et livrée. Utilisateurs → bouton « Accord ».
- Un accord a une **date d'entrée en vigueur** (maintenant, demain, dans 7 jours), une note, et reste dans l'**historique** avec son auteur. **Jamais rétroactif** : les missions déjà affectées (livreur) ou déjà confirmées (agent) gardent leurs conditions.
- **Mettre fin** à un accord : retour aux règles communes (barème des livreurs de Wallindirain s'il y en a un, sinon règles des indépendants ; rémunération commune des agents).
- Priorité : accord individuel → barème commun (livreurs de Wallindirain) → règles communes.

## Ce que ça NE fait PAS
- **Aucun accord n'existe** après la migration : tout est payé exactement comme avant.
- Aucun montant, tarif ou pourcentage existant n'est modifié. Les plafonds restent : la paie par livraison ne peut pas dépasser le tarif de la zone active la moins chère.
- Pas de salaire mensuel : seulement des montants par livraison / par commande livrée.
- Les « autres paramètres » par compte (au-delà de la paie des livreurs et des agents) ne sont pas inclus ; à demander séparément.

## Mise en production (uniquement après autorisation)
**Render applique la migration automatiquement au démarrage, dès la fusion.** À fusionner après `feature/rayons-zones`.
1. `SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 2;` → `036_accords_individuels.sql` en premier.
2. `SELECT count(*) FROM agent_terms;` → 0 ; `SELECT count(*) FROM courier_pay_scales WHERE courier_id IS NOT NULL;` → 0.
3. `SELECT * FROM fn_ledger_check();` → 0 ligne.

## Retour arrière
`docs/retour-arriere-036.sql`. Il **refuse de s'exécuter** si un accord individuel existe (conditions conclues avec des personnes, à conserver).
