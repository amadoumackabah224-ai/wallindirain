# Migration 032 — Inventaire physique, recherche rapide et bon de remise imprimable

## Ce que ça fait
- **Inventaire** (onglet Stock du magasinier) : « Compter le rayon » pour un produit. L'application affiche l'**attendu en rayon** = stock du catalogue + stock prépayé des vendeurs − colis déjà sortis (chez le livreur ou en retour).
  - Compte conforme : enregistré, rien d'autre.
  - Écart : explication obligatoire ; l'**administrateur** est prévenu et décide (onglet Produits → « Inventaires à valider »). **Le stock ne change qu'après sa validation**, jamais en dessous des unités réservées. Refus : il explique, le magasinier recompte.
  - Un seul inventaire en attente par produit. Historique dans l'onglet Historique → Inventaires.
- **Recherche rapide** dans « À faire » : référence, produit, livreur, zone, fournisseur.
- **Bon de remise** (un colis) et **liste de remise** (tous les colis à remettre, avec colonne de signature du livreur) : impression du navigateur, sans donnée client.

## Ce que ça NE fait PAS
Aucun montant, tarif, pourcentage ni écriture d'argent. Pas de scan de code-barres (la caméra est volontairement bloquée par la politique de sécurité de l'application).

## Ordre de fusion
Au-dessus de `feature/magasinier-complet` : livreurs → fournisseur → magasinier → inventaire.

## Mise en production (uniquement après autorisation)
**Render applique la migration automatiquement au démarrage, dès la fusion.**
1. `SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 3;` → `032_inventaire.sql` en premier.
2. `SELECT * FROM fn_ledger_check();` → 0 ligne.

## Retour arrière
`docs/retour-arriere-032.sql` (avant 031). **Refuse de s'exécuter si un inventaire a déjà corrigé le stock** (le journal est la seule trace). Sinon supprime les inventaires et restaure la remise à zéro de la 031.
