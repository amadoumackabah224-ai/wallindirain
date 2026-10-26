# Liste de test du marché-test Wallindirain

À faire avec de **vraies personnes** et de **vrais téléphones** (connexion lente comprise), avant d'ouvrir à plus de monde.
Coche chaque ligne. Note ce qui ne va pas avec une **capture d'écran** et l'heure.

## 0. Avant de commencer
- [ ] Render affiche « Live » (vert) après la dernière fusion.
- [ ] Les migrations 020 à 026 sont appliquées dans Neon.
- [ ] Les informations légales sont renseignées dans Render (plus d'avertissement jaune sur le tableau de bord admin).
- [ ] Les montants (bonus, pourcentages, tarifs) sont ceux que **tu** as choisis dans Réglages.
- [ ] Un compte de chaque rôle existe : vendeur, fournisseur, agent call center, chef d'équipe, livreur, magasin, admin.

## 1. Vendeur
- [ ] Je crée un compte (avec un code de parrainage) et je me connecte ; le bouton œil affiche/masque le mot de passe.
- [ ] Mon identité est vérifiée par l'admin (photos de la pièce et selfie).
- [ ] J'enregistre mon numéro Orange / MTN de versement.
- [ ] Je fixe mon prix sur un produit et je crée mon lien de vente.
- [ ] Je saisis une commande à la main ; elle apparaît sur mon Accueil.
- [ ] J'importe des commandes : par Google Sheet, puis par tableau collé. Les lignes en erreur sont expliquées.
- [ ] Un client commande par mon lien **sans compte** et reçoit un lien de suivi.
- [ ] Je vois mon solde : disponible, en attente, gains attendus, réservé.
- [ ] Je demande un retrait ; l'admin le paie ; je vois la preuve du transfert.

## 2. Call center (agent et chef)
- [ ] Je vois la nouvelle commande dans la file et j'appelle le client (bouton Appeler / WhatsApp).
- [ ] Je note « Client confirme » ou « Client refuse » ; le statut change chez le vendeur.
- [ ] Client injoignable : après le nombre d'essais prévu, la commande remonte au chef.
- [ ] Le chef crée une tournée (mode normal, A ou B) et l'affecte à un livreur.

## 3. Livreur
- [ ] Je vois ma tournée et j'accepte (« J'accepte la tournée »).
- [ ] Je récupère le colis (entrepôt, fournisseur ou vendeur) ; le statut passe à « Ramassée ».
- [ ] Je livre avec le code du client ; le statut passe à « Livrée ».
- [ ] Cas d'échec : client absent, refus, retour ; la raison est enregistrée.
- [ ] Je reverse l'argent encaissé (espèces ou transfert) ; l'admin valide.

## 4. Fournisseur et magasin
- [ ] Le fournisseur propose un produit avec photo ; l'admin le valide.
- [ ] Le magasin compte l'arrivage et le compare à ce qui était annoncé.
- [ ] Une commande livrée met à jour le stock.

## 5. Admin
- [ ] Le tableau de bord affiche les « À traiter » ; chaque case mène à la bonne page.
- [ ] Je valide un fournisseur, un produit, une identité, un retrait, un reversement.
- [ ] Le journal garde la trace des actions sensibles.
- [ ] Les chiffres du tableau de bord correspondent à la réalité (livraisons, résultat cumulé, argent chez les livreurs).

## 6. Argent : vérification croisée (la plus importante)
Pour 3 à 5 commandes livrées, recalculer **à la main** et comparer :
- [ ] Prix payé par le client = prix de vente.
- [ ] Gain du vendeur = prix de vente − livraison − call center − prix fournisseur.
- [ ] Argent que doit reverser le livreur = montant encaissé.
- [ ] Solde du vendeur après le délai de déblocage = gain attendu.
- [ ] Aucune « incohérence comptable » signalée sur le tableau de bord admin.

## 7. Téléphone et réseau
- [ ] Android et iPhone : pas de texte coupé ni de bouton inaccessible.
- [ ] Connexion lente (3G) : les pages s'ouvrent, les boutons ne se déclenchent pas deux fois.
- [ ] Le bouton « Plus » donne accès au profil et à « Quitter ».
- [ ] Le bouton « Aide » ouvre la messagerie de support.

## 8. À noter pour chaque problème
Rôle · page · ce que j'ai fait · ce que j'ai vu · ce que j'attendais · capture · heure.
