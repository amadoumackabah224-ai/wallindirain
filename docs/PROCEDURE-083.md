# Procédure 083 — Rappels clients à heure précise

## Ce que ça fait
- Le vendeur choisit une date ET une heure pour rappeler un client (aujourd'hui 11 h, 17 h, demain 9 h, dans une semaine, ou sur mesure).
- Les rappels apparaissent dans la page Relances (carte « Mes rappels ») et dans « Aujourd'hui ».
- À l'heure dite, le vendeur reçoit une notification (une seule fois). Contrôle toutes les 60 secondes.

## Activation
Nécessite la fonction Relances (Réglages > Fonctions, feature_relances). Aucun nouveau réglage.

## Migration
- 083_rappels_heure.sql : colonnes due_time et notified_at (relance_reminders), fonctions fn_seller_relance_remind_at, fn_seller_reminders, fn_run_relance_reminders. Appliquée automatiquement au démarrage.
- Non destructive. Les rappels existants (date seule) restent valables, heure par défaut 8 h, sans notification rétroactive.

## Retour arrière
docs/retour-arriere-083.sql (refuse si des rappels avec heure existent : les supprimer ou les convertir d'abord).
