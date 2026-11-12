# SMS par Nimba SMS

Les codes (livraison, retrait, mot de passe oublié, mot de passe provisoire) peuvent partir par SMS au lieu de WhatsApp.
**Désactivé par défaut** : tant que ce n'est pas branché, rien ne change.

## Brancher Nimba SMS
1. Créez votre compte sur https://nimbasms.com et achetez un paquet de SMS.
2. Faites valider un **nom d'expéditeur** (SENDER NAME) auprès de Nimba.
3. Dans l'hébergeur (Render : Environment), ajoutez :
   - `NIMBA_SERVICE_ID` : le SERVICE ID
   - `NIMBA_SECRET_TOKEN` : le SECRET TOKEN
   - `NIMBA_SENDER_NAME` : le nom d'expéditeur validé (respectez majuscules et minuscules)
   - facultatif : `NIMBA_PHONE_FORMAT` = `international` (par défaut, 224…) ou `local` (9 chiffres) si Nimba refuse le premier format
4. Redémarrez le service.
5. Administration → Réglages → Fonctions : la carte **SMS (Nimba SMS)** passe à « Connecté » et affiche le solde.
6. **Envoyer un SMS test** à votre numéro. Si c'est bon, allumez **Codes par SMS**.

## Sécurité
- Les identifiants ne sont **jamais** en base, ni dans le code, ni affichés dans l'application.
- Si les identifiants sont retirés alors que le réglage est allumé, les codes repartent par le canal habituel : rien n'est perdu.
- Allumer le réglage est refusé tant que les identifiants ne sont pas enregistrés sur le serveur.

## Retour arrière
Éteindre « Codes par SMS ». Pour retirer aussi la migration : `docs/retour-arriere-064.sql`.
