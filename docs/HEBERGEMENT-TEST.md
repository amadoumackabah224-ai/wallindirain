# Hébergement de TEST gratuit (Render + Neon)

**À utiliser uniquement pour des essais, jamais avec de vraies données de clients ni d'argent réel.** Pour la production, utilisez un serveur VPS (voir `INSTALLATION.md`).

## Limites à connaître
- Render (offre gratuite) : le site s'endort après 15 minutes sans visite et met environ 1 minute à se réveiller ; 750 heures gratuites par mois.
- Neon (base gratuite) : 0,5 Go, se met en veille quand elle est inactive (premier accès un peu plus lent).
- Pas de sauvegarde automatique. Les messages WhatsApp/SMS sont simulés (voir l'écran Journal de l'administrateur).
- **Non vérifié sur Render ni sur Neon à la date d'écriture** : seuls les tests locaux avec un compte propriétaire non superutilisateur (CREATEROLE) ont été joués.

## Principe
`render.yaml` décrit le service web. Au démarrage, `backend/src/hosted-start.js` : applique les migrations sur la base indiquée par `DATABASE_URL`, crée le premier administrateur (si aucun n'existe, à partir de `ADMIN_*`), puis lance le serveur.

## Variables (saisies dans Render)
| Variable | Valeur |
|---|---|
| `DATABASE_URL` | Adresse **directe** (sans `-pooler`) fournie par Neon, du type `postgresql://utilisateur:motdepasse@hôte/base?sslmode=require` |
| `DB_APP_PASSWORD` | Générée automatiquement par `render.yaml` |
| `ADMIN_PHONE` / `ADMIN_NAME` / `ADMIN_PASSWORD` | Premier administrateur (9 chiffres ; mot de passe 8+ caractères, lettres et chiffres) |
| `HOST`, `TRUST_PROXY`, `NODE_ENV` | Déjà fixées dans `render.yaml` |

## Mode test : retraits manuels et codes visibles
- Aucun paiement automatique : le retrait est **manuel mais numérique**. La personne enregistre son numéro de versement (Orange Money ou MTN MoMo) à l'inscription ; sa demande de retrait part toujours vers ce numéro. L'administrateur envoie l'argent à la main, puis joint la **capture d'écran** du transfert : la personne la voit dans son portefeuille.
- Le livreur peut déclarer que le client a payé par transfert (capture obligatoire) et **reverser par transfert** l'argent encaissé (onglet « Caisse ») ; l'administrateur contrôle la capture dans l'onglet « Reversements » et saisit le montant réellement reçu (tout manque est débité au livreur).
- `SHOW_TEST_CODES=1` (déjà dans `render.yaml`) rend lisibles, dans Journal > Messages, les codes de retrait et de réinitialisation, puisque les messages sont simulés. Le serveur refuse de démarrer avec cette variable si un vrai fournisseur de messages est configuré.
- Code de livraison : **désactivé par défaut**, le livreur valide la livraison d'un geste. Réactivable dans Réglages (« Code de livraison à 4 chiffres obligatoire » = 1).
- Les captures sont stockées dans la base (600 Ko maximum chacune, JPEG/PNG/WebP vérifiés côté serveur) : sur la base gratuite de 0,5 Go, surveillez la place.

## Dépannage
- « Le compte de DATABASE_URL n'a pas le droit de créer un rôle » : la base ne laisse pas créer le rôle `wld_app` ; utilisez une base qui l'autorise.
- Le site met longtemps à répondre : il se réveille (voir limites).
- Erreur de connexion TLS : vérifiez que l'adresse n'est pas celle du « pooler ».
