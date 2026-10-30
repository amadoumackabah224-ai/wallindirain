# Migration 037 — Vendeurs de l'étranger

## Ce que ça fait
- Un **vendeur** peut s'inscrire avec un **numéro étranger** (case « Je vends depuis l'étranger », numéro avec l'indicatif : +33…, +221…). Le numéro +224 reste un numéro guinéen (saisi sur 9 chiffres).
- Son compte reste **en attente** jusqu'à ce que vous l'activiez (Utilisateurs → Activer), comme un fournisseur. Il se connecte ensuite avec son numéro international.
- **Retraits à la main**, comme aujourd'hui : il écrit ses coordonnées de versement (opérateur, pays, numéro ou IBAN) dans le mode « Autre ». Vous l'envoyez vous-même, puis vous notez la référence et joignez la capture. Les montants restent en francs guinéens ; **aucun taux de change n'est inventé** : c'est vous qui décidez de la somme à envoyer.
- Il peut aussi choisir Orange Money / MTN MoMo avec un numéro guinéen (par exemple celui d'un proche).
- Il vend le catalogue Wallindirain comme les autres vendeurs ; ses clients et les livraisons restent en Guinée.

## Ce que ça NE fait PAS
- **Fournisseurs, livreurs, agents, magasinier : numéros guinéens seulement.**
- Les numéros des **clients** restent guinéens (9 chiffres).
- Aucun montant, tarif ni taux n'est modifié. Aucun paiement international automatique.
- Le stockage de produits envoyés par un vendeur de l'étranger n'est pas inclus (les produits propres d'un vendeur demandent une adresse de récupération en Guinée).
- Les messages (codes, alertes) vers un numéro étranger dépendent de votre service de messages : à vérifier avant l'ouverture publique. En mode simulé, rien n'est envoyé.

## Mise en production (uniquement après autorisation)
**Render applique la migration automatiquement au démarrage, dès la fusion.**
1. `SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 2;` → `037_comptes_etrangers.sql` en premier.
2. `SELECT count(*) FROM users WHERE phone LIKE '+%';` → 0 (aucun compte étranger créé par la migration).
3. `SELECT * FROM fn_ledger_check();` → 0 ligne.
4. Essai : inscrivez un vendeur de test avec un numéro étranger, activez-le, faites un retrait « Autre » et payez-le à la main.

## Retour arrière
`docs/retour-arriere-037.sql`. Il **refuse de s'exécuter** si un compte avec numéro étranger ou un versement « autre » existe.
