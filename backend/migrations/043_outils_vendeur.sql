-- 043 : outils du vendeur.
--  - carnet de clients : une note privée par client (le vendeur ne voit que ses propres clients) ;
--  - dépenses du vendeur (publicité, marchandise, transport, autre) pour calculer son vrai bénéfice.
-- Aucun montant de la plateforme n'est touché : ni portefeuille, ni frais, ni marge, ni tarif.
CREATE TABLE seller_customer_notes (
  seller_id      uuid NOT NULL REFERENCES users(id),
  customer_phone text NOT NULL CHECK (customer_phone ~ '^[0-9]{9}$'),
  note           text NOT NULL CHECK (length(trim(note)) BETWEEN 1 AND 500),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (seller_id, customer_phone)
);

CREATE TABLE seller_expenses (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id  uuid NOT NULL REFERENCES users(id),
  spent_on   date NOT NULL,
  category   text NOT NULL CHECK (category IN ('ads','goods','transport','other')),
  channel    text CHECK (channel IN ('facebook','whatsapp','tiktok','instagram','site','phone','other')),
  amount     bigint NOT NULL CHECK (amount > 0 AND amount <= 100000000000),
  note       text CHECK (length(note) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_at  timestamptz,
  CHECK (channel IS NULL OR category = 'ads')
);
CREATE INDEX seller_expenses_seller_idx ON seller_expenses(seller_id, spent_on DESC);

-- note sur un client : seulement un client qui a déjà commandé chez ce vendeur ; une note vide efface la note
CREATE FUNCTION fn_seller_set_customer_note(p_actor uuid, p_phone text, p_note text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_note text := trim(COALESCE(p_note, ''));
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  IF p_phone IS NULL OR p_phone !~ '^[0-9]{9}$' THEN PERFORM _err('invalid_input', 'Numéro du client invalide'); END IF;
  IF length(v_note) > 500 THEN PERFORM _err('invalid_input', 'Note trop longue (500 caractères maximum)'); END IF;
  IF NOT EXISTS (SELECT 1 FROM orders WHERE seller_id = p_actor AND customer_phone = p_phone) THEN
    PERFORM _err('not_found', 'Client introuvable');
  END IF;
  IF v_note = '' THEN
    DELETE FROM seller_customer_notes WHERE seller_id = p_actor AND customer_phone = p_phone;
  ELSE
    INSERT INTO seller_customer_notes(seller_id, customer_phone, note) VALUES (p_actor, p_phone, v_note)
    ON CONFLICT (seller_id, customer_phone) DO UPDATE SET note = EXCLUDED.note, updated_at = now();
  END IF;
  PERFORM _audit(p_actor, 'customer_note_set', 'customer', p_phone, jsonb_build_object('cleared', v_note = ''));
END $$;

CREATE FUNCTION fn_seller_add_expense(p_actor uuid, p_date date, p_category text, p_channel text, p_amount bigint, p_note text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid; v_note text := NULLIF(trim(COALESCE(p_note, '')), '');
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  IF p_category IS NULL OR p_category NOT IN ('ads','goods','transport','other') THEN PERFORM _err('invalid_input', 'Catégorie de dépense invalide'); END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 100000000000 THEN PERFORM _err('invalid_input', 'Montant invalide'); END IF;
  IF p_date IS NULL OR p_date > current_date OR p_date < current_date - 400 THEN PERFORM _err('invalid_input', 'Date invalide (pas dans le futur, 400 jours au plus dans le passé)'); END IF;
  IF p_channel IS NOT NULL AND (p_category <> 'ads' OR p_channel NOT IN ('facebook','whatsapp','tiktok','instagram','site','phone','other')) THEN
    PERFORM _err('invalid_input', 'Le canal ne se précise que pour la publicité');
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 200 THEN PERFORM _err('invalid_input', 'Note trop longue (200 caractères maximum)'); END IF;
  INSERT INTO seller_expenses(seller_id, spent_on, category, channel, amount, note) VALUES (p_actor, p_date, p_category, p_channel, p_amount, v_note) RETURNING id INTO v_id;
  PERFORM _audit(p_actor, 'expense_added', 'expense', v_id::text, jsonb_build_object('category', p_category, 'amount', p_amount));
  RETURN v_id;
END $$;

-- une dépense n'est jamais effacée : elle est annulée (reste dans l'historique)
CREATE FUNCTION fn_seller_void_expense(p_actor uuid, p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE e seller_expenses;
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  SELECT * INTO e FROM seller_expenses WHERE id = p_id AND seller_id = p_actor FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Dépense introuvable'); END IF;
  IF e.voided_at IS NOT NULL THEN PERFORM _err('invalid_state', 'Dépense déjà annulée'); END IF;
  UPDATE seller_expenses SET voided_at = now() WHERE id = e.id;
  PERFORM _audit(p_actor, 'expense_voided', 'expense', e.id::text);
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
       AND NOT (r.relname = 'identity_documents' AND column_name IN ('front','back','selfie'));
    EXECUTE format('GRANT SELECT (%s) ON %I TO wld_app', v_cols, r.relname);
  END LOOP;
END $$;
