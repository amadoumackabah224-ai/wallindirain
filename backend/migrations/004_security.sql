-- =====================================================================
-- Migration 004 : droits PostgreSQL (moindre privilège)
-- L'API se connecte avec le rôle wld_app. Ce rôle :
--   * peut LIRE les tables (sauf mots de passe, codes et secrets),
--   * ne peut RIEN écrire directement : toute écriture passe par fn_* (SECURITY DEFINER).
-- =====================================================================

-- Messagerie : file d'envoi utilisée par le worker
CREATE FUNCTION fn_messages_claim(p_limit int DEFAULT 20)
RETURNS TABLE(id bigint, to_phone text, channel text, template text, body text, order_id uuid)
LANGUAGE sql AS $$
  SELECT m.id, m.to_phone, m.channel, m.template, m.body, m.order_id
  FROM messages m WHERE m.status = 'queued' ORDER BY m.id LIMIT p_limit FOR UPDATE SKIP LOCKED
$$;

CREATE FUNCTION fn_message_mark(p_id bigint, p_status text, p_error text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_status NOT IN ('sent','simulated','failed','queued') THEN PERFORM _err('invalid_input', 'Statut de message invalide'); END IF;
  UPDATE messages SET status = p_status, error = p_error,
         sent_at = CASE WHEN p_status IN ('sent','simulated') THEN now() END WHERE id = p_id;
END $$;

-- Vérification de cohérence comptable : doit toujours renvoyer 0 ligne
CREATE FUNCTION fn_ledger_check() RETURNS TABLE(problem text, detail text)
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

-- ---------- Verrouillage des droits ----------
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO wld_app;

DO $$
DECLARE r record; v_cols text;
BEGIN
  -- toutes les fonctions publiques s'exécutent avec les droits du propriétaire
  FOR r IN SELECT p.oid::regprocedure AS sig, p.proname FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.prokind = 'f' AND (p.proname LIKE '\_%' OR p.proname LIKE 'fn\_%') LOOP
    EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER SET search_path = public, pg_temp', r.sig);
    IF r.proname LIKE 'fn\_%' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO wld_app', r.sig); END IF;
  END LOOP;

  -- lecture des tables, colonnes sensibles exclues
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r'
             AND c.relname NOT IN ('order_secrets','one_time_codes','sessions') LOOP
    SELECT string_agg(quote_ident(column_name), ', ') INTO v_cols
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = r.relname
       AND column_name NOT IN ('password_hash','failed_attempts','locked_until','delivery_code_hash','code_hash');
    EXECUTE format('GRANT SELECT (%s) ON %I TO wld_app', v_cols, r.relname);
  END LOOP;
END $$;
