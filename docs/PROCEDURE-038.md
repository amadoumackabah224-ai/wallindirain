# Migration 038 : canal d'origine des commandes

## Ce que ça fait
- Ajoute à chaque commande un canal facultatif : Facebook, WhatsApp, TikTok, Instagram, site web, appel direct, autre.
- Le vendeur le choisit en créant une commande (ou le précise ensuite), le voit en badge dans sa liste, et lit « Mes commandes par canal » dans ses chiffres.
- **Éteint par défaut** : réglage `feature_order_channel` = 0. Tant qu'il vaut 0, rien ne change pour les vendeurs.
- L'administrateur l'allume dans Réglages (valeur 1).

## Ce que ça ne fait pas
- Aucun montant, aucune règle d'argent, aucune commande existante n'est modifiée (colonne ajoutée vide).
- Pas d'importation automatique depuis Facebook/WhatsApp/TikTok : le canal est déclaré par le vendeur.
- L'import Google Sheet ne renseigne pas encore le canal.

## À la mise en production
- Render applique la migration automatiquement au démarrage après fusion.
- Vérifier ensuite : `SELECT value FROM settings WHERE key = 'feature_order_channel'` doit renvoyer 0.

## Retour arrière
`docs/retour-arriere-038.sql` : refuse si des commandes ont déjà un canal, sinon retire la colonne, la fonction et le réglage.
