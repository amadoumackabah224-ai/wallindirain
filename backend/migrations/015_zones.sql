-- =====================================================================
-- Migration 015 : zones de livraison de Conakry et villes de Guinée.
-- Toutes les nouvelles zones sont créées SANS tarif et DÉSACTIVÉES : l'administrateur fixe lui-même
-- le tarif (Réglages → Zones) ; la zone est alors proposée aux clients et aux vendeurs.
-- Les zones déjà configurées (Kaloum, Dixinn, Matam, Ratoma, Matoto, Autre quartier / ville) ne changent pas.
-- =====================================================================
INSERT INTO delivery_rates(commune, fee, active) VALUES
  ('Concasseur', 0, false),
  ('Taouyah', 0, false),
  ('Minière', 0, false),
  ('Hamdalaye', 0, false),
  ('Belle-Vue', 0, false),
  ('Kipé', 0, false),
  ('Hafia', 0, false),
  ('Prince', 0, false),
  ('Kaporo', 0, false),
  ('Gbessia', 0, false),
  ('Hafia 2', 0, false),
  ('Kenien', 0, false),
  ('Constantin', 0, false),
  ('Madina', 0, false),
  ('Aéroport', 0, false),
  ('Carrière', 0, false),
  ('DA', 0, false),
  ('Bondy', 0, false),
  ('Bonfi', 0, false),
  ('Bambeto', 0, false),
  ('Koloma', 0, false),
  ('Dar-es-Salam', 0, false),
  ('Nongo', 0, false),
  ('Cosa', 0, false),
  ('Camayenne', 0, false),
  ('Cameroun', 0, false),
  ('Pont 8 Novembre', 0, false),
  ('Coléyah', 0, false),
  ('Donka', 0, false),
  ('Lambagni', 0, false),
  ('Enco 5', 0, false),
  ('Sangoyah', 0, false),
  ('Yimbaya', 0, false),
  ('Simbossia', 0, false),
  ('Yembeya', 0, false),
  ('Tannerie', 0, false),
  ('Kissosso', 0, false),
  ('Anta', 0, false),
  ('T5', 0, false),
  ('T6', 0, false),
  ('Foulamadina', 0, false),
  ('Kobaya', 0, false),
  ('Sonfonya', 0, false),
  ('T7', 0, false),
  ('Tombolya', 0, false),
  ('Dapompa', 0, false),
  ('T10', 0, false),
  ('Lansanaya', 0, false),
  ('Cimenterie', 0, false),
  ('Bailobaya', 0, false),
  ('Samatara', 0, false),
  ('T8', 0, false),
  ('Km 36', 0, false),
  ('Kountya', 0, false),
  ('CBA', 0, false),
  ('Kagbelin', 0, false),
  ('Keitaya', 0, false),
  ('Démoudoula', 0, false),
  ('Enta', 0, false),
  ('Yattaya', 0, false),
  ('Fossidhe', 0, false),
  ('Coyah', 0, false),
  ('Dubréka', 0, false),
  ('Boké', 0, false),
  ('Boffa', 0, false),
  ('Fria', 0, false),
  ('Gaoual', 0, false),
  ('Koundara', 0, false),
  ('Kamsar', 0, false),
  ('Forécariah', 0, false),
  ('Kindia', 0, false),
  ('Télimélé', 0, false),
  ('Dalaba', 0, false),
  ('Mamou', 0, false),
  ('Pita', 0, false),
  ('Koubia', 0, false),
  ('Labé', 0, false),
  ('Lélouma', 0, false),
  ('Mali', 0, false),
  ('Tougué', 0, false),
  ('Dabola', 0, false),
  ('Dinguiraye', 0, false),
  ('Faranah', 0, false),
  ('Kissidougou', 0, false),
  ('Kankan', 0, false),
  ('Kérouané', 0, false),
  ('Kouroussa', 0, false),
  ('Mandiana', 0, false),
  ('Siguiri', 0, false),
  ('Beyla', 0, false),
  ('Guéckédou', 0, false),
  ('Lola', 0, false),
  ('Macenta', 0, false),
  ('Nzérékoré', 0, false),
  ('Yomou', 0, false)
ON CONFLICT (commune) DO NOTHING;

-- une zone ne peut pas être activée sans tarif (sinon la livraison serait gratuite par erreur)
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
