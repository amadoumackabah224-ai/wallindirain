# Migration 020 — Tournées groupées

## Ce que fait la 020
- Le chef (ou l'administrateur) regroupe **2 commandes ou plus** (sans plafond) dans une tournée confiée à **un livreur**.
- Chaque commande reste suivie séparément : retrait, départ, livraison par code, échec, encaissement et paie **par commande**, comme avant.
- La tournée se ferme toute seule quand plus aucune commande n'est active. Elle peut être annulée (les commandes restent au livreur).
- Une commande ne peut être que dans **une seule tournée active**.
- Le chef peut noter le **coût réel** de la tournée (information seulement) : l'écran affiche la marge = frais de livraison encaissés − coût réel (ou paie prévue par le système).

## Ce qu'elle ne fait pas
- Aucune écriture d'argent, aucun changement de paie, de tarif ou de réglage. La rémunération des tournées reste à décider.
- Pas de notification du livreur, pas de répartition automatique.

## Mise en production (uniquement après autorisation)
1. Fusionner la branche `feature/tournees`. Render redéploie et applique la 020.
2. Vérifier : `SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 3;` doit montrer `020_tournees.sql`.
3. `SELECT * FROM fn_ledger_check();` doit rester vide.
4. Test dans l'application : créer une tournée de 2 commandes, la voir côté livreur, la livrer, vérifier la clôture.

## Retour arrière
Exécuter `docs/retour-arriere-020.sql` (avant ceux de 019, 018, 017). Il retire les tournées et restaure la remise à zéro de la 019, sans toucher aucune donnée financière. Retirer aussi le code déployé correspondant.
