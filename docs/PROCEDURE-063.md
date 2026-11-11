# Migration 063 : saisie hors connexion (Mes finances et Boutique)

## Ce que ça fait
- **Sans réseau**, la personne peut ouvrir Mes finances (dernières données gardées sur son téléphone), puis saisir une **dépense, un revenu ou une vente de la Boutique**. L'opération reste sur le téléphone, avec un bandeau « Hors connexion » puis « N opérations en attente ».
- **Au retour du réseau**, elles sont envoyées automatiquement, dans l'ordre, avec un message « Opération envoyée ». Le bouton « Envoyer » force un essai.
- **Aucun doublon** : chaque opération porte une clé unique ; si l'envoi est répété (coupure au mauvais moment), le serveur ne l'enregistre qu'une fois. Les clés sont gardées 30 jours puis effacées.
- **Refus à l'envoi** (stock épuisé entre-temps, saisie invalide) : l'opération reste visible dans le bandeau avec le motif, et la personne la supprime.
- Les données gardées sur le téléphone (derniers chiffres consultables) sont **effacées à la déconnexion**. Les opérations en attente restent pour être envoyées à la prochaine connexion de la même personne.
- Ne marche pas sans réseau : modifier ou supprimer une saisie existante, transferts, import, tout ce qui demande le serveur en direct.
- Retour arrière : `docs/retour-arriere-063.sql` (les clés ne servent qu'à éviter les doublons : on peut les effacer).
