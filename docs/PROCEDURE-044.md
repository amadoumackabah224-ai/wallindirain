# Migration 044 : relances clients

## Ce que ça fait
- **Onglet « Relances »** (vendeur) : le vendeur écrit ou appelle ses clients **un par un, avec son propre téléphone**. Wallindirain prépare la liste, le message et le suivi ; elle n'envoie rien elle-même.
- **Listes** : Fidèles, Nouveaux, Inactifs (30, 60 ou 90 jours), Livraison non aboutie, Par étiquette, Fêtes, Rappels du jour, et « À éviter » (lecture seule, sans bouton d'envoi).
- **Trois boutons séparés** : Message simple (SMS), WhatsApp, Appeler. Le téléphone ouvre l'application avec le message prérempli ; le vendeur relit, modifie, envoie, puis revient confirmer « C'est envoyé ». Pour un appel : Répondu / Pas de réponse / À rappeler (avec date).
- **Étiquettes** automatiques (Livré, Payé, Échec, À relancer, Nouveau, Fidèle, Bon client…) et étiquettes personnelles (couleurs, 30 au plus).
- **Rappels datés** par client, **fêtes** du vendeur (20 au plus), **modèles de message** (marques permises : `{prenom}`, `{boutique}`, `{fete}`).
- **Réglages du vendeur** : maximum de messages par jour (vide = aucune limite), délai entre deux messages au même client (14 jours par défaut, 7 au minimum), nom de boutique.
- **Désinscription** : « Ne plus contacter » retire le client de toutes les listes. Seul l'administrateur peut le réactiver (Réglages admin → Désinscrits).
- La mention « Répondez STOP… » est ajoutée au message par l'application.

## Règles contrôlées par la base (pas seulement par l'écran)
Fonction `_relance_check` : fonctionnalité activée, numéro valide, consentement du vendeur à jour, client du vendeur, client non désinscrit, client sans incident (`risky_customers`), délai minimum (SMS/WhatsApp ; les appels ne sont pas limités), maximum du vendeur par jour, plafond de sécurité de 3 000 par jour.

## Ce que ça ne fait pas
- Aucun montant touché : ni portefeuille, ni frais, ni tarif, ni part du livreur. Aucune table ou fonction existante modifiée.
- **Le texte du message n'est jamais envoyé au serveur ni enregistré.** Le journal (`relance_log`) garde seulement : vendeur, numéro du client, canal, résultat, liste, date.
- Pas d'envoi automatique, pas de campagne de masse, pas de code de livraison dans les messages.

## À la mise en production
- Migration : 8 tables (`relance_prefs`, `relance_optouts`, `relance_templates`, `relance_log`, `relance_tags`, `relance_customer_tags`, `relance_reminders`, `relance_feasts`), des fonctions `fn_seller_relance_*` / `fn_admin_relance_reactivate`, un déclencheur d'anonymisation (supprime les données de relance d'un vendeur anonymisé), et le réglage `feature_relances`.
- **La fonctionnalité est éteinte par défaut** (`feature_relances` = 0) : l'onglet apparaît mais affiche « pas encore disponible ». Pour l'allumer : réglage `feature_relances` = 1 (écran admin des réglages).
- Version du consentement : 1 (`_relance_consent_version()` en SQL et `RELANCE_CONSENT_VERSION` dans `backend/src/relances.js` doivent rester identiques ; en changer redemande l'accord à tous les vendeurs).

## Points restant à décider / à tester
1. **Texte d'engagement** (écran de consentement) à faire valider par un juriste avant d'allumer.
2. **Durée de conservation** du journal de relances : non décidée.
3. **Modèles proposés** (fidèles, nouveaux, inactifs…) : à relire et adapter par le propriétaire.
4. **Préremplissage SMS / WhatsApp** à tester sur de vrais téléphones Android et iPhone (impossible depuis le serveur de test). Liens utilisés : `sms:+224…?&body=…`, `https://wa.me/224…?text=…`, `tel:+224…`.
5. Le compteur « par jour » utilise la date de la base (UTC).

## Retour arrière
`docs/retour-arriere-044.sql` : refuse s'il existe des données de relance ou si `feature_relances` n'est pas à 0. À appliquer avant celui de la 043.
