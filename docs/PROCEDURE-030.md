# Migration 030 — Fournisseur : pièce d'identité au premier retrait

## Ce que ça fait
- À l'inscription, le **fournisseur ne donne plus de pièce d'identité** (comme le vendeur). Le champ disparaît du formulaire.
- Son compte reste **« en attente »** jusqu'à validation par l'administration (inchangé).
- La pièce est demandée **au premier retrait** (parcours déjà en place pour les vendeurs), ou plus tard une fois le compte validé. Le **retrait reste bloqué** tant que l'identité n'est pas vérifiée par l'administration (testé).
- Si une pièce est saisie quand même, elle reste contrôlée (4 caractères minimum).

## Ce que ça NE fait PAS
Aucun montant, tarif, pourcentage ou écriture d'argent n'est touché. Les fournisseurs déjà inscrits ne changent pas.

## Ordre de fusion
Cette branche est construite **au-dessus de `feature/livreurs-categories`** (migration 029). Fusionner d'abord celle des livreurs, puis celle-ci.

## Mise en production (uniquement après autorisation)
**Render applique la migration automatiquement au démarrage, dès la fusion.**
1. `SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 3;` → `030_fournisseur_sans_piece.sql` en premier.
2. `SELECT * FROM fn_ledger_check();` → 0 ligne.
3. Essai : créer un compte fournisseur sans pièce → « en attente ».

## Retour arrière
`docs/retour-arriere-030.sql` (avant celui de la 029). Rétablit l'obligation de la pièce à l'inscription ; ne touche aucune donnée.
