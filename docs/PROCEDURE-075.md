# Migration 075 : pilotage

À déployer après la 074. Aucune donnée n'est modifiée ni supprimée, aucune règle économique ni circuit d'argent n'est touché : ce sont des **lectures** (une seule nouvelle table : l'archive des rapports, en ajout seul).

## Ce que ça apporte
1. **Alertes** : anomalies comptables (comptes, solde négatif, argent livreur non reversé, retrait ou reversement qui traîne). Les administrateurs sont prévenus (cloche + message) au plus une fois par type et par demi-heure ; réglage existant « Alertes techniques » (`ops_alerts`).
2. **Aujourd'hui** : pour chaque rôle, les actions à traiter maintenant, avec un bouton vers le bon onglet.
3. **Historique d'un produit** : chronologie unique (création, nom, prix, arrivages, inventaires, pertes, retours, commandes). Aucune marge n'y figure.
4. **Rapports financiers** (Finances > Rapports) : journalier, hebdomadaire, mensuel. Génération automatique si le réglage `auto_reports` est à 1 (éteint par défaut), génération manuelle toujours possible. Un même rapport n'est jamais archivé deux fois et ne peut ni changer ni être supprimé.
5. **Dettes et créances** : ce que la plateforme doit (soldes des portefeuilles) et ce qu'elle attend (argent des livreurs non reversé, ancienneté).
6. **Performances** : administrateur (vendeurs, produits, zones, revenu plateforme) ; vendeur (ses propres chiffres seulement).
7. **Dossiers** : commande et retrait, avec événements, factures et justificatifs, selon le rôle.

## Mise en service
Rien à faire pour 1 à 3, 5 à 7. Pour 4 : Réglages > Fonctions, allumer « Rapports financiers automatiques ».

## Retour arrière
`docs/retour-arriere-075.sql` : refusé s'il existe des rapports archivés.
