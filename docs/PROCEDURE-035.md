# Migration 035 — Rayons du catalogue et zones de livraison classées

## Ce que ça fait
- **Rayons** : six rayons au départ (Bébé et enfant, Électroménager, Meubles et maison, Mode et beauté, Téléphones et électronique, Autres). Tous les produits existants vont dans « Autres ». Le fournisseur choisit le rayon en proposant un produit (et peut le changer) ; l'administrateur crée, renomme, ordonne, désactive les rayons et peut changer le rayon d'un produit. Le catalogue vendeur s'affiche par rayon, avec des boutons pour filtrer.
- **Zones classées** : chaque zone est une *commune*, un *quartier* (rattaché à une commune), une *ville de l'intérieur* ou « Autre ». Les quartiers déjà présents sont rattachés à leur commune (liste de départ à vérifier et à corriger avec « Classer »). Les formulaires de commande affichent les zones par commune, puis les villes de l'intérieur.
- **Villes de l'intérieur** : livrées à la **gare voiture**. L'administrateur peut noter la gare de chaque ville ; le formulaire rappelle au vendeur et au client d'indiquer la gare et un numéro joignable.
- Bouton « Appliquer le tarif de la commune aux quartiers sans tarif » : à votre demande seulement.

## Ce que ça NE fait PAS
- **Aucun tarif n'est modifié ni inventé.** Les quartiers et les villes restent désactivés et sans tarif tant que vous ne les tarifez pas (ou ne cliquez pas sur le bouton ci-dessus).
- Aucune commande passée n'est touchée. Aucune écriture d'argent.

## À savoir avant de tarifer les villes de l'intérieur
Le **prix minimum de vente** de tous les produits tient compte de la livraison active la **plus chère**. Activer une ville à un tarif élevé relève donc le prix minimum partout.

## Mise en production (uniquement après autorisation)
**Render applique la migration automatiquement au démarrage, dès la fusion.** À fusionner après `feature/medaillons-agent-livre`.
1. `SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 2;` → `035_rayons_et_zones.sql` en premier.
2. `SELECT count(*) FROM product_categories;` → 6 ; `SELECT count(*) FROM products WHERE category_id IS NULL;` → 0.
3. `SELECT commune, kind, parent, fee, active FROM delivery_rates ORDER BY kind, commune;` : tarifs identiques à avant.
4. Réglages : rayons et zones affichés ; catalogue vendeur par rayon.

## Retour arrière
`docs/retour-arriere-035.sql`. Il refuse de s'exécuter si un produit a été rangé hors « Autres » ou si un rayon a été ajouté.
