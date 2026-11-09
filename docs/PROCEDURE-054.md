# Migration 054 : profil et catégories modifiables (Mes finances)

## Ce que ça fait
- **Profil** : à la première ouverture du tableau de bord, la personne choisit Personnel, Commerce / petite entreprise, ou Les deux (modifiable dans Paramètres → Catégories et profil). Le profil décide seulement quelles catégories sont proposées en premier ; rien n'est caché définitivement.
- **Arbre de catégories** (3 niveaux : groupe, sous-catégorie, élément ajouté par la personne). Revenus : Revenus de vente (Produit, Service), Autres revenus (Remboursement, Intérêts, Plus-values), Revenus divers, Revenus non affectés, Nouveaux financements (prêt, obligation, billet à ordre, capitaux propres). Dépenses : Espace et équipement, Paie et dépenses, Achat de stock, Services opérationnels, Autres factures et frais, Remboursement de prêt, plus les catégories personnelles d'avant (Alimentation, Transport, Logement…).
- **Modifier** : renommer, changer l'icône, masquer (pour soi seulement). **Ajouter** une sous-catégorie ou un groupe (ex. le nom d'un employé sous « Employés »). Rien n'est supprimé : une catégorie masquée reste lisible dans l'historique.
- **Financements et remboursements de prêt** sont marqués « hors exploitation » (colonne `operating`), pour ne pas fausser les ratios de revenus et de flux de l'étape suivante.
- **Formule gratuite** : nombre limité de catégories ajoutées (réglage `pf_free_categories`, 5 par défaut) ; renommer, masquer et changer l'icône restent libres. **Pro** : illimité.
- Les formulaires de revenu, dépense, récurrent et budget utilisent maintenant cet arbre. Les paiements récurrents ont désormais un choix de catégorie.

## Ce qui ne change pas
Les anciennes transactions, budgets et récurrents gardent leur catégorie (mêmes clés : sales, salary, food…). Aucune donnée n'est modifiée ni supprimée. Les listes figées de catégories sont remplacées par une vérification en base (`_pf_cat_ok`) : une catégorie doit exister (système ou à la personne) et correspondre au type revenu/dépense.

## À savoir
- « Autres coûts » (dans « Autres factures et frais ») traduit la ligne « revenus autres et coût par impôt » de la maquette d'origine ; à ajuster si besoin (nom modifiable par chaque personne).
- Les noms d'origine sont dans la table `pf_cat_system` ; les ajouts de la personne dans `pf_cat_custom` ; ses renommages dans `pf_cat_override`.

## À la mise en production
3 tables, 1 colonne (`pf_prefs.profile`), 1 réglage, 4 fonctions, 3 fonctions existantes adaptées (`_pf_check_tx`, `fn_pf_recurring_save`, `fn_pf_budget_set`), 1 contrainte retirée (liste figée des budgets). Retour arrière : `docs/retour-arriere-054.sql` (refuse si des catégories ou profils personnalisés existent, ou si des données utilisent les nouvelles catégories).
