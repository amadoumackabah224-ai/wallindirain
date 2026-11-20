# Sauvegardes de la base

## Ce qui existe
1. **Neon** garde l'historique de la base et permet de revenir en arrière dans le temps (la durée dépend de votre formule). C'est la première protection.
2. **Sauvegarde quotidienne chiffrée sur GitHub** (`.github/workflows/sauvegarde.yml`) : chaque nuit, une copie complète est faite, **restaurée dans une base vide pour vérifier qu'elle fonctionne** (0 incohérence comptable exigée), chiffrée, puis conservée 30 jours. Si l'un de ces contrôles échoue, GitHub vous envoie un e-mail.
3. Pour un serveur à vous (Docker) : `ops/backup.sh`, `ops/restore.sh`, `ops/restore-test.sh`.

## Important : le dépôt GitHub est public
Tant que le dépôt est public, la sauvegarde nocturne est **vérifiée (copie + restauration test) mais pas conservée**, car n'importe qui pourrait la télécharger. Passez le dépôt en **privé** (Settings > General > Danger Zone > Change visibility) : la conservation de 30 jours s'active alors toute seule. Cela protège aussi votre code. Render continue de fonctionner avec un dépôt privé.

## À faire une seule fois (vous)
Dans GitHub > Settings > Secrets and variables > Actions > New repository secret :
- `DATABASE_URL_BACKUP` : l'adresse **directe** de la base Neon (sans `-pooler`).
- `BACKUP_PASSPHRASE` : une longue phrase secrète. **Gardez-la aussi dans un gestionnaire de mots de passe** : sans elle, aucune sauvegarde ne peut être relue. Ne l'envoyez jamais par message.
Puis Actions > « Sauvegarde de la base » > Run workflow pour essayer tout de suite.

## Récupérer une sauvegarde
1. Actions > dernier passage > télécharger `sauvegarde-chiffree`.
2. Déchiffrer : `openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in wallindirain-AAAAMMJJ.dump.enc -out wallindirain.dump` (la phrase secrète est demandée).
3. Restaurer dans une base **vide** : `pg_restore --no-owner -d <base> wallindirain.dump`, puis `ops/restore.sh` si vous utilisez Docker.

## Bon à savoir
Une sauvegarde contient toutes les données personnelles : elle est chiffrée avant d'être conservée, et le dépôt doit rester **privé**. Faites un essai de récupération complet une fois par mois.
