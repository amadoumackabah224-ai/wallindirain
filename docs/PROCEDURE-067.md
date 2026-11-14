# Migration 067 : indicateurs de performance des livreurs

## Ce que ça fait
- Admin > Livreurs > onglet **Performance** : pour chaque livreur, sur 7, 30 ou 90 jours : colis confiés, livrés, échecs (refus, retours compris), taux de réussite, délai moyen (de l'affectation à la livraison), retards, gains et manques de caisse.
- Espace livreur : une carte **Mes chiffres (30 jours)** avec seulement ses propres chiffres.
- Pastille de réussite : verte à partir de 85 %, orange de 70 à 84 %, rouge en dessous.
- Réglage **courier_late_hours** (24 par défaut) : au-delà de ce délai, une livraison est comptée en retard.
- Lecture seule : aucun montant ni règle de livraison n'est touché. Pas de note du client pour le moment (les clients ne commandent pas encore directement).

## Retour arrière
`docs/retour-arriere-067.sql` retire la fonction et le réglage.
