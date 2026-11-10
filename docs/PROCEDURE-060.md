# Migration 060 : Mes finances pour l'administrateur et paie des employés

## Ce que ça fait
- **Administrateur toujours en formule Pro**, sans abonnement ni essai : tous les comptes, l'historique complet, l'export, les règles, l'import et la paie. Les autres rôles ne changent pas.
- **Profil « entreprise » par défaut** pour l'administrateur au premier accès (il peut le changer ; le plan de catégories pour entreprise est déjà prêt).
- **Paie des employés** (Mes finances → Plus → Paie des employés), pour les profils entreprise : liste d'employés avec salaire mensuel, navigation par mois, totaux « À payer / Payé / Reste ». « Payer » enregistre une dépense en catégorie « Employés » sur un compte en GNF et note le paiement du mois ; un seul paiement par employé et par mois ; « Annuler le paiement » annule la dépense. L'administrateur peut relier un employé à un membre de l'équipe Wallindirain (agent, chef, livreur, magasinier).
- **Rien n'est supprimé** : archiver un employé le retire des mois suivants, ses paiements passés restent. L'effacement des données Mes finances (058) et l'anonymisation d'un compte effacent aussi la paie de la personne.
- Retour arrière : `docs/retour-arriere-060.sql` (refuse s'il existe des employés).
