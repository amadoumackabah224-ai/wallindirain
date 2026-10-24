-- =====================================================================
-- RAPPORT À LANCER SUR LA BASE DE PRODUCTION AVANT LA MIGRATION 017 (LECTURE SEULE)
-- N'écrit rien, ne corrige rien. Chaque requête se lance séparément (Neon : éditeur SQL).
-- Envoyez les 7 résultats : tant qu'ils ne sont pas communiqués, la production n'est PAS validée.
-- =====================================================================

-- 1) Écritures en double (même commande, même bénéficiaire, même type)       ATTENDU : 0 ligne
SELECT order_id, user_id, kind, count(*) AS nombre, sum(amount) AS total
FROM wallet_entries
WHERE order_id IS NOT NULL
  AND (kind IN ('seller_gain','supplier_payment','platform_revenue','float_release','return_fees',
                'return_fee_supplier','prepaid_refund','transport_loss','referral_bonus')
       OR (kind = 'team_pay' AND amount > 0))
GROUP BY order_id, user_id, kind
HAVING count(*) > 1;

-- 2) Commandes dont la paie du livreur dépasse les frais de livraison        ATTENDU : 0 ligne
SELECT ref, status, delivery_fee, courier_pay FROM orders WHERE courier_pay > delivery_fee;

-- 3) Zones actives sous la paie fixe (seulement si la part en % est à 0)      ATTENDU : 0 ligne
SELECT r.commune, r.fee, s.value AS paie_fixe FROM delivery_rates r, settings s
WHERE r.active AND s.key = 'courier_pay' AND r.fee < s.value
  AND (SELECT value FROM settings WHERE key = 'courier_share_bps') = 0;

-- 4) Contrôle comptable existant                                              ATTENDU : 0 ligne
SELECT * FROM fn_ledger_check();

-- 5) Zones actives à tarif nul                                                ATTENDU : 0 ligne
SELECT commune FROM delivery_rates WHERE active AND fee = 0;

-- 6) Photographie à comparer avant et après la migration                      ATTENDU : 1 ligne, notée ; identique après
SELECT (SELECT count(*) FROM wallet_entries) AS ecritures,
       (SELECT COALESCE(sum(amount), 0) FROM wallet_entries) AS somme_ecritures,
       (SELECT count(*) FROM orders) AS commandes,
       (SELECT count(*) FROM delivery_rates WHERE active) AS zones_actives,
       (SELECT min(fee) FROM delivery_rates WHERE active) AS frais_min_actif,
       (SELECT value FROM settings WHERE key = 'courier_share_bps') AS part_livreur,
       (SELECT value FROM settings WHERE key = 'courier_pay') AS paie_fixe;

-- 7) État des migrations                                                      ATTENDU : la plus récente est 016_accord_textes.sql
SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 3;
