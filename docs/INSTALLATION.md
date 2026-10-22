# Mise en service

> État de vérification : le serveur, la base, les sauvegardes et la restauration ont été **exécutés et testés**. Le fichier `docker-compose.yml` a été validé (syntaxe) mais **l'image Docker n'a pas pu être construite** dans l'environnement de développement (pas de moteur Docker). Faites le premier déploiement sur un serveur de test avant la production et suivez la liste de contrôle en fin de document.

## 1. Prérequis

- Un serveur Linux (2 vCPU / 2 Go de mémoire suffisent pour le pilote) avec Docker et Docker Compose.
- Un nom de domaine dont l'enregistrement DNS pointe vers l'adresse IP du serveur (nécessaire au certificat HTTPS automatique).
- Ports 80 et 443 ouverts. **Ne jamais ouvrir le port 5432** : la base n'est volontairement pas publiée.

## 2. Installation

```bash
git clone <votre dépôt> wallindirain && cd wallindirain/ops
cp .env.example .env
nano .env                     # remplacez TOUTES les valeurs (openssl rand -base64 24 pour les mots de passe)
docker compose up -d --build
docker compose logs -f app    # attendez « Wallindirain démarré »
```

L'ordre est automatique : la base démarre, le service `migrate` applique les migrations et définit le mot de passe du compte applicatif, puis l'application démarre, puis Caddy obtient le certificat HTTPS.

### Premier administrateur

```bash
docker compose run --rm -e ADMIN_PHONE=6XXXXXXXX -e ADMIN_NAME="Nom Prénom" -e ADMIN_PASSWORD='MotDePasseSolide123' \
  -e DB_OWNER_USER=postgres -e DB_OWNER_PASSWORD="$(grep ^DB_OWNER_PASSWORD .env | cut -d= -f2)" \
  migrate node src/create-admin.js
```

Le mot de passe doit contenir au moins 8 caractères, avec lettres et chiffres. Connectez-vous ensuite sur `https://votre-domaine`, créez le personnel (agents, chef, livreurs, magasinier) depuis l'onglet **Utilisateurs**, et ajustez les tarifs et rémunérations dans **Réglages**.

## 3. Variables d'environnement

| Variable | Rôle | Défaut |
|---|---|---|
| `DOMAIN` | domaine public (Caddy) | obligatoire |
| `DB_OWNER_PASSWORD` | compte propriétaire PostgreSQL (migrations, sauvegardes) | obligatoire |
| `DB_APP_PASSWORD` | compte applicatif `wld_app` (droits limités) | obligatoire |
| `CONTACT_PHONE` | numéro d'aide affiché | `624390707` |
| `MESSAGE_PROVIDER` | `simulated` ou `whatsapp` | `simulated` |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID` | requis si `whatsapp` (voir `docs/MESSAGES.md`) | vide |
| `WHATSAPP_TEMPLATE_CODE`, `WHATSAPP_TEMPLATE_INFO`, `WHATSAPP_LANG`, `WHATSAPP_CODE_BUTTON` | modèles approuvés par Meta | `wld_code`, `wld_info`, `fr`, `0` |
| `BACKUP_KEEP_DAYS` | durée de conservation des sauvegardes | 30 |
| `BACKUP_HOUR_UTC` | heure de la sauvegarde (UTC = Conakry) | 2 |
| `BACKUP_PATH` | dossier des sauvegardes sur le serveur | `./backups` |

Variables internes de l'application (déjà fixées par `docker-compose.yml`) : `NODE_ENV`, `HOST`, `PORT`, `TRUST_PROXY`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_OWNER_USER`, `DB_APP_USER`, `DB_POOL_MAX`, `DB_SSL`.

## 4. Messages WhatsApp / SMS

Par défaut (`MESSAGE_PROVIDER=simulated`), les messages (code de livraison, code de retrait, mot de passe oublié) sont **enregistrés dans la base mais pas envoyés**. Tant que cet état dure, personne ne reçoit de code : l'application n'est donc utilisable que pour des essais internes.

Pour l'envoi réel via l'API WhatsApp Business (Meta) : créer un compte Meta Business, un numéro vérifié, un jeton d'accès permanent, puis renseigner `MESSAGE_PROVIDER=whatsapp`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`. **Cette intégration est écrite (`backend/src/messenger.js`) mais n'a pas été testée contre l'API réelle de Meta.** Meta impose des *modèles de message approuvés* pour écrire à un client qui n'a pas écrit en premier : il faudra faire approuver trois modèles (code de livraison, code de retrait, réinitialisation) et probablement adapter `messenger.js` pour envoyer des messages de type `template`. Pour un fournisseur SMS, ajoutez une fonction dans l'objet `PROVIDERS` de `messenger.js` (une dizaine de lignes).

## 5. Sauvegardes

Le service `backup` fait une sauvegarde complète chaque jour à `BACKUP_HOUR_UTC`, la vérifie (`pg_restore --list`), la compresse et supprime celles de plus de `BACKUP_KEEP_DAYS` jours. Elles sont écrites dans `BACKUP_PATH`.

**Exigence du cahier des charges : sauvegarde hors du serveur principal.** Le dossier local ne suffit pas (si le serveur disparaît, les sauvegardes disparaissent avec lui). Au minimum, copiez-les chaque jour ailleurs, par exemple avec `rclone` vers un stockage distant (cron sur le serveur) :

```bash
0 4 * * * rclone copy /chemin/vers/backups remote:wallindirain-backups --max-age 48h
```

### Test de restauration (à faire avant le pilote, puis chaque mois)

```bash
docker compose exec backup sh /ops/restore-test.sh
```

Il sauvegarde, restaure dans une base temporaire, compare utilisateurs/commandes/mouvements/somme/journal, vérifie la cohérence comptable, puis supprime la base temporaire (aucun fichier n'est ajouté à vos vraies sauvegardes). Sans Docker : `PGHOST=… PGUSER=… PGPASSWORD=… PGDATABASE=wallindirain sh ops/restore-test.sh`.

### Restauration après un sinistre (nouveau serveur)

1. Installer Docker, récupérer le dépôt et votre fichier `.env`, remettre la dernière sauvegarde `.dump` dans le dossier `BACKUP_PATH`.
2. `cd ops && docker compose up -d db backup` (la base démarre vide).
3. Restaurer dans une base neuve (le script crée au passage le compte `wld_app` qui manque sur un serveur vierge) :
   `docker compose exec backup sh /ops/restore.sh /backups/wallindirain-AAAAMMJJTHHMMSSZ.dump wallindirain_restauree`
4. Mettre la base restaurée en service :
   ```bash
   docker compose stop backup
   docker compose exec db psql -U postgres -c "ALTER DATABASE wallindirain RENAME TO wallindirain_vide" -c "ALTER DATABASE wallindirain_restauree RENAME TO wallindirain"
   docker compose up -d --build        # l'étape migrate redéfinit le mot de passe applicatif ; aucune migration n'est rejouée
   ```
5. Vérifier : connexion d'un compte, `docker compose exec backup sh /ops/restore-test.sh`.

La séquence « sauvegarde → serveur PostgreSQL vierge → restauration → démarrage de l'application → connexion » a été jouée avec succès pendant le développement avec les mêmes scripts (données identiques, 0 incohérence comptable). Les commandes `docker compose` ci-dessus, elles, n'ont pas pu être exécutées là-bas : suivez-les une première fois sur un serveur de test.

## 6. Mise à jour du code

```bash
git pull && cd ops && docker compose up -d --build
```

Les migrations déjà appliquées ne sont jamais rejouées (table `schema_migrations`). **Ne modifiez jamais une migration déjà déployée** : ajoutez un nouveau fichier `00N_….sql`.

## 7. Liste de contrôle avant le pilote

- [ ] Déploiement d'essai réussi sur un serveur de test (l'image Docker n'a pas été construite pendant le développement)
- [ ] HTTPS actif, et `https://domaine/api/public/info` répond
- [ ] Mots de passe de `.env` générés aléatoirement, `.env` hors du dépôt
- [ ] Premier administrateur créé, comptes de démonstration absents (`seed-demo` n'a jamais été lancé)
- [ ] Envoi réel des messages validé de bout en bout (code de livraison reçu sur un vrai téléphone)
- [ ] Sauvegarde copiée hors du serveur **et** `restore-test.sh` réussi sur le serveur de production
- [ ] Marge, tarifs par commune et rémunérations validés par la direction (section 12 du cahier des charges)
- [ ] Contrats, conditions générales et fiscalité vus avec un juriste (hors périmètre du code)
