# Migrations 052-053 : inscription « finances seulement » (compte membre)

## Ce que ça fait
- Une personne qui ne veut **pas** utiliser les services Wallindirain (commandes, livraisons) peut créer un **compte membre** pour gérer seulement son argent : comptes (espèces, Orange Money, MTN MoMo, banque, épargne), transactions, budgets et objectifs, contacts. Gratuit, ou Pro (même abonnement que les autres).
- Inscription : choix « Membre : je veux seulement gérer mon argent » dans Créer un compte. Pas de numéro de versement, pas de pièce d'identité, pas de parrainage. Numéros guinéens seulement.
- Le membre arrive directement dans **Mes finances** (c'est toute son application). Il garde son profil, ses notifications et son mot de passe. Il n'a **aucun accès** aux commandes, au portefeuille Wallindirain, au call center, aux produits ni à l'administration (contrôlé côté serveur).
- **Fermé par défaut** : il faut allumer « Mes finances » ET « Inscription finances seulement » (Réglages → Fonctions). Tant que l'un des deux est éteint, l'option n'apparaît pas et l'inscription est refusée.
- **Textes légaux propres au membre** : « Conditions du membre » et « Confidentialité : membres », lisibles avant l'inscription et acceptés à l'inscription (comme les autres rôles).

## Sécurité
- Seuls le compte (profil, mot de passe, avatar, e-mail), les notifications, les textes légaux et Mes finances sont ouverts au membre. Les autres routes lui sont fermées.
- Un compte membre supprimé est anonymisé comme les autres (comptes, transactions, contacts, notes effacés).

## Modifier et à surveiller
- **Textes légaux à faire relire par un juriste** avant d'ouvrir l'inscription au public (données de tiers dans le carnet de contacts, absence de conseil financier, abonnement Pro).
- La **vérification du numéro de téléphone par code** n'existe pas à l'inscription pour les autres rôles non plus ; si l'inscription est ouverte au grand public, ajouter un code de confirmation est recommandé pour limiter les faux comptes.
- Prix de l'abonnement : le même pour tous (Réglages → Mes finances).

## À la mise en production
052 : ajoute la valeur « member » au type de rôle. 053 : 1 réglage (`pf_open_signup`, 0) et 2 fonctions adaptées (`fn_register`, `_pf_actor`).
Retour arrière : `docs/retour-arriere-053.sql` puis `docs/retour-arriere-052.sql` (refusent s'il existe des comptes membres ; PostgreSQL ne permet pas de retirer une valeur d'un type : « member » reste, sans effet).
