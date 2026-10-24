-- =====================================================================
-- Migration 017 : protections (étape 0).
--  1. clé d'envoi unique contre les doubles commandes (formulaire vendeur et lien public)
--  2. import de tableur : verrou contre les envois simultanés
--  3. garde-fou : la paie du livreur ne peut pas dépasser les frais de livraison de la zone
--  4. contrôles préventifs de l'administrateur (tarif de zone, paie fixe) et plafond de la part du livreur (90 %)
--  5. deux index uniques partiels : une écriture de règlement par commande, bénéficiaire et type
-- Cette migration ne modifie AUCUNE valeur financière existante (paramètres, tarifs, écritures, commandes).
-- =====================================================================

-- ---------- 5. Doublons : on s'arrête sans rien changer s'il en existe déjà ----------
DO $$
DECLARE v_n bigint;
BEGIN
  SELECT count(*) INTO v_n FROM (
    SELECT 1 FROM wallet_entries
     WHERE order_id IS NOT NULL
       AND (kind IN ('seller_gain','supplier_payment','platform_revenue','float_release','return_fees',
                     'return_fee_supplier','prepaid_refund','transport_loss','referral_bonus')
            OR (kind = 'team_pay' AND amount > 0))
     GROUP BY order_id, user_id, kind HAVING count(*) > 1) d;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'Migration 017 arrêtée : % groupe(s) d''écritures en double détecté(s) dans wallet_entries. Lancez docs/rapport-production-017.sql, analysez, puis relancez. Aucune donnée n''a été modifiée.', v_n;
  END IF;
END $$;

CREATE UNIQUE INDEX wallet_settle_once_uq ON wallet_entries (order_id, user_id, kind)
  WHERE order_id IS NOT NULL
    AND kind IN ('seller_gain','supplier_payment','platform_revenue','float_release','return_fees',
                 'return_fee_supplier','prepaid_refund','transport_loss','referral_bonus');
-- team_pay : seul le côté bénéficiaire (montant positif) est unique ; la plateforme reçoit 2 écritures négatives légitimes (agent + livreur)
CREATE UNIQUE INDEX wallet_team_pay_once_uq ON wallet_entries (order_id, user_id, kind)
  WHERE order_id IS NOT NULL AND kind = 'team_pay' AND amount > 0;

-- ---------- 1. Clés d'envoi ----------
CREATE TABLE order_requests (
  scope       text NOT NULL,                       -- 'vendeur:<id>' ou 'lien:<code>'
  req_key     text NOT NULL CHECK (req_key ~ '^[A-Za-z0-9-]{16,64}$'),
  order_id    uuid NOT NULL REFERENCES orders(id),
  fingerprint text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, req_key)
);

CREATE FUNCTION _request_key_ok(p_key text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9-]{16,64}$' THEN
    PERFORM _err('key_required', 'Rechargez la page puis réessayez : la demande n''a pas pu être identifiée');
  END IF;
END $$;

-- Formulaire vendeur : même clé + même contenu = même commande, rien n'est recréé ; même clé + autre contenu = refus
CREATE FUNCTION fn_seller_create_order_once(p_actor uuid, p_key text, p_product uuid, p_own_name text, p_unit_price bigint, p_qty int,
                                            p_cname text, p_cphone text, p_commune text, p_address text, p_note text,
                                            p_preconfirmed boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_scope text; v_fp text; r order_requests; o orders; v_res jsonb;
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  PERFORM _request_key_ok(p_key);
  v_scope := 'vendeur:' || p_actor::text;
  v_fp := md5(jsonb_build_array(p_product, lower(trim(COALESCE(p_own_name, ''))), p_unit_price, p_qty, trim(COALESCE(p_cname, '')), p_cphone,
                                trim(COALESCE(p_commune, '')), trim(COALESCE(p_address, '')), trim(COALESCE(p_note, '')), COALESCE(p_preconfirmed, false))::text);
  PERFORM pg_advisory_xact_lock(hashtextextended(v_scope || '|' || p_key, 17));
  SELECT * INTO r FROM order_requests WHERE scope = v_scope AND req_key = p_key;
  IF FOUND THEN
    IF r.fingerprint <> v_fp THEN PERFORM _err('key_reused', 'Cette demande a déjà été utilisée avec un contenu différent : rechargez la page'); END IF;
    SELECT * INTO o FROM orders WHERE id = r.order_id;
    RETURN jsonb_build_object('id', o.id, 'ref', o.ref, 'formula', o.formula, 'sale_total', o.sale_total, 'risk', o.risk_flag, 'status', o.status, 'replayed', true);
  END IF;
  v_res := fn_seller_create_order(p_actor, p_product, p_own_name, p_unit_price, p_qty, p_cname, p_cphone, p_commune, p_address, p_note, p_preconfirmed);
  INSERT INTO order_requests(scope, req_key, order_id, fingerprint) VALUES (v_scope, p_key, (v_res->>'id')::uuid, v_fp);
  RETURN v_res || jsonb_build_object('replayed', false);
END $$;

-- Lien public : le jeton de suivi n'est rendu qu'à celui qui rejoue exactement la même demande
CREATE FUNCTION fn_public_order_once(p_link text, p_key text, p_qty int, p_cname text, p_cphone text, p_commune text, p_address text, p_version text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_scope text; v_fp text; r order_requests; o orders; v_res jsonb; v_oid uuid;
BEGIN
  PERFORM _request_key_ok(p_key);
  IF NOT EXISTS (SELECT 1 FROM seller_links WHERE code = p_link) THEN PERFORM _err('not_found', 'Lien invalide'); END IF;
  v_scope := 'lien:' || p_link;
  v_fp := md5(jsonb_build_array(p_qty, trim(COALESCE(p_cname, '')), p_cphone, trim(COALESCE(p_commune, '')), trim(COALESCE(p_address, '')))::text);
  PERFORM pg_advisory_xact_lock(hashtextextended(v_scope || '|' || p_key, 17));
  SELECT * INTO r FROM order_requests WHERE scope = v_scope AND req_key = p_key;
  IF FOUND THEN
    IF r.fingerprint <> v_fp THEN PERFORM _err('key_reused', 'Cette demande a déjà été utilisée avec un contenu différent : rechargez la page'); END IF;
    SELECT * INTO o FROM orders WHERE id = r.order_id;
    RETURN jsonb_build_object('ref', o.ref, 'sale_total', o.sale_total, 'track_token', o.track_token, 'replayed', true);
  END IF;
  -- Consentement enregistré ici, dans la même transaction que la commande, et seulement à la première création :
  -- un rejeu n'en ajoute pas, un refus (garde-fou, stock…) n'en laisse pas. Les consentements existants ne sont jamais touchés.
  PERFORM fn_record_consent('order', NULL, p_cphone, p_version);
  v_res := fn_public_order(p_link, p_qty, p_cname, p_cphone, p_commune, p_address);
  SELECT id INTO v_oid FROM orders WHERE ref = v_res->>'ref';
  INSERT INTO order_requests(scope, req_key, order_id, fingerprint) VALUES (v_scope, p_key, v_oid, v_fp);
  RETURN v_res || jsonb_build_object('replayed', false);
END $$;

-- ---------- 2. Import de tableur : verrou sur (vendeur, empreinte), le reste est identique ----------
CREATE OR REPLACE FUNCTION fn_seller_import_order(p_actor uuid, p_hash text, p_product uuid, p_own_name text, p_unit_price bigint, p_qty int,
                                       p_cname text, p_cphone text, p_commune text, p_address text, p_note text, p_preconfirmed boolean)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  IF p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' THEN PERFORM _err('invalid_input', 'Ligne invalide'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('import:' || p_actor::text || ':' || p_hash, 17));
  IF EXISTS (SELECT 1 FROM sheet_imports WHERE seller_id = p_actor AND row_hash = p_hash) THEN
    RETURN jsonb_build_object('duplicate', true);
  END IF;
  r := fn_seller_create_order(p_actor, p_product, p_own_name, p_unit_price, p_qty, p_cname, p_cphone, p_commune, p_address, p_note, p_preconfirmed);
  INSERT INTO sheet_imports(seller_id, row_hash, order_id) VALUES (p_actor, p_hash, (r->>'id')::uuid);
  RETURN r;
END $$;

-- La remise à zéro vide aussi les clés d'envoi (elles référencent les commandes)
CREATE OR REPLACE FUNCTION fn_admin_reset_activity(p_actor uuid, p_confirm text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_orders bigint; v_entries bigint;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_confirm IS DISTINCT FROM 'REINITIALISER' THEN PERFORM _err('invalid_input', 'Tapez REINITIALISER pour confirmer'); END IF;
  SELECT count(*) INTO v_orders FROM orders;
  SELECT count(*) INTO v_entries FROM wallet_entries;
  TRUNCATE TABLE order_payments, cash_counts, courier_cash_entries, remittances, withdrawals, wallet_entries, order_secrets,
                 order_history, calls, risky_customers, sheet_imports, order_requests, orders, arrivals, seller_stock, messages, one_time_codes, proofs
    RESTART IDENTITY;
  UPDATE products SET stock_qty = 0, reserved_qty = 0;
  PERFORM _audit(p_actor, 'activity_reset', 'system', NULL, jsonb_build_object('orders', v_orders, 'wallet_entries', v_entries));
  RETURN jsonb_build_object('orders', v_orders, 'wallet_entries', v_entries);
END $$;

-- ---------- 3. Garde-fou à la création de commande (les trois parcours passent par INSERT INTO orders) ----------
CREATE FUNCTION _orders_courier_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.courier_pay > NEW.delivery_fee THEN
    PERFORM _err('courier_pay_exceeds_fee', 'Livraison indisponible vers cette zone pour le moment : le tarif de la zone est en cours de révision par Wallindirain. Choisissez une autre zone ou réessayez plus tard.');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_courier_guard BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION _orders_courier_guard();

-- ---------- 4. Contrôles préventifs de l'administrateur ----------
-- Zone : une zone active ne peut pas avoir un tarif nul (déjà le cas) ni inférieur à la paie fixe du livreur (si la part en % est à 0)
CREATE OR REPLACE FUNCTION fn_admin_set_delivery_rate(p_actor uuid, p_commune text, p_fee bigint, p_active boolean DEFAULT true) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_old bigint;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_fee IS NULL OR p_fee < 0 OR p_fee > 1000000 THEN PERFORM _err('invalid_input', 'Tarif invalide'); END IF;
  IF p_commune IS NULL OR length(trim(p_commune)) < 2 OR length(p_commune) > 60 THEN PERFORM _err('invalid_input', 'Nom de zone invalide'); END IF;
  IF COALESCE(p_active, true) AND p_fee = 0 THEN PERFORM _err('invalid_input', 'Indiquez un tarif avant d''activer la zone'); END IF;
  IF COALESCE(p_active, true) AND _setting('courier_share_bps') = 0 AND p_fee < _setting('courier_pay') THEN
    PERFORM _err('zone_fee_below_courier_pay', 'Tarif refusé : ' || p_fee || ' GNF est inférieur à la rémunération fixe du livreur (' || _setting('courier_pay') || ' GNF). Augmentez le tarif de la zone, ou passez la rémunération du livreur en pourcentage.');
  END IF;
  SELECT fee INTO v_old FROM delivery_rates WHERE commune = trim(p_commune);
  INSERT INTO delivery_rates(commune, fee, active) VALUES (trim(p_commune), p_fee, COALESCE(p_active, true))
  ON CONFLICT (commune) DO UPDATE SET fee = EXCLUDED.fee, active = EXCLUDED.active;
  IF NOT EXISTS (SELECT 1 FROM delivery_rates WHERE active) THEN PERFORM _err('invalid_input', 'Gardez au moins une zone active'); END IF;
  PERFORM _audit(p_actor, 'delivery_rate_changed', 'zone', trim(p_commune),
                 jsonb_build_object('from', v_old, 'to', p_fee, 'active', COALESCE(p_active, true)));
END $$;

-- Réglages : plafond de 90 % pour la part du livreur ; paie fixe et retour au mode fixe contrôlés par rapport aux zones actives
CREATE OR REPLACE FUNCTION fn_admin_set_setting(p_actor uuid, p_key text, p_value bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_old bigint; v_min_fee bigint;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_value IS NULL OR p_value < 0 THEN PERFORM _err('invalid_input', 'Valeur invalide'); END IF;
  IF p_key IN ('margin_bps','fee_order_bps','courier_share_bps') AND p_value > 10000 THEN PERFORM _err('invalid_input', 'Pourcentage invalide (10000 = 100 %)'); END IF;
  IF p_key = 'courier_share_bps' AND p_value > 9000 THEN PERFORM _err('invalid_input', 'La part du livreur est limitée à 90 % (9000) : Wallindirain garde toujours une part des frais de livraison'); END IF;
  IF p_key IN ('code_max_attempts','call_attempt_limit') AND p_value < 1 THEN PERFORM _err('invalid_input', 'Valeur invalide'); END IF;
  IF p_key IN ('require_delivery_code','require_payment_proof','subscription_required','kyc_images_required') AND p_value > 1 THEN PERFORM _err('invalid_input', 'Valeur invalide : 0 ou 1'); END IF;
  SELECT min(fee) INTO v_min_fee FROM delivery_rates WHERE active;
  IF p_key = 'courier_pay' AND _setting('courier_share_bps') = 0 AND v_min_fee IS NOT NULL AND p_value > v_min_fee THEN
    PERFORM _err('courier_pay_exceeds_fee', 'Rémunération refusée : ' || p_value || ' GNF dépasse le tarif de la zone active la moins chère (' || v_min_fee || ' GNF)');
  END IF;
  IF p_key = 'courier_share_bps' AND p_value = 0 AND v_min_fee IS NOT NULL AND _setting('courier_pay') > v_min_fee THEN
    PERFORM _err('courier_pay_exceeds_fee', 'Retour au montant fixe refusé : la rémunération fixe (' || _setting('courier_pay') || ' GNF) dépasse le tarif de la zone active la moins chère (' || v_min_fee || ' GNF)');
  END IF;
  SELECT value INTO v_old FROM settings WHERE key = p_key FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Réglage inconnu'); END IF;
  UPDATE settings SET value = p_value WHERE key = p_key;
  PERFORM _audit(p_actor, 'setting_changed', 'setting', p_key, jsonb_build_object('from', v_old, 'to', p_value));
END $$;

-- Étiquette (texte seulement, aucune valeur) : rappel du plafond
UPDATE settings SET label = label || ' — maximum 9000 (90 %)' WHERE key = 'courier_share_bps' AND label NOT LIKE '%maximum 9000%';

-- ---------- Contrôle comptable : deux vérifications de plus ----------
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
  RETURN QUERY
  SELECT 'paie du livreur supérieure aux frais de livraison'::text, o.ref FROM orders o WHERE o.courier_pay > o.delivery_fee;
  RETURN QUERY
  SELECT 'écritures de règlement en double'::text, w.order_id::text || '/' || w.kind FROM wallet_entries w
   WHERE w.order_id IS NOT NULL
     AND (w.kind IN ('seller_gain','supplier_payment','platform_revenue','float_release','return_fees',
                     'return_fee_supplier','prepaid_refund','transport_loss','referral_bonus')
          OR (w.kind = 'team_pay' AND w.amount > 0))
   GROUP BY w.order_id, w.user_id, w.kind HAVING count(*) > 1;
END $$;


-- ---------- Journal des refus du garde-fou ----------
-- Le refus annule la transaction : il ne peut pas s'écrire lui-même. L'application appelle donc cette fonction APRÈS le refus,
-- dans une transaction séparée. Rien de financier n'est écrit ni lu : ni paie du livreur, ni montant du client.
CREATE FUNCTION fn_audit_guard_refusal(p_actor uuid, p_source text, p_commune text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_zone text; v_actor uuid;
BEGIN
  IF p_source IS NULL OR p_source NOT IN ('vendeur','lien','import') THEN RETURN; END IF;
  SELECT commune INTO v_zone FROM delivery_rates WHERE commune = trim(COALESCE(p_commune, ''));
  IF v_zone IS NULL THEN RETURN; END IF;                                  -- zone inconnue : on n'écrit rien (pas de texte libre dans le journal)
  SELECT id INTO v_actor FROM users WHERE id = p_actor AND role = 'seller';
  IF EXISTS (SELECT 1 FROM audit_log WHERE action = 'order_refused_pay_guard' AND entity_id = v_zone
             AND actor_id IS NOT DISTINCT FROM v_actor AND details->>'source' = p_source AND at > now() - interval '60 seconds') THEN RETURN; END IF;
  PERFORM _audit(v_actor, 'order_refused_pay_guard', 'delivery_rate', v_zone,
                 jsonb_build_object('source', p_source, 'raison', 'tarif de la zone insuffisant pour la paie du livreur'));
END $$;

-- ---------- Droits (même boucle que les migrations précédentes) ----------
-- order_requests est exclue : l'application ne la lit ni ne l'écrit, seules les fonctions de la base y accèdent.
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
       AND NOT (r.relname IN ('proofs','avatars') AND column_name = 'data')
       AND NOT (r.relname = 'identity_documents' AND column_name IN ('front','back','selfie'));
    EXECUTE format('GRANT SELECT (%s) ON %I TO wld_app', v_cols, r.relname);
  END LOOP;
END $$;
