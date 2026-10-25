-- =====================================================================
-- RAPPORT DE CONTRÔLE DE LA PRODUCTION APRÈS LES MIGRATIONS 017 À 023 (LECTURE SEULE)
-- N'écrit rien, ne corrige rien, n'affiche aucun mot de passe ni donnée personnelle.
-- Neon : projet Wallindirain, branche « production », éditeur SQL. Collez UNE requête à la fois, puis envoyez le résultat (une capture suffit).
-- =====================================================================

-- 1) Migrations appliquées                                   ATTENDU : 023_photos_produits.sql en premier, puis 022, 021, 020, 019, 018, 017
SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 8;

-- 2) Contrôle de la comptabilité                              ATTENDU : 0 ligne
SELECT * FROM fn_ledger_check();

-- 3) Écritures en double (même commande, même bénéficiaire, même type)   ATTENDU : 0 ligne
SELECT order_id, user_id, kind, count(*) AS nombre
FROM wallet_entries
WHERE order_id IS NOT NULL
  AND (kind IN ('seller_gain','supplier_payment','platform_revenue','float_release','return_fees','return_fee_supplier','prepaid_refund','transport_loss','referral_bonus')
       OR (kind = 'team_pay' AND amount > 0))
GROUP BY order_id, user_id, kind HAVING count(*) > 1;

-- 4) Tables des nouvelles fonctions                           ATTENDU : 7 lignes (courier_profiles, courier_zones, mission_offers, order_requests, product_images, tour_stops, tours)
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name IN ('order_requests','courier_profiles','courier_zones','mission_offers','tours','tour_stops','product_images')
ORDER BY table_name;

-- 5) Droits de l'application : aucune écriture directe, octets des photos illisibles   ATTENDU : toutes les colonnes à « false »
SELECT has_table_privilege('wld_app', 'tours', 'INSERT') AS ecrit_tournees,
       has_table_privilege('wld_app', 'product_images', 'INSERT') AS ecrit_photos,
       has_column_privilege('wld_app', 'product_images', 'data', 'SELECT') AS lit_octets_photos,
       has_table_privilege('wld_app', 'order_requests', 'SELECT') AS lit_cles_commande,
       has_function_privilege('wld_app', '_tours_refresh()', 'EXECUTE') AS appelle_fonction_interne;

-- 6) Compteurs (information, aucun nom, aucun numéro)         ATTENDU : des nombres cohérents avec ce que vous avez testé
SELECT (SELECT count(*) FROM orders) AS commandes, (SELECT count(*) FROM products) AS produits, (SELECT count(*) FROM product_images) AS photos,
       (SELECT count(*) FROM tours) AS tournees, (SELECT count(*) FROM mission_offers) AS propositions,
       (SELECT count(*) FROM courier_profiles) AS profils_livreurs;
