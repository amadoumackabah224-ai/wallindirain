# Migration 059 : outils Pro de Mes finances (export, règles automatiques, import)

## Ce que ça fait (écran Mes finances → Paramètres → « Outils Pro »)
- **Export CSV** : transactions entre deux dates, pour un compte ou tous. Fichier Excel-compatible (séparateur `;`, accents corrects). Les cellules de texte commençant par `= + - @` sont neutralisées contre l'injection de formules. Formule Pro seulement.
- **Règles automatiques** : « si la note contient *orange* → catégorie *Téléphone et internet* » (par type : revenus, dépenses ou les deux). 50 règles au plus. La catégorie est proposée à la saisie d'une note et utilisée à l'import. Formule Pro seulement.
- **Import** : fichier CSV (colonnes Date, Montant, et facultatif Type, Catégorie, Note/Libellé ; montant négatif = dépense), 500 lignes au plus. La catégorie vient du fichier si elle existe, sinon d'une règle, sinon « Autre dépense » / « Revenus non affectés ». Les lignes invalides sont ignorées et les 10 premiers motifs affichés. Formule Pro seulement.
- Aucune donnée existante n'est modifiée. L'effacement des données Mes finances (058) efface aussi les règles.
- Retour arrière : `docs/retour-arriere-059.sql` (refuse s'il existe des règles).
