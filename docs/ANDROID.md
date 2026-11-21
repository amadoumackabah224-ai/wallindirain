# Application Android (Capacitor)

L'application Android est une enveloppe Capacitor autour du site de production (https://wallindirain.onrender.com).
Le code reste unique : toute mise à jour du site apparaît dans l'application sans nouvelle publication sur le Play Store.
L'enveloppe n'a besoin d'être republiée que pour changer l'icône, le nom ou l'adresse.

## Ce qui est dans le dépôt
- `mobile/` : configuration Capacitor (`capacitor.config.json`), icônes sources (`resources/`), bannière Play Store (`play/banniere-1024x500.png`).
- `.github/workflows/android.yml` : compile le fichier sur GitHub (aucun Android Studio nécessaire). Le dossier `android/` est généré à chaque compilation.

## Étape 1 — Créer la clé de signature (une seule fois, à garder précieusement)
Sur un ordinateur avec Java :
    keytool -genkeypair -v -keystore upload.keystore -alias wallindirain -keyalg RSA -keysize 2048 -validity 10000
Sauvegardez `upload.keystore` et ses mots de passe dans un endroit sûr (jamais dans le dépôt). Perdue, la clé complique les mises à jour.
Encodez-la : `base64 -w0 upload.keystore` (sur Mac : `base64 -i upload.keystore`).

## Étape 2 — Secrets GitHub (Settings > Secrets and variables > Actions)
- `ANDROID_KEYSTORE_BASE64` : le texte encodé ci-dessus
- `ANDROID_KEYSTORE_PASSWORD` : mot de passe du fichier
- `ANDROID_KEY_ALIAS` : `wallindirain`
- `ANDROID_KEY_PASSWORD` : mot de passe de la clé (même valeur si identique)

## Étape 3 — Compiler
Onglet Actions > « Android (fichier Play Store) » > Run workflow. En quelques minutes, le résultat « wallindirain-android » contient :
- `wallindirain-signe.aab` : à envoyer au Play Store ;
- `app-debug.apk` : à installer directement sur un téléphone pour tester.

## Étape 4 — Play Console (compte développeur Google, 25 $ une fois)
- Créer l'application, nom « Wallindirain », langue français, gratuite.
- Envoyer le .aab (Production ou Test interne).
- Fiches : icône 512 (`frontend/assets/icon-512.png`), bannière `mobile/play/banniere-1024x500.png`, au moins 2 captures d'écran téléphone.
- Politique de confidentialité : adresse de la page légale de l'application.
- Formulaire « Sécurité des données » : téléphone, nom, adresses de livraison, documents d'identité des livreurs.
- Les nouveaux comptes personnels doivent, selon la règle actuelle de Google, mener un test fermé avec des testeurs pendant 14 jours avant la production (à vérifier dans la Play Console).

## Limites connues
- L'hébergeur actuel est au plan gratuit : le premier chargement après une période d'inactivité peut prendre plusieurs secondes.
- L'application nécessite du réseau (l'écran hors-ligne du site s'affiche sinon).
- Les notifications poussées système ne sont pas incluses (les notifications dans l'application fonctionnent).
- iOS : non couvert (nécessite un Mac, un compte Apple Developer et la validation de l'App Store).
- Le fichier n'a pas pu être compilé dans l'environnement de préparation (pas d'accès au SDK) : le premier lancement du workflow est le vrai test.
