# Base de données (PostgreSQL 16)

Source de vérité : `backend/migrations/*.sql`. Ce document les résume ; en cas de doute, le SQL fait foi.

## Conventions

- **Montants** : entiers en GNF (`bigint`), jamais de décimaux. Marge en points de base (1500 = 15 %).
- **Suppressions logiques** (`deleted_at`) ; la suppression physique des comptes, produits, commandes et retraits est interdite par trigger.
- **Fonctions** : `fn_*` = point d'entrée appelé par l'API ; `_*` = interne (non appelable par l'application). Erreur métier : SQLSTATE `WLD01`, message `code|Texte`.
- **Ajout seul** (UPDATE/DELETE interdits par trigger) : `wallet_entries`, `order_history`, `calls`, `audit_log`, `cash_counts`.
- **Figé à la création** d'une commande (trigger `orders_frozen`) : prix, frais, rémunérations, délai de déblocage, code, quantité, vendeur, produit, commune, téléphone client.

## Tables

| Groupe | Table | Contenu |
|---|---|---|
| Comptes | `users` | rôle, statut (`pending`/`active`/`suspended`), identité (`identity_doc`, `identity_verified`), équipe (call center), compteur d'échecs et blocage |
| | `sessions` | empreinte SHA-256 du jeton, expiration (12 h) |
| | `one_time_codes` | codes à 6 chiffres (mot de passe oublié, retrait), hachés, 5 essais, 15 min |
| Réglages | `settings` | marge, frais de call center, rémunérations, délai de déblocage, retrait minimum, essais de code, escalade |
| | `delivery_rates` | tarif par commune (Kaloum, Dixinn, Matam 25 000 ; Ratoma, Matoto 30 000) |
| Catalogue | `products` | fournisseur, prix fournisseur, **marge figée à la validation**, mode de stockage, stock et réservé, statut |
| | `arrivals` | arrivage annoncé et quantité comptée par le magasinier |
| | `seller_prices`, `seller_stock`, `seller_links` | prix de vente, stock acheté, lien partagé par produit |
| Commandes | `orders` | tout le cycle ; montants figés ; référence `WLD-n` ; code de livraison **haché** |
| | `order_secrets` | code en clair, **supprimé** dès la fin de vie de la commande |
| | `order_history` | chaque changement de statut (qui, quand) |
| | `calls` | chaque appel : agent, call center, résultat, note |
| | `risky_customers` | clients déjà refusés ou retournés |
| Argent | `wallet_entries` | tous les mouvements, avec date de déblocage ; solde = somme |
| | `withdrawals` | demandes de retrait (Orange Money / MTN MoMo) et référence de paiement |
| | `courier_cash_entries`, `cash_counts` | encaissements des livreurs et comptages de caisse |
| Contrôle | `audit_log` | dépôts, retraits, tarifs, validations, caisses, retours, réglages |
| | `messages` | messages WhatsApp/SMS tracés (statut `queued`/`sent`/`simulated`/`failed`) |

Comptes système (jamais connectables) : « Wallindirain (résultat) » reçoit livraison + call center + marge et paie les équipes ; « Wallindirain (stock prépayé) » détient l'argent du stock acheté d'avance jusqu'à sa vente.

## Réglages par défaut (`settings`, modifiables par l'administrateur)

| Clé | Valeur | Sens |
|---|---|---|
| `margin_bps` | 1500 | marge Wallindirain (15 %) |
| `call_fee` | 5000 | frais de call center par commande |
| `agent_pay` | 1000 | par commande confirmée |
| `courier_pay` | 5000 | par livraison |
| `unlock_hours` | 48 | déblocage des gains |
| `min_withdrawal` | 50000 | retrait minimum |
| `code_max_attempts` | 5 | essais du code de livraison |
| `call_attempt_limit` | 5 | appels injoignables avant escalade au chef |

Un changement de réglage ne touche jamais les commandes déjà créées (valeurs copiées dans la commande).

## Fonctions publiées (`fn_*`)

- **Comptes** : `fn_register`, `fn_admin_create_staff`, `fn_admin_set_user_status`, `fn_admin_verify_identity`, `fn_login_lookup`, `fn_login_failed`, `fn_login_ok`, `fn_session_create`, `fn_session_user`, `fn_session_revoke`, `fn_password_reset_request`, `fn_password_reset_confirm`
- **Catalogue** : `fn_supplier_add_product`, `fn_admin_review_product`, `fn_admin_set_product_margin`, `fn_supplier_announce_arrival`, `fn_warehouse_count_arrival`, `fn_supplier_set_stock`, `fn_seller_set_price`, `fn_seller_create_link`, `fn_seller_buy_stock`
- **Commandes** : `fn_public_order`, `fn_seller_create_order`, `fn_seller_cancel_order`, `fn_staff_cancel_order`, `fn_agent_take_order`, `fn_agent_log_call`, `fn_chief_assign`, `fn_courier_pickup`, `fn_courier_depart`, `fn_courier_deliver`, `fn_courier_fail`, `fn_chief_return_to_warehouse`, `fn_warehouse_receive_return`
- **Argent** : `fn_admin_deposit`, `fn_admin_count_cash`, `fn_withdrawal_request`, `fn_withdrawal_confirm`, `fn_admin_pay_withdrawal`, `fn_admin_reject_withdrawal`, `fn_admin_set_setting`, `fn_admin_set_delivery_rate`
- **Exploitation** : `fn_messages_claim`, `fn_message_mark`, `fn_release_stale_locks`, `fn_ledger_check`

`fn_ledger_check()` doit toujours renvoyer **0 ligne** (livraison sans répartition, stock réservé incohérent). Le tableau de bord administrateur l'affiche ; surveillez-le.

## Répartition de l'argent à la livraison (`_settle_delivery`)

Pour une commande livrée : `gain vendeur = prix de vente − livraison − call center − (prix vendeur × quantités tirées du catalogue)`. Le fournisseur reçoit `prix fournisseur × quantité`. Wallindirain reçoit `livraison + call center + marge × quantité`. La fonction **refuse la livraison** (erreur `ledger_mismatch`) si `fournisseur + vendeur + Wallindirain ≠ argent encaissé (+ stock prépayé)`. Gains et paiement fournisseur sont bloqués `unlock_hours` heures. Exemple du cahier : 150 000 = 60 000 + 9 000 + 30 000 + 5 000 + 46 000 ; résultat Wallindirain après rémunérations (6 000) : 38 000.

## Retours (`fn_warehouse_receive_return`) : qui paie selon la cause saisie par le magasinier

| Cause | Conséquence |
|---|---|
| `customer_refusal` | le vendeur paie livraison + call center ; le stock est libéré (le produit retourne en stock) ; le client est signalé à risque |
| `defective` | le fournisseur paie la livraison ; pas de remise en stock ; le stock prépayé du vendeur lui est remboursé. *Formule C (produit propre) : traité comme un refus, aux frais du vendeur.* |
| `damaged_transport` | à la charge de Wallindirain : elle paie au fournisseur le prix fournisseur perdu et rembourse le stock prépayé du vendeur ; pas de remise en stock |

Ces trois lignes appliquent le §4.5 du cahier. Les montants exacts pour « défectueux » et « abîmé » ne sont pas chiffrés dans le cahier : voir `CAHIER-DES-CHARGES-TRACABILITE.md`, hypothèses 1 à 3.

## Droits PostgreSQL

Le compte `wld_app` (utilisé par l'application) ne peut **que** exécuter les fonctions `fn_*` et lire des colonnes autorisées. Il ne peut lire ni `password_hash`, ni `delivery_code_hash`, ni `code_hash`, ni `order_secrets`, ni `one_time_codes`, ni `sessions`, et ne peut rien écrire directement. Le compte propriétaire sert uniquement aux migrations, sauvegardes et à la création du premier administrateur. Toutes les fonctions sont `SECURITY DEFINER` avec `search_path` fixé (protection contre le détournement de schéma).

## Ajouter ou modifier une règle

1. Créer `backend/migrations/00N_description.sql` (jamais de modification d'une migration déjà déployée).
2. Fonction `CREATE OR REPLACE FUNCTION fn_…`, avec `_require(p_actor, ARRAY[…])` en première ligne.
3. Relancer `node src/migrate.js` : la nouvelle migration s'applique ; le script de droits de `004` ne rattrape **pas** les fonctions créées après lui : ajoutez en fin de migration `ALTER FUNCTION … SECURITY DEFINER SET search_path = public, pg_temp; REVOKE ALL ON FUNCTION … FROM PUBLIC; GRANT EXECUTE ON FUNCTION … TO wld_app;`.
4. Ajouter un test dans `backend/tests/rules.test.js`.


## Protections (migration 017)

- `order_requests(scope, req_key, order_id, fingerprint)` : mémorise les clés de demande (anti double commande). Table **non lisible** par l'application ; seules les fonctions `fn_seller_create_order_once` et `fn_public_order_once` y accèdent. Les futures migrations doivent l'exclure de la boucle de droits.
- Index uniques `wallet_settle_once_uq` et `wallet_team_pay_once_uq` : un règlement ne s'écrit qu'une fois par commande, utilisateur et type.
- Déclencheur `orders_courier_guard` : refuse toute commande dont la paie du livreur dépasse les frais de livraison.
- Plafond technique `courier_share_bps` ≤ 9000 (aucune valeur modifiée).
- Retour arrière : `docs/retour-arriere-017.sql`. Contrôle de production : `docs/rapport-production-017.sql`. Procédure : `docs/PROCEDURE-017.md`.
- Consentement client (lien public) : enregistré par `fn_public_order_once`, dans la même transaction que la commande et seulement à la première création (jamais sur un rejeu ni un refus). Les consentements existants ne sont jamais modifiés (table en ajout seul).
- `fn_audit_guard_refusal(acteur, source, zone)` : journalise (action `order_refused_pay_guard`) un refus du garde-fou, appelée par le serveur après l'annulation de la transaction. Aucune paie ni montant ; zone connue seulement ; au plus une ligne par minute pour (acteur, source, zone).

## Profil du livreur (migration 018)

- `courier_profiles(courier_id, vehicle, availability, updated_at, updated_by)` et `courier_zones(courier_id, commune)` : véhicule, disponibilité et zones couvertes. Aucune donnée personnelle ni financière.
- Fonctions : `fn_admin_set_courier_profile`, `fn_admin_set_courier_zones` (administrateur), `fn_courier_set_availability`, `fn_courier_profile` (le livreur, pour lui seul).
- **L'affectation ne change pas** : le chef peut toujours affecter n'importe quel livreur actif, même indisponible ou sans zone. Ces informations aident à choisir et préparent la répartition automatique (migration 020).
- Retour arrière : `docs/retour-arriere-018.sql` (efface seulement les profils et zones).

## Propositions de mission (migration 019)

- `mission_offers(order_id, courier_id, offered_by, status, refuse_reason, expires_at…)` : le chef propose, le livreur répond. Une seule proposition ouverte par commande (index unique), une seule fois par livreur et par commande.
- Accepter appelle `fn_chief_assign` (affectation existante). Refuser ou laisser expirer : aucune écriture financière, aucune pénalité.
- Réglages ajoutés (modifiables par l'administrateur) : `mission_offer_minutes` (10), `mission_max_offers` (3), `courier_max_open` (3). Une valeur à 0 est traitée comme 1.
- Expiration vérifiée à chaque appel (`_expire_offers`), sans minuteur. Un refus de l'application annule sa transaction : le statut « expirée » ou « annulée » est écrit à la lecture suivante ; le comportement (refus de l'acceptation tardive) est correct dans tous les cas.
- **Retours arrière dans l'ordre inverse** : 019, puis 018, puis 017.

## Tournées (020)
- `tours` (id, courier_id, created_by, status active|closed|cancelled, note, actual_cost, created_at, closed_at).
- `tour_stops` (tour_id, order_id, position, active) ; index unique : une commande n'a qu'un arrêt actif.
- Fonctions : `fn_chief_create_tour`, `fn_chief_cancel_tour`, `fn_chief_set_tour_cost`, `fn_chief_tours`, `fn_courier_tours`, interne `_tours_refresh`. Lecture seule pour l'application ; aucune écriture comptable.
- Retour arrière : `docs/retour-arriere-020.sql`.

## Lieu de récupération (022)
- `products.pickup_detail`, `orders.pickup_detail` (3-200 caractères, facultatifs). Fonctions `fn_seller_set_pickup`, `fn_supplier_set_pickup`. Retour arrière : `docs/retour-arriere-022.sql`.

## Photos des produits (023)
- `product_images` (id, product_id, position 1-4, mime, data bytea 1 000 à 450 000 octets, created_at), `UNIQUE (product_id, position)` ; la colonne `data` n'est pas lisible directement par l'application.
- Fonctions `fn_supplier_add_product_image`, `fn_supplier_delete_product_image`, `fn_product_image_get`, `fn_public_product_photo`. Retour arrière : `docs/retour-arriere-023.sql`.

## Reversement en espèces, ordre des tournées (024)
- `remittances` : `method` accepte `cash`, `proof_id` devient facultatif (obligatoire sauf espèces), `handed_to` (nom de la personne qui a reçu). Fonctions `fn_courier_remit` (nouveau paramètre `p_handed_to`), `fn_chief_reorder_tour`, `fn_chief_tours` (montants prévus). Retour arrière : `docs/retour-arriere-024.sql` (refusé s'il existe des espèces).

## Tournée proposée, bonus (025)
- `tours.status` : `proposed`, `active`, `closed`, `cancelled`, `refused` ; colonnes `bonus_per_extra` (figé), `accepted_at`, `bonus_paid`. Réglage `tour_bonus_per_extra_order` (0 par défaut). Écritures `tour_bonus` (livreur +, plateforme −) uniques par commande d'ancrage.
- Fonctions `fn_courier_accept_tour`, `fn_courier_refuse_tour`, internes `_tour_pay_bonus`, `_tour_release_orders` ; `fn_courier_pickup`, `fn_chief_create_tour`, `fn_chief_cancel_tour`, `fn_ledger_check` mises à jour. Retour arrière : `docs/retour-arriere-025.sql`.

### Migration 026 — modes de paie de tournée
`tours.pay_mode` (`normal`/`share`/`split`), `tours.mode_bps` (figé à la création), `tours.adjust_paid` (écart signé écrit une fois). Écritures de portefeuille `tour_adjust` (livreur) / contrepartie plateforme. Réglages `tour_share_bps` (0) et `tour_extra_share_bps` (5000). Fonctions internes `_tour_target_pay`, `_tour_plan`. `fn_chief_create_tour` prend un 5ᵉ paramètre `p_mode` (défaut `normal`).
