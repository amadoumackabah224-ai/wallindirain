# Migration 065 : comptabilité de la société

## Ce que ça fait
- Nouvel écran **Finances > Comptabilité** (administrateur seulement) : choisir une période, puis **Imprimer / PDF**.
- Le document contient : l'en-tête de l'entreprise (nom, adresse, NIF, RCCM, repris de « Factures > Informations de l'entreprise »), le **compte de résultat** (produits, charges, bénéfice ou perte), la **trésorerie** et le **journal des écritures**.
- **Aucune donnée personnelle** : ni nom, ni téléphone, ni adresse, ni numéro de commande. Les revenus de la plateforme sont inscrits **automatiquement, en totaux par jour et par nature** (livraisons, abonnements, rémunérations de l'équipe, primes…).
- Les écritures que vous saisissez vous-même dans « Mes finances » (loyer, achats, ventes directes…) s'ajoutent pour les **comptes que vous cochez**. Les écritures annulées et les prêts/remboursements sont exclus. Pour corriger : modifiez ou annulez l'écriture dans Mes finances.
- Lecture seule : rien n'est écrit, aucun argent ne bouge.

## À savoir
- Aucune règle fiscale (TVA, impôts) n'est appliquée : le document porte la mention « à faire valider par un expert-comptable ».
- Période d'un an au plus par édition.
- Retour arrière : `docs/retour-arriere-065.sql` (supprime seulement la fonction de lecture).
