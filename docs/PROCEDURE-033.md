# Migration 033 — Factures et documents numérotés

## Ce que ça fait
Quatre documents, **émis à la demande**, avec en-tête (logo, nom, adresse, téléphone, e-mail, NIF, RCCM de l'entreprise), numéro, date, détail, total, **impression et enregistrement en PDF** :
| Document | Qui l'émet | Contenu |
|---|---|---|
| **Facture de livraison** (FAC-AAAA-NNNNNN) | le vendeur (ses commandes livrées) ou l'administrateur | produit, frais de livraison, total payé par le client, tampon « PAYÉE ». Aucun frais interne ni marge. |
| **Facture de services** (FSV-…) | le vendeur ou l'administrateur, pour une **période terminée** | frais de livraison, call center, plateforme des commandes livrées, frais de retour, abonnements |
| **Relevé fournisseur** (REL-…) | le fournisseur ou l'administrateur, pour une période terminée | ventes, frais de retour de produits défectueux, compensations de transport (solde net) |
| **Reçu de retrait** (REC-…) | le titulaire ou l'administrateur, retrait **payé** | montant, opérateur, numéro masqué, référence |

- **Numérotation sans trou** par type et par année. Un document est **figé** (aucune modification ni suppression, même par l'administrateur) ; les informations de l'entreprise sont copiées à l'émission (les anciens documents ne changent pas si vous modifiez l'en-tête plus tard).
- Une commande, un retrait, ou une période (par compte) n'a qu'**un seul document** : redemander renvoie le même. Deux périodes d'un même compte ne peuvent pas se chevaucher.
- **Chacun ne voit que ses documents.** L'administrateur voit tout.
- **Onglet « Factures »** : vendeur, fournisseur ; boutons « Reçu » dans les retraits payés (vendeur, fournisseur, équipe, administrateur).
- **Administrateur → Finances → Factures** (vue pour la finance) : synthèse sur une période (livraisons, encaissé, frais, marge, gains vendeurs, paiements fournisseurs, rémunérations, retraits payés et en attente, retours, documents émis) avec impression ; journal des documents (filtres, recherche, **export CSV**, impression) ; émission d'une facture par référence de commande ou d'un relevé pour un compte ; **informations de l'entreprise** (en-tête).

## Ce que ça NE fait PAS
- **Aucun calcul d'argent nouveau, aucun tarif, pourcentage, frais ni marge modifié, aucune écriture de portefeuille créée.** Tous les montants sont lus dans les commandes livrées, les portefeuilles et les retraits ; la synthèse est contrôlée par les tests (mêmes totaux que la base).
- **Rien n'est inventé** : NIF, RCCM, adresse sont à saisir par vous (Factures → Informations de l'entreprise) ; ce qui est vide n'est pas imprimé.
- **Pas de TVA ni de mention fiscale** : la fiscalité guinéenne applicable (TVA, forme exigée de la facture) est à faire valider par votre comptable avant d'utiliser ces documents comme factures officielles.
- Pas de rôle « finance » séparé : la vue d'ensemble est dans l'espace administrateur. Un compte finance dédié (lecture seule) est une étape distincte à décider.
- Pas d'envoi automatique par WhatsApp ou e-mail.

## Remise à zéro
La « remise à zéro de l'activité » (confirmation écrite + mot de passe) vide aussi les documents et leur compteur. À ne plus utiliser une fois de vraies factures émises.

## Ordre de fusion
Au-dessus de `feature/magasinier-inventaire` : livreurs → fournisseur → magasinier → inventaire → factures.

## Mise en production (uniquement après autorisation)
**Render applique la migration automatiquement au démarrage, dès la fusion.**
1. `SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 3;` → `033_factures.sql` en premier.
2. `SELECT * FROM fn_ledger_check();` → 0 ligne ; `SELECT count(*) FROM invoices;` → 0.
3. Renseigner Factures → Informations de l'entreprise, puis émettre une facture d'essai.
4. Si un service worker (PWA) est fusionné plus tard : ajouter `js/views/invoices.js` à sa liste de fichiers en cache.

## Retour arrière
`docs/retour-arriere-033.sql` (avant 032). **Refuse de s'exécuter dès qu'un document a été émis.** Sinon supprime les tables et fonctions ajoutées et restaure la remise à zéro de la 032.
