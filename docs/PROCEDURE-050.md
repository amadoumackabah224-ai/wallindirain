# Migration 050 : « Contacts » de Mes finances (CRM, pour tous les rôles)

## Ce que ça fait
- **Un carnet unique** par personne (onglet Contacts) : nom, téléphone, ville, statut (prospect / client / autre). Le numéro est nettoyé (indicatif 224 retiré) ; un même numéro ne peut pas être ajouté deux fois.
- **Fiche contact** : boutons **Appeler**, **SMS** et **WhatsApp**. Ils ouvrent seulement l'application du téléphone avec un message prérempli (« Bonjour Prénom, »). Wallindirain ne lit aucune conversation et n'envoie rien.
- **Notes datées** (500 caractères, 100 par contact), retirables (masquées, conservées).
- **Étiquettes colorées** (Pro) : jusqu'à 20, 10 par contact, filtre dans la liste.
- **Import de fichier** (Pro) : CSV, texte ou vCard (.vcf) lu dans le téléphone, aperçu et confirmation avant envoi, 500 lignes au plus ; doublons et lignes invalides ignorés.
- **Vendeur** : bouton « Ajouter mes clients » (reprend les clients de ses commandes) et historique des commandes sur la fiche (ses propres commandes avec ce numéro). Les outils existants (Mes clients, Relances) ne sont pas modifiés.
- **Archiver / rétablir** : rien n'est supprimé.
- Réglage ajouté : `pf_free_contacts` (30 par défaut) = nombre de contacts de la formule gratuite, modifiable dans Réglages → Mes finances. Pro = illimité.

## Règles contrôlées par la base
Fonction éteinte = rien ne marche. Chacun ne voit que son carnet. Limite du gratuit (création et rétablissement), étiquettes et import réservés Pro (`pro_required`) ; modifier, ajouter une note et archiver restent libres. Compte anonymisé : contacts, notes et étiquettes effacés.

## À signaler (données de tiers)
Le carnet contient des données personnelles de tiers (nom, téléphone). Elles ne sont visibles que de leur propriétaire et supprimées à l'anonymisation. Prévoir une mention dans les conditions d'utilisation : chacun doit avoir le droit de contacter les personnes qu'il enregistre.

## À la mise en production
4 tables (`pf_contacts`, `pf_contact_notes`, `pf_contact_labels`, `pf_contact_label_links`), fonctions `fn_pf_contact_*`, `fn_pf_label_*`, `fn_pf_contacts_from_orders`, un déclencheur, 1 réglage. Suit l'interrupteur « Mes finances » (éteint par défaut).
Retour arrière : `docs/retour-arriere-050.sql` (refuse s'il existe des données ; à appliquer avant celui de la 049).
