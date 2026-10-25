-- RETOUR ARRIÈRE de la migration 024 (versement en espèces, ordre des tournées). JAMAIS AUTOMATIQUE.
-- REFUSE de s'exécuter s'il existe un reversement en espèces enregistré (il ne doit jamais être supprimé : donnée financière). À faire AVANT les retours arrière 023, 022…
-- Retirer aussi le code déployé correspondant.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM remittances WHERE method = 'cash') THEN
    RAISE EXCEPTION 'Retour arrière impossible : des reversements en espèces existent (donnée financière à conserver)';
  END IF;
END $$;
DROP FUNCTION fn_courier_remit(uuid, text, uuid, text, uuid[], text);
CREATE FUNCTION fn_courier_remit(p_actor uuid, p_method text, p_proof uuid, p_reference text, p_orders uuid[] DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_id uuid := gen_random_uuid(); v_amount bigint; v_n int;
BEGIN
  PERFORM _require(p_actor, ARRAY['courier']::user_role[]);
  IF p_method NOT IN ('orange_money','mtn_momo') THEN PERFORM _err('invalid_input', 'Mode de paiement invalide'); END IF;
  IF p_proof IS NULL THEN PERFORM _err('proof_required', 'Joignez la capture d''écran du transfert'); END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cash:' || p_actor::text));
  PERFORM _check_proof(p_actor, p_proof, 'remittance');
  SELECT COALESCE(sum(amount), 0), count(*) INTO v_amount, v_n FROM courier_cash_entries
   WHERE courier_id = p_actor AND count_id IS NULL AND remittance_id IS NULL AND (p_orders IS NULL OR order_id = ANY (p_orders));
  IF v_n = 0 THEN PERFORM _err('invalid_state', 'Aucun encaissement à reverser'); END IF;
  IF p_orders IS NOT NULL AND v_n <> cardinality(p_orders) THEN
    PERFORM _err('invalid_state', 'Une des commandes choisies n''est plus à reverser');
  END IF;
  INSERT INTO remittances(id, courier_id, method, amount, proof_id, reference)
  VALUES (v_id, p_actor, p_method, v_amount, p_proof, NULLIF(trim(COALESCE(p_reference, '')), ''));
  UPDATE courier_cash_entries SET remittance_id = v_id
   WHERE courier_id = p_actor AND count_id IS NULL AND remittance_id IS NULL AND (p_orders IS NULL OR order_id = ANY (p_orders));
  PERFORM _audit(p_actor, 'remittance_declared', 'remittance', v_id::text, jsonb_build_object('amount', v_amount, 'method', p_method));
  RETURN jsonb_build_object('id', v_id, 'amount', v_amount);
END $$;
DROP FUNCTION fn_chief_reorder_tour(uuid, uuid, uuid[]);
ALTER TABLE remittances DROP CONSTRAINT remittances_proof_or_cash;
ALTER TABLE remittances DROP CONSTRAINT remittances_method_check;
ALTER TABLE remittances DROP COLUMN handed_to;
ALTER TABLE remittances ALTER COLUMN proof_id SET NOT NULL;
ALTER TABLE remittances ADD CONSTRAINT remittances_method_check CHECK (method IN ('orange_money','mtn_momo'));
CREATE OR REPLACE FUNCTION fn_chief_tours(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['call_chief', 'admin']::user_role[]);
  PERFORM _tours_refresh();
  RETURN COALESCE((SELECT jsonb_agg(x ORDER BY (x->>'created_at') DESC) FROM (
    SELECT jsonb_build_object(
      'id', t.id, 'status', t.status, 'note', t.note, 'created_at', t.created_at, 'closed_at', t.closed_at,
      'courier_id', t.courier_id, 'courier_name', u.full_name, 'actual_cost', t.actual_cost,
      'stops', (SELECT jsonb_agg(jsonb_build_object('order_id', o.id, 'ref', o.ref, 'commune', o.commune, 'status', o.status, 'position', s.position, 'active', s.active) ORDER BY s.position)
                  FROM tour_stops s JOIN orders o ON o.id = s.order_id WHERE s.tour_id = t.id),
      'orders', (SELECT count(*) FROM tour_stops s WHERE s.tour_id = t.id),
      'delivered', (SELECT count(*) FROM tour_stops s JOIN orders o ON o.id = s.order_id WHERE s.tour_id = t.id AND o.status = 'delivered'),
      'delivery_fees', COALESCE((SELECT sum(o.delivery_fee) FROM tour_stops s JOIN orders o ON o.id = s.order_id WHERE s.tour_id = t.id AND o.status = 'delivered'), 0),
      'courier_pay_system', COALESCE((SELECT sum(o.courier_pay) FROM tour_stops s JOIN orders o ON o.id = s.order_id WHERE s.tour_id = t.id AND o.status = 'delivered'), 0)) AS x
    FROM tours t JOIN users u ON u.id = t.courier_id
    WHERE t.status = 'active' OR t.id IN (SELECT id FROM tours WHERE status <> 'active' ORDER BY created_at DESC LIMIT 30)) q), '[]'::jsonb);
END $$;

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
       AND NOT (r.relname IN ('proofs','avatars','product_images') AND column_name = 'data')
       AND NOT (r.relname = 'identity_documents' AND column_name IN ('front','back','selfie'));
    EXECUTE format('GRANT SELECT (%s) ON %I TO wld_app', v_cols, r.relname);
  END LOOP;
END $$;

DELETE FROM schema_migrations WHERE name = '024_versement_especes_ordre.sql';
COMMIT;
