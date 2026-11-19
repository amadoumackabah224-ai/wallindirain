# Migration 071 : livraison à la demande, livreur et argent (étapes 3 et 4)

À déployer après 068, 069 et 070.

## Le parcours d'une course
1. L'expéditeur envoie sa demande (prix figé). État : **À prendre en charge**.
2. L'administrateur **désigne un livreur** (onglet « À la demande ») : le livreur est actif et, si le contrôle est demandé, son véhicule est vérifié. Il peut le **retirer** tant que le colis n'est pas récupéré. Le livreur et l'expéditeur sont prévenus.
3. Le livreur **récupère le colis**. Si l'expéditeur paie la course, l'espèce est encaissée à ce moment.
4. Le livreur **livre** et valide lui-même, **sans code** (choix assumé). Si le destinataire paie la course, l'espèce est encaissée à ce moment.
5. En cas d'**échec** (destinataire absent ou refus), le livreur indique la raison.

## L'argent
- **Livrée** : le livreur touche sa part du prix (réglage `dlv_courier_share`, 70 % par défaut). La plateforme enregistre le prix de la course. L'espèce encaissée apparaît dans la **Caisse** du livreur et se reverse comme celle des commandes (comptage, reversement, validation par l'administration).
- **Échec** : le livreur touche `dlv_failed_pay_pct` % de sa part (50 % par défaut, trajet retour). Si l'expéditeur avait déjà payé au ramassage, le prix reste acquis à la plateforme. Si c'est le destinataire qui devait payer, personne n'est facturé et la plateforme supporte le coût.
- Aucune écriture n'est faite deux fois (la ligne est verrouillée à chaque changement d'état).

## Ce qui change dans l'existant (petites extensions, sans suppression)
- Le reversement d'espèces et la réinitialisation de l'activité connaissent aussi les courses à la demande.
- Les espèces d'une course sont rangées dans la même table que celles des commandes (colonne ajoutée).

## Pas inclus
Encaissement de la valeur du colis (paiement du produit) et reversement à l'expéditeur : non prévu pour l'instant, la course seule est encaissée.
Les indicateurs de performance des livreurs ne comptent pas encore ces courses.

## Avant d'ouvrir l'inscription des expéditeurs
Essai complet avec 2 ou 3 courses réelles, textes légaux relus, et fonction « Livraison à la demande » allumée seulement alors.

## Retour arrière
`docs/retour-arriere-071.sql` : refusé dès qu'une course a été confiée à un livreur (pour ne rien perdre).
