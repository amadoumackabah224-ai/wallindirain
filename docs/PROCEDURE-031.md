# Migration 031 — Espace du magasinier complet

## Ce que ça fait (page « Entrepôt » : 3 onglets)
**À faire**
- **Colis à remettre aux livreurs** : commandes affectées dont le produit est stocké chez Wallindirain (produit, quantité, livreur et son téléphone, zone). Bouton « Colis remis au livreur » : enregistre la remise et prévient le livreur. Le livreur confirme toujours lui-même la récupération (le statut de la commande ne change pas). Si la commande est réaffectée à un autre livreur, la remise précédente ne compte plus.
- **Arrivages à compter** : avec nom du fournisseur et photo du produit. **Si le nombre compté est différent de l'annoncé, une explication est obligatoire** ; le fournisseur et l'administration sont prévenus dans la cloche. Le stock suit toujours le nombre compté.
- **Retours à réceptionner** : cause (inchangée), plus une **note** et jusqu'à **3 photos** facultatives. Les photos sont visibles par le magasinier, l'administration et le fournisseur du produit.

**Stock** : produits stockés à l'entrepôt avec quantité libre (vendable), réservée, totale, dernier arrivage ; marques « Rupture » et « Stock bas » (seuil = réglage `alert_low_stock_qty`) ; recherche ; bouton **Casse ou perte** (retire du stock libre seulement, jamais les unités réservées ; motif et explication obligatoires ; fournisseur et administration prévenus).

**Historique** : arrivages comptés (avec écarts), retours réceptionnés (note, photos), remises, casses et pertes (60 derniers de chaque).

**Cloche du magasinier** : « Arrivage annoncé » et « Colis à préparer ».

## Ce que ça NE fait PAS
- **Aucun montant, tarif, pourcentage ni écriture d'argent n'est créé ou modifié.** `fn_warehouse_receive_return` (règles financières des retours) est inchangée.
- Une casse ou perte **retire du stock mais ne verse ni ne retire d'argent** : si le fournisseur doit être indemnisé ou remboursé, c'est une décision de l'administration (rien d'automatique).
- Aucune donnée client (nom, téléphone, adresse) n'est montrée au magasinier.
- La « remise à zéro de l'activité » de l'administrateur vide aussi les nouveaux journaux (remises, notes, photos de retour, casses).

## Ordre de fusion
Branche construite **au-dessus de `feature/fournisseur-sans-piece`** (030), elle-même au-dessus de `feature/livreurs-categories` (029). Fusionner dans l'ordre : livreurs, fournisseur, magasinier.

## Mise en production (uniquement après autorisation)
**Render applique la migration automatiquement au démarrage, dès la fusion.**
1. `SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 3;` → `031_magasinier.sql` en premier.
2. `SELECT * FROM fn_ledger_check();` → 0 ligne.
3. Se connecter en magasinier : trois onglets « À faire », « Stock », « Historique ».
4. Si un service worker (PWA) est fusionné plus tard : ajouter les fichiers modifiés à sa liste de fichiers en cache.

## Retour arrière
`docs/retour-arriere-031.sql` (avant 030 et 029). **Refuse de s'exécuter si une casse ou perte a été déclarée** (le journal est la seule trace du stock retiré). Sinon : restaure le comptage d'avant et la remise à zéro d'avant, supprime les remises, notes, photos et la colonne d'explication des écarts.
