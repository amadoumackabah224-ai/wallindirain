# Application installable (PWA)

## Ce que ça fait
- Une icône Wallindirain peut être ajoutée à l'écran d'accueil (Android : bouton « Installer » dans Profil, ou menu du navigateur ; iPhone : Partager → « Sur l'écran d'accueil »).
- L'application s'ouvre en plein écran et rouvre **la dernière page** où l'on était.
- La **coque de l'application** (pages, styles, logo) est gardée sur le téléphone : l'app s'ouvre plus vite, et sans réseau elle affiche « Pas de connexion » avec un bouton « Réessayer » (la personne n'est pas déconnectée).
- Un bandeau « hors connexion » apparaît quand le réseau coupe.

## Ce que ça NE fait PAS
- **Aucune donnée privée n'est gardée** : les appels `/api` (commandes, argent, profil) ne passent jamais par le cache. Hors connexion, on ne voit donc pas de données et on ne peut rien envoyer.
- Pas de file d'attente d'actions hors connexion (une commande ne part qu'avec du réseau).

## Pour les développeurs
- Fichiers : `frontend/sw.js` (service worker), `frontend/manifest.webmanifest`, `frontend/js/pwa.js`.
- **Quand on ajoute un fichier dans `frontend/js/`, il faut l'ajouter à la liste `SHELL` de `sw.js`** : le test `backend/tests/pwa.test.js` le vérifie.
- Stratégie : réseau d'abord (la dernière version est toujours servie en ligne), copie locale en secours hors connexion. Changer `VERSION` dans `sw.js` seulement pour vider les anciens caches.
- Retour arrière : supprimer `sw.js` et l'appel `startPwa()` de `main.js`. Un navigateur qui a déjà le service worker le retire au prochain chargement si `sw.js` répond « 404 » ; sinon, publier un `sw.js` qui appelle `self.registration.unregister()`.
