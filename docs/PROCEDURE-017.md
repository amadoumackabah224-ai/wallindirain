# Procédure — étape 0 « protections » (migration 017)

**Rien de ceci n'est fait automatiquement. Ne pas fusionner ni déployer avant d'avoir terminé les points 1 à 4 et donné un accord explicite.**

## 1. Rapport sur la VRAIE base de production (lecture seule)
Ouvrir la console SQL de Neon sur la branche principale (production) et exécuter `docs/rapport-production-017.sql` requête par requête (7 requêtes, que des SELECT).

| # | Ce qu'on cherche | Résultat attendu | Si ce n'est pas le cas |
|---|---|---|---|
| 1 | Écritures de règlement en double | 0 ligne | **NE PAS migrer** : la migration s'arrête d'elle-même. Envoyer le résultat, on étudie, rien n'est corrigé automatiquement. |
| 2 | Commandes dont la paie livreur > frais | 0 ligne | Anomalie existante : envoyer le résultat, ne rien corriger. |
| 3 | Zones actives dont le tarif < paie fixe (si pourcentage = 0) | 0 ligne | Ajuster les tarifs à la main plus tard ; la création de commandes dans ces zones sera refusée. |
| 4 | Contrôle comptable `fn_ledger_check()` | 0 ligne | Anomalie comptable existante : envoyer le résultat. |
| 5 | Zones actives à tarif 0 | 0 ligne | Désactiver la zone ou fixer son tarif (décision humaine). |
| 6 | Instantané (nombres et sommes) | À noter tel quel | Sert de comparaison avant/après. |
| 7 | Dernière migration appliquée | `016_accord_textes.sql` | Autre valeur : arrêter et signaler. |

## 2. Copie de test sur Neon
1. Neon → Branches → créer une branche depuis la production (copie des données).
2. Pointer un `DATABASE_URL` de test vers cette branche (jamais celui de production).
3. Dans `backend` : `node src/migrate.js`. Attendu : « 017_protections.sql » appliquée.
4. Réexécuter la requête 6 : tous les nombres et sommes sont **identiques** à l'avant ; `frais_min_actif`, `part_livreur`, `paie_fixe` inchangés.
5. Réexécuter 1 à 5 : toujours 0.
6. Essayer une commande de test par le formulaire vendeur, double clic compris : une seule commande.

## 3. Retour arrière (à essayer sur la copie)
Exécuter `docs/retour-arriere-017.sql` sur la branche de test : il retire la table des clés, le déclencheur, les index et les contrôles, restaure les anciennes fonctions et leurs droits, et efface la ligne `017_protections.sql` de `schema_migrations`. Il ne touche à aucune donnée financière. Retirer aussi le code déployé correspondant (sinon les formulaires enverront une clé inutile, sans danger, mais le serveur appellera des fonctions supprimées).

## 4. Seulement ensuite
Accord explicite → fusion de `feature/protections` → la migration s'applique au démarrage. Sauvegarder (branche Neon) juste avant.

## Journal des refus du garde-fou : limites
- Écrit par le serveur **après** le refus, dans une transaction séparée : si le serveur s'arrête entre les deux, ou si cette écriture échoue, le refus a bien lieu mais n'est pas journalisé.
- Au plus une ligne par minute pour un même vendeur (ou client anonyme), parcours et zone : la fréquence réelle des refus n'est donc pas comptée. Un client anonyme qui change de zone peut écrire une ligne par zone connue (limité par la limite de requêtes par adresse).
- Visible dans le journal d'audit de l'administrateur : action `order_refused_pay_guard`, zone, parcours (`vendeur`, `lien`, `import`). Les parcours « api directe » en base ne passent pas par ce journal.
