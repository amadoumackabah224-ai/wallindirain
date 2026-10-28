-- RETOUR ARRIÈRE de la migration 031 (espace du magasinier). JAMAIS AUTOMATIQUE.
-- REFUSE de s'exécuter si une casse / perte a été déclarée : le stock a été retiré et le journal en est la seule trace.
-- Retire : remises de colis, notes et photos de retour, écarts de comptage (colonne), alertes du magasinier. Restaure la fonction de comptage à l'identique.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM stock_losses) THEN RAISE EXCEPTION 'Retour arrière refusé : des casses ou pertes de stock ont été déclarées (journal à conserver)'; END IF;
END $$;
DROP TRIGGER IF EXISTS arrivals_notify ON arrivals;
DROP TRIGGER IF EXISTS orders_notify_prepare ON orders;
DROP FUNCTION IF EXISTS _notify_arrival();
DROP FUNCTION IF EXISTS _notify_prepare();
DROP FUNCTION IF EXISTS fn_warehouse_handover(uuid, uuid);
DROP FUNCTION IF EXISTS fn_warehouse_declare_loss(uuid, uuid, int, text, text);
DROP FUNCTION IF EXISTS fn_warehouse_return_note(uuid, uuid, text);
DROP FUNCTION IF EXISTS fn_warehouse_add_return_photo(uuid, uuid, text, bytea);
DROP FUNCTION IF EXISTS fn_return_photo_get(uuid, uuid);
DROP FUNCTION fn_warehouse_count_arrival(uuid, uuid, int, text);
CREATE FUNCTION fn_warehouse_count_arrival(p_actor uuid, p_arrival uuid, p_counted int) RETURNS void LANGUAGE plpgsql AS $$
DECLARE a arrivals;
BEGIN
  PERFORM _require(p_actor, ARRAY['warehouse','admin']::user_role[]);
  IF p_counted IS NULL OR p_counted < 0 THEN PERFORM _err('invalid_input', 'Quantité comptée invalide'); END IF;
  SELECT * INTO a FROM arrivals WHERE id = p_arrival FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Arrivage introuvable'); END IF;
  IF a.counted_qty IS NOT NULL THEN PERFORM _err('invalid_state', 'Arrivage déjà compté'); END IF;
  UPDATE arrivals SET counted_qty = p_counted, counted_by = p_actor, counted_at = now() WHERE id = p_arrival;
  UPDATE products SET stock_qty = stock_qty + p_counted WHERE id = a.product_id;
  PERFORM _audit(p_actor, 'arrival_counted', 'arrival', p_arrival::text,
                 jsonb_build_object('announced', a.announced_qty, 'counted', p_counted));
END $$;
CREATE OR REPLACE FUNCTION fn_admin_reset_activity(p_actor uuid, p_confirm text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_orders bigint; v_entries bigint;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_confirm IS DISTINCT FROM 'REINITIALISER' THEN PERFORM _err('invalid_input', 'Tapez REINITIALISER pour confirmer'); END IF;
  SELECT count(*) INTO v_orders FROM orders;
  SELECT count(*) INTO v_entries FROM wallet_entries;
  TRUNCATE TABLE order_payments, cash_counts, courier_cash_entries, remittances, withdrawals, wallet_entries, order_secrets,
                 order_history, calls, risky_customers, sheet_imports, order_requests, mission_offers, tour_stops, tours, orders, arrivals, seller_stock, messages, one_time_codes, proofs
    RESTART IDENTITY;
  UPDATE products SET stock_qty = 0, reserved_qty = 0;
  PERFORM _audit(p_actor, 'activity_reset', 'system', NULL, jsonb_build_object('orders', v_orders, 'wallet_entries', v_entries));
  RETURN jsonb_build_object('orders', v_orders, 'wallet_entries', v_entries);
END $$;

DROP TABLE return_photos;
DROP TABLE return_notes;
DROP TABLE stock_losses;
DROP TABLE order_handovers;
ALTER TABLE arrivals DROP COLUMN count_note;

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
             AND c.relname NOT IN ('order_secrets','one_time_codes','sessions','order_requests') LOOP
    SELECT string_agg(quote_ident(column_name), ', ') INTO v_cols
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = r.relname
       AND column_name NOT IN ('password_hash','failed_attempts','locked_until','delivery_code_hash','code_hash')
       AND NOT (r.relname IN ('proofs','avatars','product_images','return_photos') AND column_name = 'data')
       AND NOT (r.relname = 'identity_documents' AND column_name IN ('front','back','selfie'));
    EXECUTE format('GRANT SELECT (%s) ON %I TO wld_app', v_cols, r.relname);
  END LOOP;
END $$;

DELETE FROM schema_migrations WHERE name = '031_magasinier.sql';
COMMIT;
