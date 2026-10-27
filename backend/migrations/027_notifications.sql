-- 027 : notifications dans l'application (cloche) et annonces de l'administration.
-- AUCUN calcul d'argent n'est touché : les déclencheurs ci-dessous ne font que LIRE un changement déjà fait et écrire une ligne dans « notifications ».
-- Sécurité : une notification qui échouerait ne bloque JAMAIS l'action métier (chaque déclencheur avale ses propres erreurs).
-- Les textes ne contiennent ni téléphone ni adresse : seulement la référence de la commande, un montant de bonus ou un statut.
CREATE TABLE notifications (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id),
  kind       text NOT NULL,
  title      text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body       text CHECK (body IS NULL OR length(body) <= 600),
  link       text CHECK (link IS NULL OR link ~ '^[a-z]{2,20}$'),   -- clé d'onglet de l'application (orders, wallet, profile…)
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz
);
CREATE INDEX notifications_user_idx ON notifications(user_id, id DESC);
CREATE INDEX notifications_unread_idx ON notifications(user_id) WHERE read_at IS NULL;

CREATE TABLE announcements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audience    text NOT NULL CHECK (audience IN ('all','seller','supplier','agent','call_chief','courier','warehouse')),
  title       text NOT NULL CHECK (length(trim(title)) BETWEEN 3 AND 120),
  body        text NOT NULL CHECK (length(trim(body)) BETWEEN 3 AND 600),
  created_by  uuid NOT NULL REFERENCES users(id),
  recipients  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION _notify(p_user uuid, p_kind text, p_title text, p_body text DEFAULT NULL, p_link text DEFAULT NULL) RETURNS void LANGUAGE sql AS $$
  INSERT INTO notifications(user_id, kind, title, body, link) SELECT p_user, p_kind, p_title, p_body, p_link WHERE p_user IS NOT NULL
$$;

-- montant lisible : 150000 -> « 150 000 GNF »
CREATE FUNCTION _gnf_text(p_amount bigint) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(p_amount::text, '(\d)(?=(\d{3})+$)', '\1 ', 'g') || ' GNF'
$$;

-- Commandes : le vendeur suit son colis ; le livreur est prévenu d'un nouveau colis
CREATE FUNCTION _notify_order_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    IF NEW.status = 'confirmed' THEN PERFORM _notify(NEW.seller_id, 'order', 'Commande confirmée', 'Le client a confirmé la commande ' || NEW.ref || '.', 'orders');
    ELSIF NEW.status = 'assigned' THEN
      PERFORM _notify(NEW.seller_id, 'order', 'Livreur affecté', 'Un livreur est affecté à la commande ' || NEW.ref || '.', 'orders');
      PERFORM _notify(NEW.courier_id, 'order', 'Nouveau colis affecté', 'Commande ' || NEW.ref || ' : ouvrez Livraisons.', 'orders');
    ELSIF NEW.status = 'delivered' THEN PERFORM _notify(NEW.seller_id, 'order', 'Commande livrée', 'La commande ' || NEW.ref || ' a été livrée.', 'orders');
    ELSIF NEW.status = 'failed' THEN PERFORM _notify(NEW.seller_id, 'order', 'Livraison échouée', 'La livraison de la commande ' || NEW.ref || ' a échoué.', 'orders');
    ELSIF NEW.status = 'refused' THEN PERFORM _notify(NEW.seller_id, 'order', 'Colis refusé', 'Le client a refusé la commande ' || NEW.ref || '.', 'orders');
    ELSIF NEW.status = 'return_pending' THEN PERFORM _notify(NEW.seller_id, 'order', 'Retour attendu', 'La commande ' || NEW.ref || ' revient vers l''entrepôt.', 'orders');
    ELSIF NEW.status = 'returned' THEN PERFORM _notify(NEW.seller_id, 'order', 'Colis retourné', 'La commande ' || NEW.ref || ' est revenue.', 'orders');
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_notify AFTER UPDATE OF status ON orders
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION _notify_order_status();

-- Retraits
CREATE FUNCTION _notify_withdrawal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    IF NEW.status = 'paid' THEN PERFORM _notify(NEW.user_id, 'money', 'Retrait payé', 'Votre retrait de ' || _gnf_text(NEW.amount) || ' a été envoyé.', 'wallet');
    ELSIF NEW.status = 'rejected' THEN PERFORM _notify(NEW.user_id, 'money', 'Retrait refusé', 'Votre demande de retrait de ' || _gnf_text(NEW.amount) || ' a été refusée. Le montant vous est rendu.', 'wallet');
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END $$;
CREATE TRIGGER withdrawals_notify AFTER UPDATE OF status ON withdrawals
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION _notify_withdrawal();

-- Bonus reçus (parrainage, tournée) : montants déjà calculés et écrits par les règles existantes, on ne fait que les annoncer
CREATE FUNCTION _notify_bonus() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    PERFORM _notify(NEW.user_id, 'money', CASE NEW.kind WHEN 'referral_bonus' THEN 'Bonus de parrainage reçu' ELSE 'Bonus de tournée reçu' END, 'Vous avez reçu ' || _gnf_text(NEW.amount) || '.', 'wallet');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END $$;
CREATE TRIGGER wallet_bonus_notify AFTER INSERT ON wallet_entries
  FOR EACH ROW WHEN (NEW.kind IN ('referral_bonus', 'tour_bonus', 'tour_adjust') AND NEW.amount > 0) EXECUTE FUNCTION _notify_bonus();

-- Pièce d'identité
CREATE FUNCTION _notify_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    IF NEW.status = 'verified' THEN PERFORM _notify(NEW.user_id, 'account', 'Identité vérifiée', 'Votre identité est validée : les retraits sont possibles.', 'profile');
    ELSIF NEW.status = 'rejected' THEN PERFORM _notify(NEW.user_id, 'account', 'Pièce d''identité refusée', COALESCE(left(NEW.reject_reason, 300), 'Merci de renvoyer vos photos.'), 'profile');
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END $$;
CREATE TRIGGER identity_notify AFTER UPDATE OF status ON identity_documents
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION _notify_identity();

-- Produits d'un fournisseur
CREATE FUNCTION _notify_product() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    IF NEW.status = 'approved' THEN PERFORM _notify(NEW.supplier_id, 'product', 'Produit validé', 'Votre produit « ' || left(NEW.name, 60) || ' » est validé.', 'products');
    ELSIF NEW.status = 'rejected' THEN PERFORM _notify(NEW.supplier_id, 'product', 'Produit refusé', 'Votre produit « ' || left(NEW.name, 60) || ' » n''a pas été validé.', 'products');
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END $$;
CREATE TRIGGER products_notify AFTER UPDATE OF status ON products
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('approved', 'rejected')) EXECUTE FUNCTION _notify_product();

-- Nouvelle tournée pour un livreur
CREATE FUNCTION _notify_tour() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    PERFORM _notify(NEW.courier_id, 'order', 'Nouvelle tournée', 'Une tournée groupée vous est proposée : ouvrez Livraisons pour l''accepter.', 'orders');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END $$;
CREATE TRIGGER tours_notify AFTER INSERT ON tours FOR EACH ROW EXECUTE FUNCTION _notify_tour();

-- Réponse du support
CREATE FUNCTION _notify_support() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_user uuid;
BEGIN
  BEGIN
    IF NEW.sender = 'admin' THEN
      SELECT user_id INTO v_user FROM support_threads WHERE id = NEW.thread_id;
      PERFORM _notify(v_user, 'support', 'Réponse de Wallindirain', left(NEW.body, 200), NULL);
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END $$;
CREATE TRIGGER support_notify AFTER INSERT ON support_messages FOR EACH ROW EXECUTE FUNCTION _notify_support();

-- ---------- Lecture par la personne connectée ----------
CREATE FUNCTION fn_my_notifications(p_actor uuid, p_limit int DEFAULT 50) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE u users; v_items jsonb;
BEGIN
  u := _require(p_actor, ARRAY['admin','supplier','seller','agent','call_chief','courier','warehouse']::user_role[]);
  DELETE FROM notifications WHERE user_id = p_actor AND created_at < now() - interval '90 days';
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', n.id, 'kind', n.kind, 'title', n.title, 'body', n.body, 'link', n.link, 'created_at', n.created_at, 'read', n.read_at IS NOT NULL) ORDER BY n.id DESC), '[]'::jsonb)
    INTO v_items FROM (SELECT * FROM notifications WHERE user_id = p_actor ORDER BY id DESC LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100)) n;
  RETURN jsonb_build_object('unread', (SELECT count(*) FROM notifications WHERE user_id = p_actor AND read_at IS NULL), 'items', v_items);
END $$;

CREATE FUNCTION fn_notifications_unread(p_actor uuid) RETURNS int LANGUAGE plpgsql STABLE AS $$
DECLARE u users;
BEGIN
  u := _require(p_actor, ARRAY['admin','supplier','seller','agent','call_chief','courier','warehouse']::user_role[]);
  RETURN (SELECT count(*)::int FROM notifications WHERE user_id = p_actor AND read_at IS NULL);
END $$;

-- p_ids NULL = tout marquer comme lu ; on ne touche jamais aux notifications d'une autre personne
CREATE FUNCTION fn_notifications_read(p_actor uuid, p_ids bigint[] DEFAULT NULL) RETURNS int LANGUAGE plpgsql AS $$
DECLARE u users; v_n int;
BEGIN
  u := _require(p_actor, ARRAY['admin','supplier','seller','agent','call_chief','courier','warehouse']::user_role[]);
  UPDATE notifications SET read_at = now() WHERE user_id = p_actor AND read_at IS NULL AND (p_ids IS NULL OR id = ANY (p_ids));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- ---------- Annonces de l'administration ----------
CREATE FUNCTION fn_admin_announce(p_actor uuid, p_audience text, p_title text, p_body text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE u users; v_id uuid := gen_random_uuid(); v_n int;
BEGIN
  u := _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_audience NOT IN ('all','seller','supplier','agent','call_chief','courier','warehouse') THEN PERFORM _err('invalid_input', 'Destinataires invalides'); END IF;
  IF length(trim(COALESCE(p_title, ''))) NOT BETWEEN 3 AND 120 THEN PERFORM _err('invalid_input', 'Le titre doit faire entre 3 et 120 caractères'); END IF;
  IF length(trim(COALESCE(p_body, ''))) NOT BETWEEN 3 AND 600 THEN PERFORM _err('invalid_input', 'Le message doit faire entre 3 et 600 caractères'); END IF;
  INSERT INTO notifications(user_id, kind, title, body, link)
    SELECT x.id, 'announcement', trim(p_title), trim(p_body), NULL FROM users x
     WHERE x.deleted_at IS NULL AND x.status = 'active' AND x.role <> 'system' AND x.id <> p_actor
       AND (p_audience = 'all' OR x.role::text = p_audience);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  INSERT INTO announcements(id, audience, title, body, created_by, recipients) VALUES (v_id, p_audience, trim(p_title), trim(p_body), p_actor, v_n);
  PERFORM _audit(p_actor, 'announcement', 'announcement', v_id::text, jsonb_build_object('audience', p_audience, 'recipients', v_n));
  RETURN jsonb_build_object('id', v_id, 'recipients', v_n);
END $$;

CREATE FUNCTION fn_admin_announcements(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE u users;
BEGIN
  u := _require(p_actor, ARRAY['admin']::user_role[]);
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'audience', a.audience, 'title', a.title, 'body', a.body, 'recipients', a.recipients, 'created_at', a.created_at) ORDER BY a.created_at DESC)
                     FROM (SELECT * FROM announcements ORDER BY created_at DESC LIMIT 30) a), '[]'::jsonb);
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
