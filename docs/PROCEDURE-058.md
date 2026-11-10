# Migration 058 : données personnelles (Mes finances)

## Ce que ça fait
- Dans **Mes finances → Paramètres → Données personnelles et confidentialité** : liens vers la politique de confidentialité et les conditions, texte sur les droits, et un bouton rouge **« Effacer mes données Mes finances »** (double confirmation : une boîte, puis taper EFFACER).
- L'effacement supprime **uniquement** les données Mes finances de la personne (comptes, transactions, budgets, objectifs, récurrents, contacts, catégories, devises, réglages). Le compte Wallindirain, le portefeuille, les commandes et l'accès Pro (pour que l'essai ne soit pas rejoué) ne sont pas touchés.
- Propriétaire d'un espace de groupe actif : refusé tant qu'il n'est pas archivé. Les espaces d'autres personnes sont quittés ; les opérations de la personne y restent (elles appartiennent au groupe).
- Aucune donnée existante n'est modifiée par la migration ; seule la personne concernée peut effacer ses propres données.
- Retour arrière : `docs/retour-arriere-058.sql`.
