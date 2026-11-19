-- 071 : livraison à la demande, étapes 3 et 4 : désignation d'un livreur, ramassage, livraison sans code (le livreur valide seul), encaissement et reversement.
-- Rien n'est supprimé. Les commandes de vendeurs ne sont pas touchées : seules deux fonctions existantes reçoivent une petite extension
-- (reversement des espèces et réinitialisation de l'activité, pour qu'elles connaissent aussi les courses à la demande).
-- Règles d'argent (voir docs/PROCEDURE-071.md) :
--   livrée : le livreur touche sa part (dlv_courier_share, 70 % par défaut) ; la plateforme enregistre le prix de la course ; l'espèce encaissée est à reverser comme pour une commande.
--   échec : le livreur touche dlv_failed_pay_pct % de sa part (50 % par défaut) ; le prix de la course reste acquis si l'expéditeur l'avait déjà payé au ramassage.
INSERT INTO settings(key, value, label) VALUES
  ('dlv_courier_share', 70, 'Livraison à la demande : part du prix de la course versée au livreur (en %)'),
  ('dlv_failed_pay_pct', 50, 'Livraison à la demande : part de sa paie versée au livreur en cas d''échec (en %)')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE dlv_requests
  ADD COLUMN courier_id uuid REFERENCES users(id),
  ADD COLUMN assigned_at timestamptz,
  ADD COLUMN picked_up_at timestamptz,
  ADD COLUMN delivered_at timestamptz,
  ADD COLUMN failed_at timestamptz,
  ADD COLUMN fail_reason text CHECK (fail_reason IS NULL OR length(fail_reason) <= 200),
  ADD COLUMN cash_collected boolean NOT NULL DEFAULT false,
  ADD COLUMN courier_pay bigint NOT NULL DEFAULT 0 CHECK (courier_pay >= 0);
CREATE INDEX dlv_requests_courier ON dlv_requests(courier_id, status) WHERE courier_id IS NOT NULL;

-- Les espèces d'une course à la demande suivent le même circuit que celles d'une commande (comptage, reversement, validation).
ALTER TABLE courier_cash_entries ALTER COLUMN order_id DROP NOT NULL;
ALTER TABLE courier_cash_entries ADD COLUMN dlv_request_id uuid UNIQUE REFERENCES dlv_requests(id);
ALTER TABLE courier_cash_entries ADD CONSTRAINT courier_cash_one_source CHECK ((order_id IS NULL) <> (dlv_request_id IS NULL));

-- Le reversement et la réinitialisation connaissent les courses à la demande.
DO $$
DECLARE d text; n text;
BEGIN
  d := pg_get_functiondef('fn_courier_remit(uuid,text,uuid,text,uuid[],text)'::regprocedure);
  n := replace(d, 'order_id = ANY (p_orders)', '(order_id = ANY (p_orders) OR dlv_request_id = ANY (p_orders))');
  IF n = d THEN RAISE EXCEPTION 'fn_courier_remit : texte inattendu'; END IF;
  EXECUTE n;
  d := pg_get_functiondef('fn_admin_reset_activity(uuid,text)'::regprocedure);
  n := replace(d, 'TRUNCATE TABLE order_payments,', 'TRUNCATE TABLE dlv_requests, order_payments,');
  IF n = d THEN RAISE EXCEPTION 'fn_admin_reset_activity : texte inattendu'; END IF;
  EXECUTE n;
END $$;

-- Comptabilité d'une course terminée (appelée une seule fois, sous verrou de la ligne).
CREATE FUNCTION _dlv_pay(p_price bigint) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT LEAST(p_price, GREATEST(0, (p_price * LEAST(100, GREATEST(0, _setting('dlv_courier_share'))) / 100)))
$$;

CREATE FUNCTION _dlv_collect_cash(r dlv_requests) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF r.price > 0 THEN INSERT INTO courier_cash_entries(courier_id, dlv_request_id, amount) VALUES (r.courier_id, r.id, r.price) ON CONFLICT DO NOTHING; END IF;
END $$;

CREATE FUNCTION _dlv_settle_delivered(r dlv_requests) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_pay bigint := _dlv_pay(r.price);
BEGIN
  PERFORM _wallet_add(_platform(), 'platform_revenue', r.price, NULL, now(), 'Course à la demande ' || r.ref);
  PERFORM _wallet_add(r.courier_id, 'team_pay', v_pay, NULL, now(), 'Course ' || r.ref);
  PERFORM _wallet_add(_platform(), 'team_pay', -v_pay, NULL, now(), 'Livreur course ' || r.ref);
  RETURN v_pay;
END $$;

CREATE FUNCTION _dlv_settle_failed(r dlv_requests) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_pay bigint := (_dlv_pay(r.price) * LEAST(100, GREATEST(0, _setting('dlv_failed_pay_pct'))) / 100);
BEGIN
  IF r.cash_collected THEN PERFORM _wallet_add(_platform(), 'platform_revenue', r.price, NULL, now(), 'Course à la demande échouée (payée au ramassage) ' || r.ref); END IF;
  PERFORM _wallet_add(r.courier_id, 'team_pay', v_pay, NULL, now(), 'Course ' || r.ref || ' échouée');
  PERFORM _wallet_add(_platform(), 'team_pay', -v_pay, NULL, now(), 'Livreur course échouée ' || r.ref);
  RETURN v_pay;
END $$;

-- ---------- Administration : désigner / retirer le livreur ----------
CREATE FUNCTION fn_admin_dlv_assign(p_actor uuid, p_id uuid, p_courier uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r dlv_requests; c users;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  SELECT * INTO r FROM dlv_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Demande introuvable'); END IF;
  IF r.status NOT IN ('new', 'assigned') THEN PERFORM _err('invalid_state', 'Cette course est déjà en cours ou terminée'); END IF;
  PERFORM _courier_exists(p_courier);
  SELECT * INTO c FROM users WHERE id = p_courier;
  IF c.status <> 'active' THEN PERFORM _err('invalid_state', 'Ce livreur n''est pas actif'); END IF;
  IF NOT _courier_vehicle_ok(p_courier) THEN PERFORM _err('vehicle_unverified', 'La plaque et la carte grise de ce livreur ne sont pas encore vérifiées'); END IF;
  UPDATE dlv_requests SET courier_id = p_courier, status = 'assigned', assigned_at = now(), updated_at = now() WHERE id = p_id;
  PERFORM _audit(p_actor, 'dlv_assigned', 'dlv_request', p_id::text, jsonb_build_object('ref', r.ref, 'courier', p_courier));
  PERFORM _notify_once(p_courier, 'dlv-assign-' || p_id || '-' || extract(epoch FROM now())::bigint, 'dlv', 'Nouvelle course à la demande', r.from_place || ' → ' || r.to_place || ' (' || r.ref || ')', 'ondemand');
  PERFORM _notify_once(r.shipper_id, 'dlv-assigned-' || p_id || '-' || extract(epoch FROM now())::bigint, 'dlv', 'Un livreur est désigné', 'Votre course ' || r.ref || ' sera récupérée par ' || split_part(c.full_name, ' ', 1) || '.', 'mine');
END $$;

CREATE FUNCTION fn_admin_dlv_unassign(p_actor uuid, p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r dlv_requests;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  SELECT * INTO r FROM dlv_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Demande introuvable'); END IF;
  IF r.status <> 'assigned' THEN PERFORM _err('invalid_state', 'Le livreur ne peut être retiré qu''avant le ramassage'); END IF;
  UPDATE dlv_requests SET courier_id = NULL, status = 'new', assigned_at = NULL, updated_at = now() WHERE id = p_id;
  PERFORM _audit(p_actor, 'dlv_unassigned', 'dlv_request', p_id::text, jsonb_build_object('ref', r.ref, 'courier', r.courier_id));
END $$;

-- ---------- Livreur ----------
CREATE FUNCTION fn_courier_dlv_list(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['courier']::user_role[]);
  RETURN COALESCE((SELECT jsonb_agg(x ORDER BY (x->>'sort') DESC) FROM (
    SELECT jsonb_build_object('id', r.id, 'ref', r.ref, 'status', r.status, 'from', r.from_place, 'from_address', r.from_address, 'to', r.to_place, 'to_address', r.to_address,
             'receiver_name', r.receiver_name, 'receiver_phone', r.receiver_phone, 'shipper', split_part(u.full_name, ' ', 1), 'shipper_phone', u.phone, 'description', r.description,
             'weight_kg', r.weight_kg, 'weight_class', r.weight_class, 'price', r.price, 'payer', r.payer, 'cash_collected', r.cash_collected,
             'to_collect', CASE WHEN r.status IN ('assigned', 'picked_up') AND NOT r.cash_collected THEN r.price ELSE 0 END,
             'fail_reason', r.fail_reason, 'courier_pay', r.courier_pay,
             'sort', to_char(COALESCE(r.delivered_at, r.failed_at, r.picked_up_at, r.assigned_at), 'YYYYMMDDHH24MISS')) AS x
      FROM dlv_requests r JOIN users u ON u.id = r.shipper_id
     WHERE r.courier_id = p_actor AND (r.status IN ('assigned', 'picked_up') OR COALESCE(r.delivered_at, r.failed_at) > now() - interval '3 days')) s), '[]'::jsonb);
END $$;

CREATE FUNCTION fn_courier_dlv_pickup(p_actor uuid, p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r dlv_requests; v_shipper text;
BEGIN
  PERFORM _require(p_actor, ARRAY['courier']::user_role[]);
  SELECT * INTO r FROM dlv_requests WHERE id = p_id AND courier_id = p_actor FOR UPDATE;
  IF NOT FOUND OR r.status <> 'assigned' THEN PERFORM _err('invalid_state', 'Course introuvable ou déjà récupérée'); END IF;
  UPDATE dlv_requests SET status = 'picked_up', picked_up_at = now(), updated_at = now(),
         cash_collected = (r.payer = 'sender') WHERE id = r.id RETURNING * INTO r;
  IF r.payer = 'sender' THEN PERFORM _dlv_collect_cash(r); END IF;   -- l'expéditeur paie au ramassage : l'espèce est déjà dans la main du livreur
  SELECT split_part(full_name, ' ', 1) INTO v_shipper FROM users WHERE id = r.shipper_id;
  PERFORM _queue_message(r.receiver_phone, 'order_confirmed', 'Wallindirain : un colis de ' || v_shipper || ' est en route vers vous (' || r.ref || ').' ||
    CASE WHEN r.payer = 'receiver' THEN ' Course à payer au livreur : ' || r.price || ' GNF.' ELSE '' END);
  PERFORM _audit(p_actor, 'dlv_picked_up', 'dlv_request', r.id::text, jsonb_build_object('ref', r.ref));
  PERFORM _notify_once(r.shipper_id, 'dlv-pick-' || r.id, 'dlv', 'Colis récupéré', 'Votre colis ' || r.ref || ' est en route.', 'mine');
END $$;

CREATE FUNCTION fn_courier_dlv_deliver(p_actor uuid, p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r dlv_requests; v_pay bigint;
BEGIN
  PERFORM _require(p_actor, ARRAY['courier']::user_role[]);
  SELECT * INTO r FROM dlv_requests WHERE id = p_id AND courier_id = p_actor FOR UPDATE;
  IF NOT FOUND OR r.status <> 'picked_up' THEN PERFORM _err('invalid_state', 'Course introuvable ou pas en route'); END IF;
  UPDATE dlv_requests SET status = 'delivered', delivered_at = now(), updated_at = now() WHERE id = r.id RETURNING * INTO r;
  IF NOT r.cash_collected THEN   -- le destinataire paie à la réception
    UPDATE dlv_requests SET cash_collected = true WHERE id = r.id RETURNING * INTO r;
    PERFORM _dlv_collect_cash(r);
  END IF;
  v_pay := _dlv_settle_delivered(r);
  UPDATE dlv_requests SET courier_pay = v_pay WHERE id = r.id;
  PERFORM _audit(p_actor, 'dlv_delivered', 'dlv_request', r.id::text, jsonb_build_object('ref', r.ref, 'price', r.price, 'courier_pay', v_pay));
  PERFORM _notify_once(r.shipper_id, 'dlv-done-' || r.id, 'dlv', 'Colis livré', 'Votre colis ' || r.ref || ' a été livré à ' || r.receiver_name || '.', 'mine');
END $$;

CREATE FUNCTION fn_courier_dlv_fail(p_actor uuid, p_id uuid, p_reason text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r dlv_requests; v_pay bigint; v_reason text := btrim(COALESCE(p_reason, ''));
BEGIN
  PERFORM _require(p_actor, ARRAY['courier']::user_role[]);
  IF length(v_reason) < 3 OR length(v_reason) > 200 THEN PERFORM _err('invalid_input', 'Indiquez la raison de l''échec (3 à 200 caractères)'); END IF;
  SELECT * INTO r FROM dlv_requests WHERE id = p_id AND courier_id = p_actor FOR UPDATE;
  IF NOT FOUND OR r.status <> 'picked_up' THEN PERFORM _err('invalid_state', 'Seule une course en route peut échouer'); END IF;
  UPDATE dlv_requests SET status = 'failed', failed_at = now(), fail_reason = v_reason, updated_at = now() WHERE id = r.id RETURNING * INTO r;
  v_pay := _dlv_settle_failed(r);
  UPDATE dlv_requests SET courier_pay = v_pay WHERE id = r.id;
  PERFORM _audit(p_actor, 'dlv_failed', 'dlv_request', r.id::text, jsonb_build_object('ref', r.ref, 'reason', v_reason, 'courier_pay', v_pay));
  PERFORM _notify_once(r.shipper_id, 'dlv-fail-' || r.id, 'dlv', 'Livraison non réalisée', 'Votre colis ' || r.ref || ' n''a pas pu être livré : ' || v_reason || '. Contactez-nous.', 'mine');
END $$;

-- ---------- Listes : l'expéditeur et l'administration voient le livreur et les dates ----------
CREATE OR REPLACE FUNCTION fn_dlv_my_requests(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['shipper']::user_role[]);
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'ref', r.ref, 'from', r.from_place, 'to', r.to_place, 'to_address', r.to_address, 'receiver_name', r.receiver_name,
           'description', r.description, 'weight_kg', r.weight_kg, 'weight_class', r.weight_class, 'price', r.price, 'payer', r.payer, 'status', r.status, 'created_at', r.created_at,
           'courier', split_part(c.full_name, ' ', 1), 'picked_up_at', r.picked_up_at, 'delivered_at', r.delivered_at, 'fail_reason', r.fail_reason) ORDER BY r.created_at DESC)
      FROM (SELECT * FROM dlv_requests WHERE shipper_id = p_actor ORDER BY created_at DESC LIMIT 100) r LEFT JOIN users c ON c.id = r.courier_id), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION fn_admin_dlv_requests(p_actor uuid, p_status text) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  RETURN COALESCE((SELECT jsonb_agg(x ORDER BY (x->>'created_at') DESC) FROM (
    SELECT jsonb_build_object('id', r.id, 'ref', r.ref, 'shipper', u.full_name, 'shipper_phone', u.phone, 'from', r.from_place, 'from_address', r.from_address, 'to', r.to_place, 'to_address', r.to_address,
           'receiver_name', r.receiver_name, 'receiver_phone', r.receiver_phone, 'description', r.description, 'weight_kg', r.weight_kg, 'weight_class', r.weight_class, 'price', r.price,
           'declared_value', r.declared_value, 'payer', r.payer, 'status', r.status, 'created_at', r.created_at,
           'courier_id', r.courier_id, 'courier', c.full_name, 'courier_pay', r.courier_pay, 'fail_reason', r.fail_reason) AS x
      FROM dlv_requests r JOIN users u ON u.id = r.shipper_id LEFT JOIN users c ON c.id = r.courier_id
     WHERE p_status IS NULL OR r.status = p_status ORDER BY r.created_at DESC LIMIT 200) s), '[]'::jsonb);
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
       AND NOT (r.relname IN ('proofs','avatars','product_images','return_photos','invoices') AND column_name = 'data')
       AND NOT (r.relname = 'identity_documents' AND column_name IN ('front','back','selfie'))
       AND NOT (r.relname = 'courier_vehicles' AND column_name IN ('plate_img','card_img'));
    EXECUTE format('GRANT SELECT (%s) ON %I TO wld_app', v_cols, r.relname);
  END LOOP;
END $$;

GRANT SELECT ON pf_all_tx TO wld_app;
