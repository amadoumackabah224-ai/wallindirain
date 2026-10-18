-- =====================================================================
-- Migration 006 : code de livraison facultatif.
-- Réglage « require_delivery_code » : 0 = le livreur valide la livraison d'un seul geste (valeur par défaut),
-- 1 = le client reçoit un code à 4 chiffres que le livreur doit saisir (comportement d'origine, critère 3 du pilote).
-- Réversible à tout moment depuis Réglages, sans toucher au code.
-- =====================================================================

INSERT INTO settings(key, value, label) VALUES
  ('require_delivery_code', 0, 'Code de livraison à 4 chiffres obligatoire (1 = oui, 0 = non : le livreur valide en un geste)');

CREATE OR REPLACE FUNCTION fn_admin_set_setting(p_actor uuid, p_key text, p_value bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_old bigint;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_value IS NULL OR p_value < 0 THEN PERFORM _err('invalid_input', 'Valeur invalide'); END IF;
  IF p_key = 'margin_bps' AND p_value > 10000 THEN PERFORM _err('invalid_input', 'Marge invalide'); END IF;
  IF p_key IN ('code_max_attempts','call_attempt_limit') AND p_value < 1 THEN PERFORM _err('invalid_input', 'Valeur invalide'); END IF;
  IF p_key IN ('require_delivery_code','require_payment_proof') AND p_value > 1 THEN PERFORM _err('invalid_input', 'Valeur invalide : 0 ou 1'); END IF;
  SELECT value INTO v_old FROM settings WHERE key = p_key FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Réglage inconnu'); END IF;
  UPDATE settings SET value = p_value WHERE key = p_key;
  PERFORM _audit(p_actor, 'setting_changed', 'setting', p_key, jsonb_build_object('from', v_old, 'to', p_value));
END $$;

-- Confirmation de l'appel : le code n'est envoyé au client que s'il est exigé
CREATE OR REPLACE FUNCTION fn_agent_log_call(p_actor uuid, p_order uuid, p_result call_result, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE u users; o orders; v_code text; v_limit int;
BEGIN
  u := _require(p_actor, ARRAY['agent','call_chief']::user_role[]);
  SELECT * INTO o FROM orders WHERE id = p_order FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Commande introuvable'); END IF;
  IF o.status <> 'in_call' OR o.locked_by IS DISTINCT FROM p_actor THEN
    PERFORM _err('not_your_order', 'Vous devez d''abord prendre cette commande');
  END IF;
  INSERT INTO calls(order_id, agent_id, agent_name, call_center, result, note)
  VALUES (o.id, u.id, u.full_name, COALESCE(u.team, '-'), p_result, NULLIF(trim(p_note), ''));

  IF p_result = 'confirmed' THEN
    UPDATE orders SET status = 'confirmed', confirmed_by = p_actor, confirmed_at = now(), locked_by = NULL WHERE id = o.id;
    PERFORM _log_status(o.id, 'in_call', 'confirmed', p_actor, 'Confirmée par ' || u.full_name);
    PERFORM _wallet_add(p_actor, 'team_pay', o.agent_pay, o.id, now(), 'Commande ' || o.ref || ' confirmée');
    PERFORM _wallet_add(_platform(), 'team_pay', -o.agent_pay, o.id, now(), 'Agent ' || u.full_name);
    IF _setting('require_delivery_code') = 1 THEN
      SELECT code INTO v_code FROM order_secrets WHERE order_id = o.id;
      PERFORM _queue_message(o.customer_phone, 'delivery_code',
        'Wallindirain : votre commande ' || o.ref || ' est confirmée. Code de livraison : ' || v_code ||
        '. Donnez ce code au livreur uniquement à la réception de votre colis.', o.id);
    ELSE
      PERFORM _queue_message(o.customer_phone, 'order_confirmed',
        'Wallindirain : votre commande ' || o.ref || ' est confirmée. Un livreur vous contactera. Payez à la réception de votre colis.', o.id);
    END IF;
  ELSIF p_result = 'unreachable' THEN
    v_limit := _setting('call_attempt_limit')::int;
    UPDATE orders SET status = 'new', locked_by = NULL, call_attempts = call_attempts + 1,
                      escalated = (call_attempts + 1 >= v_limit)
     WHERE id = o.id;
    PERFORM _log_status(o.id, 'in_call', 'new', p_actor, 'Client injoignable');
  ELSE
    UPDATE orders SET status = 'refused', closed_at = now(), locked_by = NULL WHERE id = o.id;
    PERFORM _release_stock(o);
    DELETE FROM order_secrets WHERE order_id = o.id;
    PERFORM _risk_mark(o.customer_phone, 'Commande refusée à l''appel', o.id);
    PERFORM _log_status(o.id, 'in_call', 'refused', p_actor, 'Refusée par le client');
  END IF;
  RETURN jsonb_build_object('status', (SELECT status FROM orders WHERE id = o.id));
END $$;

-- Livraison : code exigé seulement si le réglage est à 1 ; sinon le livreur valide directement
CREATE OR REPLACE FUNCTION fn_courier_deliver(p_actor uuid, p_order uuid, p_code text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE o orders; v_max int; v_left int; v_note text;
BEGIN
  PERFORM _require(p_actor, ARRAY['courier']::user_role[]);
  SELECT * INTO o FROM orders WHERE id = p_order AND courier_id = p_actor FOR UPDATE;
  IF NOT FOUND OR o.status <> 'on_the_way' THEN
    PERFORM _err('invalid_state', 'Commande introuvable ou pas en route');
  END IF;
  IF _setting('require_delivery_code') = 1 THEN
    v_max := _setting('code_max_attempts')::int;
    IF o.code_attempts >= v_max THEN
      RETURN jsonb_build_object('ok', false, 'locked', true, 'remaining', 0);
    END IF;
    IF p_code IS NULL OR p_code !~ '^[0-9]{4}$' OR _code_hash(p_code, o.id) <> o.delivery_code_hash THEN
      UPDATE orders SET code_attempts = code_attempts + 1 WHERE id = o.id;
      v_left := v_max - (o.code_attempts + 1);
      RETURN jsonb_build_object('ok', false, 'locked', v_left <= 0, 'remaining', GREATEST(v_left, 0));
    END IF;
    v_note := 'Livrée avec code client';
  ELSE
    v_note := 'Livrée (validée par le livreur, sans code)';
  END IF;
  UPDATE orders SET status = 'delivered', delivered_at = now(), closed_at = now() WHERE id = o.id RETURNING * INTO o;
  PERFORM _consume_stock(o);
  PERFORM _settle_delivery(o);
  DELETE FROM order_secrets WHERE order_id = o.id;
  PERFORM _log_status(o.id, 'on_the_way', 'delivered', p_actor, v_note);
  RETURN jsonb_build_object('ok', true);
END $$;

-- Rejouer les droits : CREATE OR REPLACE remet les fonctions en SECURITY INVOKER
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS sig, p.proname FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.prokind = 'f' AND (p.proname LIKE '\_%' OR p.proname LIKE 'fn\_%') LOOP
    EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER SET search_path = public, pg_temp', r.sig);
    IF r.proname LIKE 'fn\_%' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO wld_app', r.sig); END IF;
  END LOOP;
END $$;
