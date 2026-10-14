# Sécurité

Ce document décrit ce qui est **en place et testé**, puis ce qui **n'est pas couvert**. Aucun système n'est « inviolable » : avant d'ouvrir à de vrais clients avec de l'argent réel, faites réaliser un test d'intrusion par un tiers.

## En place (vérifié par les tests automatiques)

**Authentification**
- Mots de passe : PBKDF2-HMAC-SHA512, 210 000 itérations, sel aléatoire par mot de passe, comparaison en temps constant. Minimum 8 caractères avec lettres et chiffres.
- Un numéro inexistant coûte le même temps de calcul qu'un vrai (pas de fuite par le délai).
- Blocage du compte 15 minutes après 5 échecs (appliqué dans la base).
- Sessions de 12 h ; seule l'**empreinte** du jeton est stockée (une fuite de la base ne donne aucune session valide) ; la déconnexion révoque la session côté serveur ; suspendre un compte coupe ses sessions.
- Mot de passe oublié : code à 6 chiffres, 15 minutes, 5 essais, un seul usage ; réponse identique que le numéro existe ou non ; toutes les sessions sont coupées après changement.
- Limitation de débit (par adresse et par numéro) sur connexion, inscription, mot de passe oublié, commande publique, retrait, livraison.

**Contrôle d'accès**
- Rôle vérifié **deux fois** : garde dans `routes.js` et `_require` dans la fonction SQL.
- Cloisonnement des données par rôle (fournisseur ↔ vendeur ↔ client) vérifié par test sur le parcours complet.
- Compte PostgreSQL applicatif limité aux fonctions publiées : pas de lecture des mots de passe, codes ou sessions, aucune écriture directe.

**Intégrité de l'argent**
- Tous les mouvements en ajout seul ; montants d'une commande figés ; chaque livraison vérifie que fournisseur + vendeur + Wallindirain = argent encaissé ; `fn_ledger_check()` détecte les incohérences.
- Livraison impossible sans le code client (5 essais, puis blocage ; il faut une décision du chef pour réaffecter).
- Retrait impossible sans identité vérifiée **et** code à 6 chiffres ; paiement manuel avec référence tracée.
- Verrous contre les doubles dépenses et les doubles prises de commande (testés en simultané).

**Application web**
- Toutes les requêtes SQL sont paramétrées (test d'injection SQL passé) ; entrées validées (type, taille, caractères de contrôle) ; corps limité à 64 Ko.
- Protection CSRF : cookie SameSite=Strict + en-tête obligatoire + contrôle de l'origine.
- En-têtes : politique de sécurité de contenu stricte (`default-src 'self'`, aucun script ni style en ligne, aucune ressource externe), `X-Frame-Options: DENY`, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, HSTS en production.
- Fichiers statiques : protection contre la sortie du dossier (`../`, `%2f`) testée.
- Erreurs internes : message générique au client, détail dans les journaux seulement.

**Traçabilité** : `audit_log` (dépôts, retraits, tarifs, validations, caisses, retours, réglages), historique de chaque statut de commande, chaque appel signé (agent + call center), messages tracés.

## Non couvert ou à renforcer (à connaître)

1. **Pas de double authentification** (2FA). Un compte administrateur compromis donne un contrôle total ; choisissez un mot de passe long et unique. À ajouter avant le déploiement à grande échelle.
2. **Limiteur de débit en mémoire** : il est par processus. Avec plusieurs instances de l'application, chaque instance compte séparément. Pour plusieurs instances, déplacez-le vers la base ou un cache partagé.
3. **Client PostgreSQL maison** (`pg.js`) : testé sur ce que l'application utilise, mais moins éprouvé que le paquet `pg` de référence.
4. **Pas d'analyse de vulnérabilités tierces ni de test d'intrusion** réalisés. Aucune certification.
5. **Pas de test de charge** réalisé (prévu en phase 2 du plan du cahier des charges).
6. **Chiffrement des données au repos** : non géré par l'application ; à activer au niveau du disque du serveur ou de l'hébergeur. Les sauvegardes contiennent toutes les données : chiffrez-les avant de les copier hors du serveur.
7. **La pièce d'identité** n'est stockée que sous forme de référence texte, pas de scan ; la vérification est manuelle par l'administrateur.
8. **Envoi des messages** : tant que `MESSAGE_PROVIDER=simulated`, aucun code n'est reçu. Le texte des messages (qui contient les codes) reste dans la table `messages` ; limitez l'accès à la base et purgez régulièrement les anciens messages.
9. Données personnelles (noms, téléphones, adresses de clients guinéens) : vérifiez avec un juriste les obligations locales de protection des données.

## Bonnes pratiques d'exploitation

- Ne jamais publier le port PostgreSQL ; ne jamais commiter `.env` ; changer tous les mots de passe d'exemple.
- Mises à jour régulières du système, de Docker et des images (`docker compose pull && docker compose up -d --build`).
- Surveiller : erreurs 5xx dans `docker compose logs app`, `ledger_problems` du tableau de bord, messages en échec, espace disque des sauvegardes.
- Conserver les sauvegardes hors du serveur, tester la restauration chaque mois.
