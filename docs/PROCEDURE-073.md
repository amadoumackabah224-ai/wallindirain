# Migration 073 : finances de la société (administrateur)

À déployer après la 072. Aucune donnée n'est supprimée ni modifiée.

## Ce que ça change
- **Formule Pro gratuite pour l'administrateur** : déjà en place depuis la 060 (aucun abonnement, aucune limite).
- **Liaison automatique** : tout ce qui passe par le portefeuille de la plateforme (frais de livraison, abonnements, rémunération de l'équipe, primes des livreurs, bonus de parrainage, frais de retour, manques de caisse, compensations) apparaît tout seul dans « Mes finances » de l'administrateur, classé par nature, en lecture seule. Les livraisons à la demande (071) y arrivent aussi sans rien faire.
- **Charges de l'entreprise** : catégories ajoutées (serveur, base de données, SMS et WhatsApp, carburant, entretien des motos, équipement des livreurs, publicité, frais Mobile Money, cotisations sociales, patente...) et écran « Charges de l'entreprise » avec une liste prête à remplir (montant par mois) qui alimente la prévision.
- Le profil « entreprise » est déjà celui de l'administrateur par défaut (migration 060).

## Vérifier après déploiement
1. Se connecter en administrateur → Mes finances → le compte « Wallindirain (société) » apparaît avec le solde disponible de la plateforme.
2. Le solde correspond au solde de la plateforme dans Comptabilité.
3. Mes finances → Plus → Charges de l'entreprise : saisir les montants mensuels réels.

## Retour arrière
`docs/retour-arriere-073.sql` retire la liaison et les catégories. Refuse si une catégorie de l'entreprise est déjà utilisée (rien n'est perdu).
