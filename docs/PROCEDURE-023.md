# Migration 023 — Photos des produits

## Ce que ça fait
- Le fournisseur peut ajouter **une photo dès la création du produit**, puis jusqu'à **4 photos** au total depuis la fiche du produit (bouton « Ajouter une photo », croix pour supprimer). La photo n'est **pas obligatoire** (phase de test du marché) ; l'administrateur voit « Sans photo » à la validation.
- Les photos sont affichées : dans le catalogue du vendeur, dans la liste des produits de l'administrateur (pour valider) et sur la **page publique du lien produit** (couverture seulement, aucune information sur le fournisseur).
- Un vendeur, le call center, le livreur et l'entrepôt ne voient les photos que si le produit est **validé**. Un autre fournisseur ne voit jamais les photos d'un concurrent.
- La photo est réduite automatiquement par l'application avant l'envoi (≈ 450 Ko au plus). Les octets des images ne sont lisibles que par des fonctions contrôlées, comme les photos de profil.

## Ce que ça ne fait pas
- Aucune règle d'argent, de stock ou de validation n'est modifiée.
- Pas de vidéo, pas de photo obligatoire.

## Attention : place sur Neon
Les photos sont stockées dans la base. Avec la formule gratuite de Neon (stockage limité), compter environ 300 Ko par photo : 1 000 photos ≈ 300 Mo. À surveiller pendant le test ; si besoin, passer plus tard à un stockage de fichiers dédié.

## Mise en production (uniquement après autorisation)
1. Fusionner `feature/photos-produits`. Render applique la 023.
2. `SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 3;` → `023_photos_produits.sql` en premier.
3. `SELECT * FROM fn_ledger_check();` → 0 ligne.
4. Test : en fournisseur, ajouter un produit avec une photo ; en administrateur, le valider ; en vendeur, voir la photo dans le catalogue ; ouvrir le lien produit : la photo apparaît.

## Retour arrière
`docs/retour-arriere-023.sql` (avant 022, 021…) : supprime la table et **toutes les photos de produits**. Aucune donnée financière touchée.
