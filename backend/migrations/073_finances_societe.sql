-- 073 : Finances de la société (administrateur) : l'argent de la plateforme arrive tout seul dans « Mes finances », et les charges de l'entreprise sont préparées.
-- L'administrateur est déjà toujours en formule Pro, sans abonnement (migration 060). Cette migration :
--  1) relie automatiquement le portefeuille de la plateforme au « Mes finances » de chaque administrateur (aucune liaison à faire, aucune saisie),
--     en lecture seule : une vue lit les écritures du portefeuille, rien n'est copié ni écrit dans le portefeuille, et le grand livre n'est pas touché ;
--  2) ajoute les catégories propres à l'entreprise (serveur, SMS, motos, carburant, publicité, frais Mobile Money, cotisations, patente...) ;
--  3) met le profil « entreprise » aux administrateurs qui n'en ont pas encore choisi un.
-- Les comptes et transactions saisis à la main ne changent pas. Aucune suppression de données.

INSERT INTO pf_cat_system(key, parent_key, kind, label, icon, profile, operating, position) VALUES
  ('co_tech', NULL, 'expense', 'Plateforme et technologie', '🖥️', 'business', true, 100),
  ('co_hosting', 'co_tech', 'expense', 'Hébergement du serveur', '☁️', 'business', true, 101),
  ('co_database', 'co_tech', 'expense', 'Base de données et sauvegardes', '🗄️', 'business', true, 102),
  ('co_sms', 'co_tech', 'expense', 'SMS et WhatsApp', '💬', 'business', true, 103),
  ('co_domain', 'co_tech', 'expense', 'Nom de domaine et sécurité', '🌐', 'business', true, 104),
  ('co_licences', 'co_tech', 'expense', 'Logiciels et licences', '🔑', 'business', true, 105),
  ('co_appstore', 'co_tech', 'expense', 'Publication de l''application', '📲', 'business', true, 106),
  ('co_fleet', NULL, 'expense', 'Flotte et livraison', '🏍️', 'business', true, 107),
  ('co_fuel', 'co_fleet', 'expense', 'Carburant', '⛽', 'business', true, 108),
  ('co_bike_repair', 'co_fleet', 'expense', 'Entretien et réparation des motos', '🔧', 'business', true, 109),
  ('co_courier_gear', 'co_fleet', 'expense', 'Équipement des livreurs', '🪖', 'business', true, 110),
  ('co_fleet_insurance', 'co_fleet', 'expense', 'Assurance des motos', '🛡️', 'business', true, 111),
  ('co_compensation', 'co_fleet', 'expense', 'Compensations (colis perdu ou abîmé)', '🤝', 'business', true, 112),
  ('co_growth', NULL, 'expense', 'Croissance et marketing', '📣', 'business', true, 113),
  ('co_ads', 'co_growth', 'expense', 'Publicité en ligne', '📢', 'business', true, 114),
  ('co_promo', 'co_growth', 'expense', 'Promotions et parrainage', '🎁', 'business', true, 115),
  ('co_print', 'co_growth', 'expense', 'Affiches, tenues et supports imprimés', '🖨️', 'business', true, 116),
  ('co_momo_fees', 'fees', 'expense', 'Frais Mobile Money et banque', '💳', 'business', true, 117),
  ('co_social', 'payroll', 'expense', 'Cotisations sociales (CNSS)', '🧑‍⚕️', 'business', true, 118),
  ('co_registration', 'admin_other', 'expense', 'Immatriculation et autorisations', '📜', 'business', true, 119),
  ('co_local_tax', 'tax', 'expense', 'Patente et taxes locales', '🏛️', 'business', true, 120),
  ('co_delivery_income', 'sales', 'income', 'Livraisons et frais de service', '🚚', 'business', true, 121),
  ('co_subscription_income', 'sales', 'income', 'Abonnements', '🔁', 'business', true, 122);

-- Les administrateurs voient leur activité d'entreprise (profil « entreprise ») sans avoir à le choisir
INSERT INTO pf_prefs(owner_id, profile)
  SELECT id, 'business' FROM users WHERE role = 'admin'
  ON CONFLICT (owner_id) DO UPDATE SET profile = COALESCE(pf_prefs.profile, 'business');

-- Vue des transactions : on ajoute, pour chaque administrateur, les écritures du portefeuille de la plateforme (disponibles), classées par nature
DO $$
DECLARE d text;
BEGIN
  d := pg_get_viewdef('pf_all_tx_raw'::regclass, false);
  d := regexp_replace(d, '[;[:space:]]+$', '');
  EXECUTE 'CREATE OR REPLACE VIEW pf_all_tx_raw AS ' || d || $v$
  UNION ALL
  SELECT 'p' || e.id, u.id, NULL::uuid, m.kind, abs(e.amount), m.category, m.note, e.available_at::date, NULL::uuid, e.created_at, NULL::timestamptz, 'wallindirain'::text
    FROM wallet_entries e
    CROSS JOIN users u
    CROSS JOIN LATERAL (SELECT
        CASE WHEN e.amount > 0 THEN 'income' ELSE 'expense' END AS kind,
        CASE e.kind
          WHEN 'platform_revenue' THEN 'co_delivery_income' WHEN 'subscription' THEN 'co_subscription_income' WHEN 'pf_subscription' THEN 'co_subscription_income'
          WHEN 'team_pay' THEN 'employees'
          WHEN 'courier_prime' THEN 'contractors' WHEN 'tour_bonus' THEN 'contractors' WHEN 'failed_trip' THEN 'contractors'
          WHEN 'tour_adjust' THEN CASE WHEN e.amount > 0 THEN 'misc_income' ELSE 'contractors' END
          WHEN 'referral_bonus' THEN 'co_promo'
          WHEN 'return_fees' THEN 'svc_logistics' WHEN 'return_fee_supplier' THEN 'svc_logistics' WHEN 'cash_shortage' THEN 'svc_logistics'
          WHEN 'transport_loss' THEN 'co_compensation'
          ELSE CASE WHEN e.amount > 0 THEN 'misc_income' ELSE 'other_cost' END END AS category,
        _acc_label(e.kind) AS note) m
   WHERE e.user_id = _platform() AND u.role = 'admin' AND e.available_at <= now()
  $v$;
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
