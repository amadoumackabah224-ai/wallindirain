-- 028 : alertes automatiques dans la cloche (notifications de la 027).
--   - stock bas / rupture (fournisseur) ; - colis affecté non récupéré (livreur + chefs d'équipe) ;
--   - argent encaissé à reverser (livreur) ; - rappel du numéro de versement manquant (toute personne qui touche de l'argent).
-- AUCUN calcul d'argent n'est touché : la fonction ne fait que LIRE l'état et écrire des notifications. Chaque alerte est envoyée UNE fois par « période »
-- (clé anti-doublon par personne), donc relancer la fonction ne crée jamais de doublon. Appelée toutes les 15 minutes par le serveur.
INSERT INTO settings(key, value, label) VALUES
  ('alert_low_stock_qty', 5, 'Alerte stock bas (fournisseur) : à partir de ce nombre d''unités vendables (0 = désactivé)'),
  ('alert_cash_hours', 24, 'Alerte argent à reverser (livreur) : après ce nombre d''heures sans reversement (0 = désactivé)'),
  ('alert_payout_days', 2, 'Rappel du numéro de versement manquant : après ce nombre de jours depuis l''inscription (0 = désactivé)')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE notifications ADD COLUMN dedupe_key text;
CREATE UNIQUE INDEX notifications_dedupe_uq ON notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- Une seule notification par personne et par clé ; renvoie vrai si elle a été créée
CREATE FUNCTION _notify_once(p_user uuid, p_key text, p_kind text, p_title text, p_body text, p_link text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_n int;
BEGIN
  INSERT INTO notifications(user_id, kind, title, body, link, dedupe_key) VALUES (p_user, p_kind, p_title, p_body, p_link, p_key) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END $$;

CREATE FUNCTION fn_run_alerts() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  r record; v_n_stock int := 0; v_n_pickup int := 0; v_n_cash int := 0; v_n_payout int := 0;
  v_stock bigint := _setting('alert_low_stock_qty'); v_cash bigint := _setting('alert_cash_hours'); v_days bigint := _setting('alert_payout_days');
  v_pickup bigint := _setting('pickup_alert_hours');
  v_week text := to_char(now(), 'IYYY-"S"IW'); v_day text := to_char(now(), 'YYYY-MM-DD');
BEGIN
  IF NOT pg_try_advisory_xact_lock(70028) THEN RETURN jsonb_build_object('skipped', true); END IF;

  -- 1. Stock bas ou rupture : une fois par semaine et par état (un passage de « bas » à « rupture » prévient de nouveau)
  IF v_stock > 0 THEN
    FOR r IN SELECT p.id, p.name, p.supplier_id, (p.stock_qty - p.reserved_qty) AS free
               FROM products p JOIN users u ON u.id = p.supplier_id AND u.status = 'active' AND u.deleted_at IS NULL
              WHERE p.status = 'approved' AND p.deleted_at IS NULL AND p.storage = 'wallindirain'
                AND (p.stock_qty - p.reserved_qty) <= v_stock
                AND EXISTS (SELECT 1 FROM arrivals a WHERE a.product_id = p.id AND a.counted_qty IS NOT NULL)
    LOOP
      IF _notify_once(r.supplier_id, 'stock:' || r.id || ':' || (CASE WHEN r.free <= 0 THEN 'out' ELSE 'low' END) || ':' || v_week, 'product',
           CASE WHEN r.free <= 0 THEN 'Rupture de stock' ELSE 'Stock bas' END,
           '« ' || left(r.name, 60) || ' » : ' || CASE WHEN r.free <= 0 THEN 'plus aucune unité vendable.' ELSE 'il reste ' || r.free || ' unité(s) vendable(s).' END || ' Annoncez un nouvel arrivage.', 'products')
      THEN v_n_stock := v_n_stock + 1; END IF;
    END LOOP;
  END IF;

  -- 2. Colis affecté mais non récupéré : une fois par affectation, pour le livreur et pour les chefs d'équipe
  IF v_pickup > 0 THEN
    FOR r IN SELECT o.id, o.ref, o.courier_id, split_part(c.full_name, ' ', 1) AS courier_name, s.since
               FROM orders o JOIN users c ON c.id = o.courier_id AND c.status = 'active' AND c.deleted_at IS NULL,
                    LATERAL (SELECT max(h.at) AS since FROM order_history h WHERE h.order_id = o.id AND h.to_status = 'assigned') s
              WHERE o.status = 'assigned' AND s.since < now() - make_interval(hours => v_pickup::int)
    LOOP
      IF _notify_once(r.courier_id, 'pickup:' || r.id || ':' || extract(epoch FROM r.since)::bigint, 'order', 'Colis à récupérer',
           'La commande ' || r.ref || ' vous est affectée depuis plus de ' || v_pickup || ' h : récupérez-la ou prévenez le chef.', 'orders')
      THEN v_n_pickup := v_n_pickup + 1; END IF;
      PERFORM _notify_once(ch.id, 'pickup:' || r.id || ':' || extract(epoch FROM r.since)::bigint, 'order', 'Colis non récupéré',
           'La commande ' || r.ref || ' affectée à ' || r.courier_name || ' n''est pas récupérée depuis plus de ' || v_pickup || ' h.', 'assign')
        FROM users ch WHERE ch.role = 'call_chief' AND ch.status = 'active' AND ch.deleted_at IS NULL;
    END LOOP;
  END IF;

  -- 3. Argent encaissé à reverser : un rappel par jour tant que rien n'est reversé (hors reversement déjà envoyé en attente de contrôle)
  IF v_cash > 0 THEN
    FOR r IN SELECT e.courier_id, sum(e.amount)::bigint AS total
               FROM courier_cash_entries e JOIN users u ON u.id = e.courier_id AND u.status = 'active' AND u.deleted_at IS NULL
              WHERE e.count_id IS NULL AND e.remittance_id IS NULL AND e.created_at < now() - make_interval(hours => v_cash::int)
              GROUP BY e.courier_id
    LOOP
      IF _notify_once(r.courier_id, 'cash:' || v_day, 'money', 'Argent à reverser',
           'Vous détenez ' || _gnf_text(r.total) || ' encaissés depuis plus de ' || v_cash || ' h. Reversez-les (onglet Caisse).', 'cash')
      THEN v_n_cash := v_n_cash + 1; END IF;
    END LOOP;
  END IF;

  -- 4. Numéro de versement manquant : un rappel par semaine, jusqu'à ce qu'il soit enregistré
  IF v_days > 0 THEN
    FOR r IN SELECT u.id FROM users u
              WHERE u.status = 'active' AND u.deleted_at IS NULL AND u.role IN ('seller','supplier','courier','agent','call_chief')
                AND u.payout_phone IS NULL AND u.created_at < now() - make_interval(days => v_days::int)
    LOOP
      IF _notify_once(r.id, 'payout:' || v_week, 'account', 'Numéro de versement manquant',
           'Enregistrez votre numéro Orange Money ou MTN dans Profil : sans lui, vous ne pourrez pas retirer votre argent.', 'profile')
      THEN v_n_payout := v_n_payout + 1; END IF;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('stock', v_n_stock, 'pickup', v_n_pickup, 'cash', v_n_cash, 'payout', v_n_payout);
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
