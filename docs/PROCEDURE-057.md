# Migration 057 : espaces de groupe (Mes finances)

## Ce que ça fait
- **Un espace = un budget partagé** (boutique, association, tontine, équipe), **séparé** des finances personnelles de chacun : ses comptes, ses opérations et son journal sont à part.
- **Réglage admin `pf_spaces`** (éteint par défaut) : onglet Administration → Fonctionnalités. Éteint, rien n'apparaît. Dans l'application, l'entrée « Espaces de groupe » est dans « Plus », pour les profils entreprise / les deux.
- **Création réservée à la formule Pro** (limite `pf_space_max_spaces` = 3 espaces actifs par personne). Membres : `pf_space_max_members` = 10.
- **Invitation par téléphone**, uniquement pour une personne qui a déjà un compte ; elle accepte ou refuse.
- **Rôles** : propriétaire (tout, gère les membres) · comptable (écrit et corrige tout, voit le journal) · contributeur (ajoute ses propres opérations, ne modifie que les siennes) · lecteur (consulte).
- **Un non-membre ne voit rien** : l'espace lui est « introuvable ». Les numéros de téléphone des membres ne sont visibles que par le propriétaire.
- **Si le Pro du propriétaire se termine**, l'espace passe en lecture seule pour tous ; les données sont conservées. Archiver = lecture seule aussi. Rien n'est supprimé : une opération « supprimée » est seulement annulée, et le journal (append-only) garde la trace.
- Montants en GNF ; catégories = celles du propriétaire de l'espace.

## À la mise en production
5 tables, 3 réglages, fonctions `fn_pf_space_*` (création, membres, comptes, opérations, virement), 1 déclencheur d'anonymisation. Aucune donnée existante modifiée. Retour arrière : `docs/retour-arriere-057.sql` (refuse s'il existe des espaces).
