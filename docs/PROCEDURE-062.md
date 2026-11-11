# Migration 062 : vérification du véhicule des livreurs (plaque + carte grise)

## Ce que ça fait
- Les livreurs **à moto ou en voiture** envoient le numéro de leur plaque, la photo de la plaque et la photo de la carte grise (Profil → « Mon véhicule »). **Vélo et à pied : rien à fournir.**
- L'administrateur examine les photos (fiche du livreur → « Examiner le véhicule »), puis valide ou refuse avec un motif ; le livreur peut renvoyer de meilleures photos.
- Les images ne sont visibles que du livreur et des administrateurs ; chaque consultation par un administrateur est enregistrée au journal. Elles sont effacées à l'anonymisation du compte.
- Nouveau réglage **« Plaque et carte grise des livreurs obligatoires »**, **désactivé par défaut** (Administration → Réglages). Activé, un livreur moto ou voiture non vérifié ne peut plus recevoir de mission (affectation directe ou proposition) ; le chef voit le message « plaque et carte grise pas encore vérifiées ». Désactivé, rien ne change.
- Le type de véhicule reste réglé par l'administrateur sur la fiche du livreur.
- Rien n'est supprimé ni modifié dans les données existantes.
- Retour arrière : `docs/retour-arriere-062.sql` (refuse s'il existe des véhicules enregistrés).

## Pour activer
1. Vérifier que chaque livreur a son véhicule renseigné (fiche livreur).
2. Laisser les livreurs envoyer leurs photos et les examiner.
3. Activer le réglage quand les livreurs actuels sont vérifiés.
