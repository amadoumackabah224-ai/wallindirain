# Migration 066 : alertes graves pour les administrateurs

## Ce que ça fait
Les administrateurs sont prévenus (cloche dans l'application + message WhatsApp ou simulé) quand :
- une **erreur interne** survient sur le serveur ;
- le **contrôle des comptes** détecte une anomalie (à vérifier avant tout paiement) ;
- **3 messages ou plus** n'ont pas pu partir en 30 minutes, ou un message attend depuis plus de 15 minutes.

Au plus une alerte par type et par tranche de 30 minutes. Aucune donnée personnelle dans l'alerte (seulement le début du chemin de la page en erreur). Aucun montant n'est touché.
Réglage « Alertes techniques aux administrateurs » : 1 = actif (par défaut), 0 = coupé.

## Panne totale du site
Un site qui tombe ne peut pas se prévenir lui-même. Utilisez un surveillant extérieur gratuit :
1. Créez un compte sur UptimeRobot (ou équivalent).
2. Ajoutez un moniteur « HTTP(s) » sur `https://VOTRE-SITE/api/public/info`, toutes les 5 minutes.
3. Choisissez comme contact votre e-mail (et le SMS ou l'application mobile du service si disponible).
Remarque : sur l'hébergement gratuit Render, le site s'endort sans visite ; le surveillant le réveille aussi toutes les 5 minutes, ce qui aide en attendant un plan payant.

## Sauvegarde et restauration
Les scripts `ops/backup.sh`, `ops/restore.sh` et `ops/restore-test.sh` existent (voir `docs/INSTALLATION.md`). Sur Neon, la base garde aussi un historique de restauration : testez-le une fois sur une copie (« branche ») avant le lancement.

## Retour arrière
`docs/retour-arriere-066.sql` retire les fonctions et le réglage. Les notifications déjà créées restent.
