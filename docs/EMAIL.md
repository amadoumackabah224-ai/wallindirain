# Adresse e-mail : connexion et mot de passe oublié

## Ce que ça fait
- Chaque personne peut ajouter son adresse e-mail (à l'inscription ou dans **Profil → Adresse e-mail**).
- Un **code à 6 chiffres** est envoyé à cette adresse : tant qu'il n'est pas saisi, l'adresse n'est pas « confirmée » et ne sert à rien (personne ne peut prendre l'adresse d'un autre).
- Une fois confirmée : on se connecte avec le **numéro OU l'adresse e-mail**, et le code « mot de passe oublié » (ainsi que le mot de passe temporaire envoyé par l'administration) arrive **dans la boîte e-mail**, plus par message au numéro.
- Sans adresse confirmée : le code part par message au numéro (comme avant). Sans fournisseur de messages, il n'arrive pas : c'est pour cela qu'il faut une adresse e-mail confirmée.
- Changer d'adresse oblige à la reconfirmer ; l'ancienne adresse reçoit une alerte.
- Une adresse confirmée appartient à un seul compte.

## Ce qu'il faut faire pour envoyer de vrais e-mails (gratuit, sans nom de domaine)
Render (offre gratuite) bloque l'envoi d'e-mails classique : on passe par **Brevo** (formule gratuite, environ 300 e-mails par jour).

1. Créez un compte sur https://www.brevo.com avec votre adresse (ex. votre Gmail).
2. Dans Brevo : **Expéditeurs, domaines** → **Ajouter un expéditeur** : indiquez l'adresse qui apparaîtra comme expéditeur (ex. votre Gmail ou une adresse pro). Brevo vous envoie un e-mail de confirmation : cliquez dessus.
3. Dans Brevo : **SMTP et API** → **Clés API** → créez une clé et copiez-la.
4. Dans Render → votre service → **Environment**, ajoutez ou modifiez :
   - `EMAIL_PROVIDER` = `brevo`
   - `EMAIL_API_KEY` = la clé copiée
   - `EMAIL_FROM` = l'adresse d'expéditeur confirmée à l'étape 2
   - `EMAIL_FROM_NAME` = `Wallindirain`
   - **Supprimez `SHOW_TEST_CODES`** : le serveur refuse de démarrer si elle reste avec un vrai fournisseur.
5. Sauvegardez : Render redémarre. Ajoutez votre adresse dans Profil et confirmez-la pour tester.
6. Renseignez aussi `LEGAL_EMAIL` (adresse de contact affichée dans les mentions légales).

Facultatif : `ADMIN_EMAIL` (adresse de l'administrateur créé au premier démarrage ; à confirmer ensuite dans Profil).

## Adresse « professionnelle » (nom@votre-domaine.com)
C'est un choix à faire de votre côté : il faut acheter un nom de domaine (environ 10 à 15 € par an), puis créer des boîtes avec un service comme Zoho Mail (offre gratuite) ou Google Workspace. Ensuite, dans Brevo, ajoutez et authentifiez ce domaine (enregistrements DNS) et utilisez `contact@votre-domaine.com` comme `EMAIL_FROM`. Sans domaine, tout fonctionne avec une adresse Gmail comme expéditeur, mais les e-mails risquent plus d'arriver dans les courriers indésirables.

## Limites à connaître
- Les clients finaux (livraison) n'ont pas de compte : leur code de livraison reste lié au téléphone ; l'option « code de livraison » est désactivée par défaut.
- Brevo reçoit l'adresse et le texte du message : prestataire à déclarer (voir `docs/CONFORMITE-DONNEES.md`).
- Le texte des codes est effacé de la base dès que l'envoi réel réussit.
