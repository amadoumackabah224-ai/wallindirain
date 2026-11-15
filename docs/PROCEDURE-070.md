# Migrations 069 et 070 : l'expéditeur (livraison à la demande, étape 2)

À déployer dans l'ordre, **après la 068** (grille tarifaire). La 069 ajoute seulement le rôle « expéditeur » ; la 070 s'en sert.

## Ce que ça fait
- Nouveau rôle **expéditeur** : une personne qui fait livrer un colis sans être vendeur. Pas de portefeuille, pas de versement.
- Inscription fermée par défaut : il faut **deux** réglages à 1 : « Livraison à la demande » et « Inscription expéditeurs » (Réglages > Fonctions).
- L'expéditeur remplit : quartier et adresse de ramassage, quartier et adresse de livraison, nom et téléphone du destinataire, description, poids, valeur déclarée, qui paie la course. Le **prix s'affiche avant de confirmer** (grille léger/lourd) et il est **figé** à l'envoi.
- Garde-fous : confirmation « aucun objet interdit » obligatoire, valeur déclarée plafonnée (`dlv_max_declared`, 500 000 GNF), nombre de demandes par jour (`dlv_daily_limit`, 5).
- L'expéditeur voit ses envois et peut annuler tant que personne ne les a pris en charge.
- Admin : onglet **À la demande** (Opérations) avec toutes les demandes.
- Textes légaux ajoutés : conditions et confidentialité de l'expéditeur. **Ce sont des projets : à faire relire par un juriste guinéen avant d'ouvrir l'inscription.**

## Pas encore dans cette étape
Désignation d'un livreur, ramassage, livraison avec preuve, encaissement et reversement : étape suivante. Tant qu'elle n'est pas faite, ne pas ouvrir l'inscription au public.

## Retour arrière
`docs/retour-arriere-070.sql` (refusé s'il existe des expéditeurs ou des demandes, pour ne rien perdre), puis `docs/retour-arriere-069.sql` (le rôle reste dans le type PostgreSQL, sans effet).
