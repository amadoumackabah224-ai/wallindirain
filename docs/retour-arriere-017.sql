-- =====================================================================
-- RETOUR ARRIÈRE de la migration 017 (protections). À lancer SEULEMENT en cas de besoin, jamais automatiquement.
-- Effets : supprime le garde-fou, les deux index, les fonctions enveloppes et la table des clés d'envoi ;
--          remet les cinq fonctions modifiées à leur texte d'avant (copié mot pour mot des migrations d'origine) ;
--          remet les droits ; retire la ligne 017 de schema_migrations.
-- NE TOUCHE À AUCUNE donnée financière : écritures, commandes, paramètres (valeurs), tarifs restent tels quels.
-- Perte : uniquement les clés d'envoi (aucune valeur métier).
-- IMPORTANT : retirer aussi le fichier 017_protections.sql du code déployé, sinon il serait réappliqué au prochain démarrage.
-- =====================================================================
BEGIN;

DROP TRIGGER IF EXISTS orders_courier_guard ON orders;
DROP FUNCTION IF EXISTS _orders_courier_guard();
DROP INDEX IF EXISTS wallet_settle_once_uq;
DROP INDEX IF EXISTS wallet_team_pay_once_uq;
DROP FUNCTION IF EXISTS fn_seller_create_order_once(uuid, text, uuid, text, bigint, int, text, text, text, text, text, boolean);
DROP FUNCTION IF EXISTS fn_public_order_once(text, text, int, text, text, text, text, text);
DROP FUNCTION IF EXISTS fn_audit_guard_refusal(uuid, text, text);
DROP FUNCTION IF EXISTS _request_key_ok(text);
DROP TABLE IF EXISTS order_requests;

-- fn_seller_import_order : texte de la migration 009
CREATE OR REPLACE FUNCTION fn_seller_import_order(p_actor uuid, p_hash text, p_product uuid, p_own_name text, p_unit_price bigint, p_qty int,
                                       p_cname text, p_cphone text, p_commune text, p_address text, p_note text, p_preconfirmed boolean)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  IF p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' THEN PERFORM _err('invalid_input', 'Ligne invalide'); END IF;
  IF EXISTS (SELECT 1 FROM sheet_imports WHERE seller_id = p_actor AND row_hash = p_hash) THEN
    RETURN jsonb_build_object('duplicate', true);
  END IF;
  r := fn_seller_create_order(p_actor, p_product, p_own_name, p_unit_price, p_qty, p_cname, p_cphone, p_commune, p_address, p_note, p_preconfirmed);
  INSERT INTO sheet_imports(seller_id, row_hash, order_id) VALUES (p_actor, p_hash, (r->>'id')::uuid);
  RETURN r;
END $$;

-- fn_admin_reset_activity : texte de la migration 009
CREATE OR REPLACE FUNCTION fn_admin_reset_activity(p_actor uuid, p_confirm text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_orders bigint; v_entries bigint;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_confirm IS DISTINCT FROM 'REINITIALISER' THEN PERFORM _err('invalid_input', 'Tapez REINITIALISER pour confirmer'); END IF;
  SELECT count(*) INTO v_orders FROM orders;
  SELECT count(*) INTO v_entries FROM wallet_entries;
  TRUNCATE TABLE order_payments, cash_counts, courier_cash_entries, remittances, withdrawals, wallet_entries, order_secrets,
                 order_history, calls, risky_customers, sheet_imports, orders, arrivals, seller_stock, messages, one_time_codes, proofs
    RESTART IDENTITY;
  UPDATE products SET stock_qty = 0, reserved_qty = 0;
  PERFORM _audit(p_actor, 'activity_reset', 'system', NULL, jsonb_build_object('orders', v_orders, 'wallet_entries', v_entries));
  RETURN jsonb_build_object('orders', v_orders, 'wallet_entries', v_entries);
END $$;

-- fn_admin_set_delivery_rate : texte de la migration 015
CREATE OR REPLACE FUNCTION fn_admin_set_delivery_rate(p_actor uuid, p_commune text, p_fee bigint, p_active boolean DEFAULT true) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_old bigint;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_fee IS NULL OR p_fee < 0 OR p_fee > 1000000 THEN PERFORM _err('invalid_input', 'Tarif invalide'); END IF;
  IF p_commune IS NULL OR length(trim(p_commune)) < 2 OR length(p_commune) > 60 THEN PERFORM _err('invalid_input', 'Nom de zone invalide'); END IF;
  IF COALESCE(p_active, true) AND p_fee = 0 THEN PERFORM _err('invalid_input', 'Indiquez un tarif avant d''activer la zone'); END IF;
  SELECT fee INTO v_old FROM delivery_rates WHERE commune = trim(p_commune);
  INSERT INTO delivery_rates(commune, fee, active) VALUES (trim(p_commune), p_fee, COALESCE(p_active, true))
  ON CONFLICT (commune) DO UPDATE SET fee = EXCLUDED.fee, active = EXCLUDED.active;
  IF NOT EXISTS (SELECT 1 FROM delivery_rates WHERE active) THEN PERFORM _err('invalid_input', 'Gardez au moins une zone active'); END IF;
  PERFORM _audit(p_actor, 'delivery_rate_changed', 'zone', trim(p_commune),
                 jsonb_build_object('from', v_old, 'to', p_fee, 'active', COALESCE(p_active, true)));
END $$;

-- fn_admin_set_setting : texte de la migration 010
CREATE OR REPLACE FUNCTION fn_admin_set_setting(p_actor uuid, p_key text, p_value bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_old bigint;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_value IS NULL OR p_value < 0 THEN PERFORM _err('invalid_input', 'Valeur invalide'); END IF;
  IF p_key IN ('margin_bps','fee_order_bps','courier_share_bps') AND p_value > 10000 THEN PERFORM _err('invalid_input', 'Pourcentage invalide (10000 = 100 %)'); END IF;
  IF p_key IN ('code_max_attempts','call_attempt_limit') AND p_value < 1 THEN PERFORM _err('invalid_input', 'Valeur invalide'); END IF;
  IF p_key IN ('require_delivery_code','require_payment_proof','subscription_required','kyc_images_required') AND p_value > 1 THEN PERFORM _err('invalid_input', 'Valeur invalide : 0 ou 1'); END IF;
  SELECT value INTO v_old FROM settings WHERE key = p_key FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Réglage inconnu'); END IF;
  UPDATE settings SET value = p_value WHERE key = p_key;
  PERFORM _audit(p_actor, 'setting_changed', 'setting', p_key, jsonb_build_object('from', v_old, 'to', p_value));
END $$;

-- fn_ledger_check : texte de la migration 004
CREATE OR REPLACE FUNCTION fn_ledger_check() RETURNS TABLE(problem text, detail text)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN QUERY
  SELECT 'commande livrée sans répartition'::text, o.ref FROM orders o
   WHERE o.status = 'delivered' AND NOT EXISTS (SELECT 1 FROM wallet_entries w WHERE w.order_id = o.id AND w.kind = 'seller_gain');
  RETURN QUERY
  SELECT 'stock réservé incohérent'::text, p.id::text FROM products p
   WHERE p.reserved_qty <> COALESCE((SELECT sum(o.qty_from_catalog) FROM orders o
         WHERE o.product_id = p.id AND o.status IN ('new','in_call','confirmed','assigned','picked_up','on_the_way','failed','return_pending')), 0);
  RETURN QUERY
  SELECT 'stock vendeur réservé incohérent'::text, s.seller_id::text || '/' || s.product_id::text FROM seller_stock s
   WHERE s.reserved_qty <> COALESCE((SELECT sum(o.qty_from_seller) FROM orders o
         WHERE o.product_id = s.product_id AND o.seller_id = s.seller_id
           AND o.status IN ('new','in_call','confirmed','assigned','picked_up','on_the_way','failed','return_pending')), 0);
END $$;

-- Étiquette du paramètre (texte seulement)
UPDATE settings SET label = replace(label, ' — maximum 9000 (90 %)', '') WHERE key = 'courier_share_bps';

-- Droits : même boucle que les migrations précédentes
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
DO $$
DECLARE r record; v_cols text;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS sig, p.proname FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.prokind = 'f' AND (p.proname LIKE '\_%' OR p.proname LIKE 'fn\_%' OR p.proname = 'trg_orders_frozen') LOOP
    IF r.proname <> 'trg_orders_frozen' THEN
      EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER SET search_path = public, pg_temp', r.sig);
      IF r.proname LIKE 'fn\_%' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO wld_app', r.sig); END IF;
    END IF;
  END LOOP;

  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r'
             AND c.relname NOT IN ('order_secrets','one_time_codes','sessions') LOOP
    SELECT string_agg(quote_ident(column_name), ', ') INTO v_cols
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = r.relname
       AND column_name NOT IN ('password_hash','failed_attempts','locked_until','delivery_code_hash','code_hash')
       AND NOT (r.relname IN ('proofs','avatars') AND column_name = 'data')
       AND NOT (r.relname = 'identity_documents' AND column_name IN ('front','back','selfie'));
    EXECUTE format('GRANT SELECT (%s) ON %I TO wld_app', v_cols, r.relname);
  END LOOP;
END $$;

DELETE FROM schema_migrations WHERE name = '017_protections.sql';

COMMIT;
