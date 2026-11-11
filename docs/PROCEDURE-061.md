# Migration 061 : Boutique (produits, stock, vente rapide, clôture de caisse)

## Ce que ça fait
- **Produits** avec prix de vente, prix d'achat (pour le bénéfice), stock facultatif et seuil d'alerte.
- **Vente rapide** : on touche les produits, on encaisse sur un compte en GNF. La vente crée un revenu « Produit », baisse le stock et garde le prix et le coût du jour (le bénéfice reste juste si les prix changent). Stock insuffisant : la vente est refusée.
- **Annuler une vente** : l'argent est retiré du compte et le stock remis.
- **Réapprovisionner** : le stock augmente ; avec un compte choisi, la dépense d'achat est notée en « Marchandises ».
- **Clôture de caisse** : on saisit l'argent compté, l'écart avec le solde attendu est enregistré (historique).
- Formule Pro ; l'administrateur y a toujours accès. Accessible depuis Mes finances → Plus → Boutique (profils entreprise).
- Rien n'est supprimé : archiver un produit le masque. L'effacement des données Mes finances efface aussi la boutique.
- Retour arrière : `docs/retour-arriere-061.sql` (refuse s'il existe des produits, ventes ou clôtures).
