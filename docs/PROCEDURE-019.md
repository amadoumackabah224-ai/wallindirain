# Migration 019 — propositions de mission

**Dépend de la 017 et de la 018** : à fusionner dans l'ordre 017, 018, 019. Retours arrière dans l'ordre inverse (019, 018, 017). Aucun réglage financier, aucune commande, aucune écriture d'argent n'est modifié.

## Fonctionnement
1. Le chef (ou l'administrateur) ouvre « Affectation », choisit une commande confirmée ou en échec, clique « Proposer à un livreur ».
2. Le livreur voit : zone, produit, montant à encaisser et **sa rémunération** (celle figée à la création de la commande). L'adresse et les coordonnées du client ne sont montrées qu'après acceptation.
3. Il accepte (la commande est affectée par l'affectation existante) ou refuse (motif facultatif). Aucune pénalité.
4. Sans réponse après 10 minutes, la proposition expire ; la commande reste disponible.
5. L'affectation directe du chef reste possible et imposée, sans acceptation et sans plafond.

## Règles
- Une proposition ouverte à la fois par commande ; jamais deux fois au même livreur ; 3 propositions au maximum, ensuite affectation directe.
- Une proposition exige un livreur actif, disponible, avec moins de 3 missions en cours (affectées ou proposées).
- Si le chef affecte à la main, annule la commande ou si elle change d'état, les propositions ouvertes deviennent sans objet.

## Limites et décisions
- Pas de notification au livreur (ni WhatsApp, ni SMS) : il voit la proposition en ouvrant son espace (rafraîchi toutes les quelques secondes). À décider : notification, avec quel canal.
- Pas de « missions disponibles » en libre-service : seul le chef propose. À décider après le test réel.
- Si le chef qui a proposé est désactivé avant l'acceptation, l'acceptation échoue (l'affectation est faite au nom de ce chef).
- Pas encore de répartition automatique (étape 020, désactivée par défaut).

## Essai sur une copie Neon
1. Branche Neon copiée de la production, migrations jusqu'à 019.
2. Vérifier : requête 6 du rapport 017 identique ; aucune commande, écriture ni réglage modifié.
3. Dans l'application : proposer une commande, refuser, proposer à un autre, accepter, livrer.
4. Retour arrière : `docs/retour-arriere-019.sql`.
