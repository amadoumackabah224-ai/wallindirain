# Migration 072 : parrainage pour les autres rôles

À déployer après la 071. **Tout est désactivé par défaut** (montants à 0).

## Les règles
- **Qui parraine** : vendeurs, fournisseurs et livreurs (des personnes qui peuvent retirer de l'argent). Un expéditeur ne parraine pas : il n'a pas de moyen de retrait.
- **Qui est parrainé** :
  - un **vendeur** (comme avant : bonus après N commandes livrées),
  - un **expéditeur** : il saisit le code à l'inscription ; le parrain reçoit `referral_bonus_shipper` quand l'expéditeur a `referral_dlv_required` courses livrées (3 par défaut),
  - un **livreur** : l'administration saisit le code sur la fiche du livreur (bouton « Parrain ») ; le parrain reçoit `referral_bonus_courier` quand le livreur a `referral_courier_required` livraisons réussies, commandes et courses à la demande ensemble (20 par défaut).
- Le bonus est versé **une seule fois** par filleul, prélevé sur la plateforme (écriture double). Pas d'auto-parrainage. Un seul parrain par personne.

## Réglages (Réglages > Parrainage)
`referral_bonus_shipper`, `referral_dlv_required`, `referral_bonus_courier`, `referral_courier_required`.
Conseil : un bonus doit rester **inférieur au bénéfice** que rapporte le filleul sur son objectif, pour que le parrainage ne coûte jamais plus que ce qu'il rapporte.

## Retour arrière
`docs/retour-arriere-072.sql` : refusé si un bonus expéditeur ou livreur a déjà été versé.
