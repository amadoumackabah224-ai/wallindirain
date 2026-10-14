-- =====================================================================
-- Migration 002 : fonctions de base, comptes, catalogue, stock, portefeuille
-- Convention : fn_*  = point d'entrée appelé par l'API (SECURITY DEFINER, voir 005)
--              _*    = fonction interne
-- Erreurs métier : message "code|Texte en français", SQLSTATE WLD01.
-- Une fonction qui doit COMPTER un échec (mauvais code) renvoie du jsonb au
-- lieu de lever une exception, car une exception annule toute la transaction.
-- =====================================================================

-- Comptes système (jamais connectables)
INSERT INTO users(id, role, status, full_name, phone, password_hash) VALUES
 ('00000000-0000-0000-0000-000000000001','system','active','Wallindirain (résultat)','PLATFORM','!'),
 ('00000000-0000-0000-0000-000000000002','system','active','Wallindirain (stock prépayé)','FLOAT','!');

CREATE FUNCTION _platform() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '00000000-0000-0000-0000-000000000001'::uuid $$;
CREATE FUNCTION _float()    RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '00000000-0000-0000-0000-000000000002'::uuid $$;

CREATE FUNCTION _err(p_code text, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%|%', p_code, p_msg USING ERRCODE = 'WLD01';
END $$;

CREATE FUNCTION _setting(p_key text) RETURNS bigint LANGUAGE plpgsql STABLE AS $$
DECLARE v bigint;
BEGIN
  SELECT value INTO v FROM settings WHERE key = p_key;
  IF v IS NULL THEN PERFORM _err('config', 'Réglage manquant : ' || p_key); END IF;
  RETURN v;
END $$;

CREATE FUNCTION _rand_digits(n int) RETURNS text LANGUAGE plpgsql AS $$
DECLARE s text := ''; b int;
BEGIN
  WHILE length(s) < n LOOP
    b := get_byte(gen_random_bytes(1), 0);
    IF b < 250 THEN s := s || (b % 10)::text; END IF;   -- 250 = multiple de 10, pas de biais
  END LOOP;
  RETURN s;
END $$;

CREATE FUNCTION _code_hash(p_code text, p_salt uuid) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(digest(p_code || ':' || p_salt::text, 'sha256'), 'hex')
$$;

CREATE FUNCTION _audit(p_actor uuid, p_action text, p_entity text, p_entity_id text, p_details jsonb DEFAULT '{}')
RETURNS void LANGUAGE sql AS $$
  INSERT INTO audit_log(actor_id, action, entity, entity_id, details)
  VALUES (p_actor, p_action, p_entity, p_entity_id, COALESCE(p_details, '{}'::jsonb))
$$;

CREATE FUNCTION _require(p_actor uuid, p_roles user_role[]) RETURNS users LANGUAGE plpgsql AS $$
DECLARE u users;
BEGIN
  SELECT * INTO u FROM users WHERE id = p_actor AND deleted_at IS NULL;
  IF NOT FOUND OR u.status <> 'active' THEN
    PERFORM _err('forbidden', 'Compte inactif ou introuvable');
  END IF;
  IF NOT (u.role = ANY (p_roles)) THEN
    PERFORM _err('forbidden', 'Action non autorisée pour votre rôle');
  END IF;
  RETURN u;
END $$;

CREATE FUNCTION _wallet_add(p_user uuid, p_kind text, p_amount bigint, p_order uuid,
                            p_available timestamptz, p_desc text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_amount = 0 THEN RETURN; END IF;
  INSERT INTO wallet_entries(user_id, kind, amount, order_id, available_at, description)
  VALUES (p_user, p_kind, p_amount, p_order, p_available, p_desc);
END $$;

CREATE FUNCTION _wallet_available(p_user uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT COALESCE(sum(amount), 0)::bigint FROM wallet_entries
  WHERE user_id = p_user AND available_at <= now()
$$;

CREATE FUNCTION _wallet_pending(p_user uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT COALESCE(sum(amount), 0)::bigint FROM wallet_entries
  WHERE user_id = p_user AND available_at > now()
$$;

CREATE FUNCTION _queue_message(p_phone text, p_template text, p_body text, p_order uuid DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO messages(to_phone, template, body, order_id) VALUES (p_phone, p_template, p_body, p_order)
$$;

CREATE FUNCTION _margin_for(p_supplier_price bigint) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT ((p_supplier_price * _setting('margin_bps') + 5000) / 10000)::bigint   -- arrondi à l'unité
$$;

CREATE FUNCTION _max_delivery_fee() RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT max(fee) FROM delivery_rates
$$;

-- Prix de vente minimum (par unité) : prix vendeur + call center + livraison la plus chère
CREATE FUNCTION _min_unit_price(p_product uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT p.supplier_price + COALESCE(p.margin_unit, _margin_for(p.supplier_price))
         + _setting('call_fee') + _max_delivery_fee()
  FROM products p WHERE p.id = p_product
$$;

-- ---------------------------------------------------------------------
-- Comptes
-- ---------------------------------------------------------------------
CREATE FUNCTION fn_register(p_phone text, p_name text, p_role user_role, p_password_hash text, p_identity_doc text)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  IF p_role NOT IN ('seller','supplier') THEN
    PERFORM _err('invalid_role', 'Inscription ouverte aux vendeurs et fournisseurs uniquement');
  END IF;
  IF p_identity_doc IS NULL OR length(trim(p_identity_doc)) < 4 THEN
    PERFORM _err('identity_required', 'La pièce d''identité est obligatoire à l''inscription');
  END IF;
  BEGIN
    INSERT INTO users(role, status, full_name, phone, password_hash, identity_doc)
    VALUES (p_role, CASE WHEN p_role = 'supplier' THEN 'pending'::user_status ELSE 'active'::user_status END,
            trim(p_name), p_phone, p_password_hash, trim(p_identity_doc))
    RETURNING id INTO v_id;
  EXCEPTION
    WHEN unique_violation THEN PERFORM _err('phone_taken', 'Ce numéro est déjà inscrit');
    WHEN check_violation  THEN PERFORM _err('invalid_input', 'Nom ou numéro invalide (9 chiffres attendus)');
  END;
  PERFORM _audit(v_id, 'register', 'user', v_id::text, jsonb_build_object('role', p_role));
  RETURN v_id;
END $$;

CREATE FUNCTION fn_admin_create_staff(p_actor uuid, p_phone text, p_name text, p_role user_role,
                                      p_password_hash text, p_team text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_role NOT IN ('admin','agent','call_chief','courier','warehouse') THEN
    PERFORM _err('invalid_role', 'Rôle du personnel invalide');
  END IF;
  IF p_role IN ('agent','call_chief') AND (p_team IS NULL OR length(trim(p_team)) < 2) THEN
    PERFORM _err('team_required', 'Le nom du call center est obligatoire pour un agent ou un chef');
  END IF;
  BEGIN
    INSERT INTO users(role, status, full_name, phone, password_hash, team, identity_verified)
    VALUES (p_role, 'active', trim(p_name), p_phone, p_password_hash, NULLIF(trim(p_team), ''), false)
    RETURNING id INTO v_id;
  EXCEPTION
    WHEN unique_violation THEN PERFORM _err('phone_taken', 'Ce numéro est déjà utilisé');
    WHEN check_violation  THEN PERFORM _err('invalid_input', 'Nom ou numéro invalide (9 chiffres attendus)');
  END;
  PERFORM _audit(p_actor, 'create_staff', 'user', v_id::text, jsonb_build_object('role', p_role));
  RETURN v_id;
END $$;

CREATE FUNCTION fn_admin_set_user_status(p_actor uuid, p_user uuid, p_status user_status)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE u users;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  SELECT * INTO u FROM users WHERE id = p_user AND deleted_at IS NULL AND role <> 'system' FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Utilisateur introuvable'); END IF;
  IF p_user = p_actor AND p_status <> 'active' THEN
    PERFORM _err('invalid_input', 'Vous ne pouvez pas suspendre votre propre compte');
  END IF;
  UPDATE users SET status = p_status WHERE id = p_user;
  IF p_status <> 'active' THEN DELETE FROM sessions WHERE user_id = p_user; END IF;
  PERFORM _audit(p_actor, 'set_user_status', 'user', p_user::text,
                 jsonb_build_object('from', u.status, 'to', p_status));
END $$;

CREATE FUNCTION fn_admin_verify_identity(p_actor uuid, p_user uuid, p_verified boolean DEFAULT true)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  UPDATE users SET identity_verified = p_verified WHERE id = p_user AND deleted_at IS NULL AND role <> 'system';
  IF NOT FOUND THEN PERFORM _err('not_found', 'Utilisateur introuvable'); END IF;
  PERFORM _audit(p_actor, 'verify_identity', 'user', p_user::text, jsonb_build_object('verified', p_verified));
END $$;

-- Connexion : 5 échecs => blocage 15 minutes ; sessions de 12 heures
CREATE FUNCTION fn_login_lookup(p_phone text)
RETURNS TABLE(id uuid, password_hash text, role user_role, status user_status, full_name text)
LANGUAGE plpgsql AS $$
DECLARE u users;
BEGIN
  SELECT x.* INTO u FROM users x WHERE x.phone = p_phone AND x.deleted_at IS NULL AND x.role <> 'system';
  IF NOT FOUND THEN RETURN; END IF;
  IF u.locked_until IS NOT NULL AND u.locked_until > now() THEN
    PERFORM _err('locked', 'Compte bloqué 15 minutes après trop d''échecs. Réessayez plus tard.');
  END IF;
  RETURN QUERY SELECT u.id, u.password_hash, u.role, u.status, u.full_name;
END $$;

CREATE FUNCTION fn_login_failed(p_phone text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE u users;
BEGIN
  SELECT * INTO u FROM users WHERE phone = p_phone AND deleted_at IS NULL AND role <> 'system' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF u.failed_attempts + 1 >= 5 THEN
    UPDATE users SET failed_attempts = 0, locked_until = now() + interval '15 minutes' WHERE id = u.id;
    PERFORM _audit(u.id, 'login_locked', 'user', u.id::text);
  ELSE
    UPDATE users SET failed_attempts = failed_attempts + 1 WHERE id = u.id;
  END IF;
END $$;

CREATE FUNCTION fn_login_ok(p_user uuid) RETURNS void LANGUAGE sql AS $$
  UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = p_user
$$;

CREATE FUNCTION fn_session_create(p_user uuid, p_token_hash text) RETURNS timestamptz LANGUAGE plpgsql AS $$
DECLARE v_exp timestamptz := now() + interval '12 hours';
BEGIN
  DELETE FROM sessions WHERE expires_at < now();
  INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (p_token_hash, p_user, v_exp);
  RETURN v_exp;
END $$;

CREATE FUNCTION fn_session_user(p_token_hash text)
RETURNS TABLE(id uuid, role user_role, full_name text, phone text, team text, identity_verified boolean)
LANGUAGE sql STABLE AS $$
  SELECT u.id, u.role, u.full_name, u.phone, u.team, u.identity_verified
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = p_token_hash AND s.expires_at > now()
    AND u.status = 'active' AND u.deleted_at IS NULL
$$;

CREATE FUNCTION fn_session_revoke(p_token_hash text) RETURNS void LANGUAGE sql AS $$
  DELETE FROM sessions WHERE token_hash = p_token_hash
$$;

-- Mot de passe oublié : code à 6 chiffres, valable 15 minutes
CREATE FUNCTION fn_password_reset_request(p_phone text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE u users; v_id uuid := gen_random_uuid(); v_code text;
BEGIN
  SELECT * INTO u FROM users WHERE phone = p_phone AND deleted_at IS NULL AND status <> 'suspended' AND role <> 'system';
  IF NOT FOUND THEN RETURN; END IF;                       -- pas de fuite d'information
  UPDATE one_time_codes SET used_at = now()
   WHERE user_id = u.id AND purpose = 'password_reset' AND used_at IS NULL;
  v_code := _rand_digits(6);
  INSERT INTO one_time_codes(id, user_id, purpose, code_hash, expires_at)
  VALUES (v_id, u.id, 'password_reset', _code_hash(v_code, v_id), now() + interval '15 minutes');
  PERFORM _queue_message(u.phone, 'password_reset',
    'Wallindirain : votre code de réinitialisation est ' || v_code || '. Il expire dans 15 minutes.');
END $$;

CREATE FUNCTION fn_password_reset_confirm(p_phone text, p_code text, p_new_hash text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE u users; c one_time_codes;
BEGIN
  SELECT * INTO u FROM users WHERE phone = p_phone AND deleted_at IS NULL AND role <> 'system';
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'invalid'); END IF;
  SELECT * INTO c FROM one_time_codes
   WHERE user_id = u.id AND purpose = 'password_reset' AND used_at IS NULL AND expires_at > now()
   ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND OR c.attempts >= 5 THEN RETURN jsonb_build_object('ok', false, 'reason', 'invalid'); END IF;
  IF c.code_hash <> _code_hash(p_code, c.id) THEN
    UPDATE one_time_codes SET attempts = attempts + 1 WHERE id = c.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;
  UPDATE one_time_codes SET used_at = now() WHERE id = c.id;
  UPDATE users SET password_hash = p_new_hash, failed_attempts = 0, locked_until = NULL WHERE id = u.id;
  DELETE FROM sessions WHERE user_id = u.id;
  PERFORM _audit(u.id, 'password_reset', 'user', u.id::text);
  RETURN jsonb_build_object('ok', true);
END $$;

-- ---------------------------------------------------------------------
-- Catalogue et stock
-- ---------------------------------------------------------------------
CREATE FUNCTION fn_supplier_add_product(p_actor uuid, p_name text, p_description text, p_price bigint,
                                        p_storage storage_mode, p_initial_qty int DEFAULT 0)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM _require(p_actor, ARRAY['supplier']::user_role[]);
  IF p_price IS NULL OR p_price <= 0 THEN PERFORM _err('invalid_input', 'Prix fournisseur invalide'); END IF;
  IF p_storage = 'wallindirain' AND COALESCE(p_initial_qty, 0) <> 0 THEN
    PERFORM _err('invalid_input', 'Pour un stockage chez Wallindirain, annoncez un arrivage (le stock vient du comptage)');
  END IF;
  BEGIN
    INSERT INTO products(supplier_id, name, description, supplier_price, storage, stock_qty)
    VALUES (p_actor, trim(p_name), NULLIF(trim(p_description), ''), p_price, p_storage, GREATEST(COALESCE(p_initial_qty, 0), 0))
    RETURNING id INTO v_id;
  EXCEPTION WHEN check_violation THEN PERFORM _err('invalid_input', 'Nom de produit invalide');
  END;
  PERFORM _audit(p_actor, 'product_proposed', 'product', v_id::text);
  RETURN v_id;
END $$;

CREATE FUNCTION fn_admin_review_product(p_actor uuid, p_product uuid, p_approve boolean,
                                        p_margin_bps int DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE p products; v_margin bigint;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  SELECT * INTO p FROM products WHERE id = p_product AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Produit introuvable'); END IF;
  IF p.status <> 'pending' THEN PERFORM _err('invalid_state', 'Ce produit a déjà été traité'); END IF;
  IF p_approve THEN
    IF p_margin_bps IS NOT NULL AND (p_margin_bps < 0 OR p_margin_bps > 10000) THEN
      PERFORM _err('invalid_input', 'Marge invalide');
    END IF;
    v_margin := CASE WHEN p_margin_bps IS NULL THEN _margin_for(p.supplier_price)
                     ELSE (p.supplier_price * p_margin_bps + 5000) / 10000 END;
    UPDATE products SET status = 'approved', margin_unit = v_margin WHERE id = p_product;
  ELSE
    UPDATE products SET status = 'rejected' WHERE id = p_product;
  END IF;
  PERFORM _audit(p_actor, CASE WHEN p_approve THEN 'product_approved' ELSE 'product_rejected' END,
                 'product', p_product::text, jsonb_build_object('margin_unit', v_margin));
END $$;

-- La marge d'un produit ne change plus tant qu'un vendeur détient du stock prépayé
CREATE FUNCTION fn_admin_set_product_margin(p_actor uuid, p_product uuid, p_margin_bps int)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE p products;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  SELECT * INTO p FROM products WHERE id = p_product AND status = 'approved' FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Produit approuvé introuvable'); END IF;
  IF p_margin_bps < 0 OR p_margin_bps > 10000 THEN PERFORM _err('invalid_input', 'Marge invalide'); END IF;
  IF EXISTS (SELECT 1 FROM seller_stock WHERE product_id = p_product AND qty > 0)
     OR EXISTS (SELECT 1 FROM orders WHERE product_id = p_product
                AND status NOT IN ('delivered','returned','refused','cancelled')) THEN
    PERFORM _err('margin_locked', 'Marge verrouillée : du stock prépayé ou des commandes en cours existent');
  END IF;
  UPDATE products SET margin_unit = (p.supplier_price * p_margin_bps + 5000) / 10000 WHERE id = p_product;
  PERFORM _audit(p_actor, 'product_margin_changed', 'product', p_product::text,
                 jsonb_build_object('margin_bps', p_margin_bps));
END $$;

CREATE FUNCTION fn_supplier_announce_arrival(p_actor uuid, p_product uuid, p_qty int) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE p products; v_id uuid;
BEGIN
  PERFORM _require(p_actor, ARRAY['supplier']::user_role[]);
  SELECT * INTO p FROM products WHERE id = p_product AND supplier_id = p_actor AND deleted_at IS NULL;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Produit introuvable'); END IF;
  IF p.storage <> 'wallindirain' THEN PERFORM _err('invalid_state', 'Ce produit est stocké chez vous : mettez à jour votre quantité'); END IF;
  IF p.status <> 'approved' THEN PERFORM _err('invalid_state', 'Produit non encore validé'); END IF;
  IF p_qty IS NULL OR p_qty <= 0 OR p_qty > 100000 THEN PERFORM _err('invalid_input', 'Quantité invalide'); END IF;
  INSERT INTO arrivals(product_id, announced_qty) VALUES (p_product, p_qty) RETURNING id INTO v_id;
  PERFORM _audit(p_actor, 'arrival_announced', 'arrival', v_id::text, jsonb_build_object('qty', p_qty));
  RETURN v_id;
END $$;

-- Seuls les produits comptés par le magasinier deviennent vendables
CREATE FUNCTION fn_warehouse_count_arrival(p_actor uuid, p_arrival uuid, p_counted int) RETURNS void LANGUAGE plpgsql AS $$
DECLARE a arrivals;
BEGIN
  PERFORM _require(p_actor, ARRAY['warehouse','admin']::user_role[]);
  IF p_counted IS NULL OR p_counted < 0 THEN PERFORM _err('invalid_input', 'Quantité comptée invalide'); END IF;
  SELECT * INTO a FROM arrivals WHERE id = p_arrival FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Arrivage introuvable'); END IF;
  IF a.counted_qty IS NOT NULL THEN PERFORM _err('invalid_state', 'Arrivage déjà compté'); END IF;
  UPDATE arrivals SET counted_qty = p_counted, counted_by = p_actor, counted_at = now() WHERE id = p_arrival;
  UPDATE products SET stock_qty = stock_qty + p_counted WHERE id = a.product_id;
  PERFORM _audit(p_actor, 'arrival_counted', 'arrival', p_arrival::text,
                 jsonb_build_object('announced', a.announced_qty, 'counted', p_counted));
END $$;

CREATE FUNCTION fn_supplier_set_stock(p_actor uuid, p_product uuid, p_qty int) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p products;
BEGIN
  PERFORM _require(p_actor, ARRAY['supplier']::user_role[]);
  SELECT * INTO p FROM products WHERE id = p_product AND supplier_id = p_actor AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Produit introuvable'); END IF;
  IF p.storage <> 'supplier' THEN PERFORM _err('invalid_state', 'Stock géré par Wallindirain : annoncez un arrivage'); END IF;
  IF p_qty IS NULL OR p_qty < p.reserved_qty OR p_qty > 1000000 THEN
    PERFORM _err('invalid_input', 'Quantité invalide (au moins ' || p.reserved_qty || ' déjà réservées)');
  END IF;
  UPDATE products SET stock_qty = p_qty WHERE id = p_product;
  PERFORM _audit(p_actor, 'supplier_stock_set', 'product', p_product::text, jsonb_build_object('qty', p_qty));
END $$;

CREATE FUNCTION fn_seller_set_price(p_actor uuid, p_product uuid, p_price bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_min bigint;
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  IF NOT EXISTS (SELECT 1 FROM products WHERE id = p_product AND status = 'approved' AND deleted_at IS NULL) THEN
    PERFORM _err('not_found', 'Produit introuvable');
  END IF;
  v_min := _min_unit_price(p_product);
  IF p_price IS NULL OR p_price < v_min THEN
    PERFORM _err('price_below_minimum', 'Prix trop bas : minimum ' || v_min || ' GNF pour ne pas vendre à perte');
  END IF;
  INSERT INTO seller_prices(seller_id, product_id, sale_price) VALUES (p_actor, p_product, p_price)
  ON CONFLICT (seller_id, product_id) DO UPDATE SET sale_price = EXCLUDED.sale_price, updated_at = now();
END $$;

CREATE FUNCTION fn_seller_create_link(p_actor uuid, p_product uuid) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_code text;
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  IF NOT EXISTS (SELECT 1 FROM seller_prices sp JOIN products p ON p.id = sp.product_id
                 WHERE sp.seller_id = p_actor AND sp.product_id = p_product AND p.status = 'approved') THEN
    PERFORM _err('price_required', 'Fixez d''abord votre prix pour ce produit');
  END IF;
  SELECT code INTO v_code FROM seller_links WHERE seller_id = p_actor AND product_id = p_product;
  IF v_code IS NOT NULL THEN RETURN v_code; END IF;
  v_code := lower(translate(encode(gen_random_bytes(6), 'base64'), '+/=', 'abc'));
  INSERT INTO seller_links(code, seller_id, product_id) VALUES (v_code, p_actor, p_product);
  RETURN v_code;
END $$;

-- Dépôt d'argent auprès de Wallindirain : crédite le portefeuille
CREATE FUNCTION fn_admin_deposit(p_actor uuid, p_user uuid, p_amount bigint, p_reference text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE u users;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_amount IS NULL OR p_amount <= 0 THEN PERFORM _err('invalid_input', 'Montant invalide'); END IF;
  IF p_reference IS NULL OR length(trim(p_reference)) < 2 THEN PERFORM _err('invalid_input', 'Référence du dépôt obligatoire'); END IF;
  SELECT * INTO u FROM users WHERE id = p_user AND status = 'active' AND role IN ('seller','supplier');
  IF NOT FOUND THEN PERFORM _err('not_found', 'Compte vendeur ou fournisseur actif introuvable'); END IF;
  PERFORM _wallet_add(p_user, 'deposit', p_amount, NULL, now(), trim(p_reference));
  PERFORM _audit(p_actor, 'deposit', 'user', p_user::text, jsonb_build_object('amount', p_amount, 'reference', p_reference));
END $$;

-- Achat de stock : payé à l'avance depuis le portefeuille, gardé chez Wallindirain
CREATE FUNCTION fn_seller_buy_stock(p_actor uuid, p_product uuid, p_qty int) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE p products; v_unit bigint; v_cost bigint;
BEGIN
  PERFORM _require(p_actor, ARRAY['seller']::user_role[]);
  IF p_qty IS NULL OR p_qty <= 0 OR p_qty > 100000 THEN PERFORM _err('invalid_input', 'Quantité invalide'); END IF;
  SELECT * INTO p FROM products WHERE id = p_product AND status = 'approved' AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Produit introuvable'); END IF;
  IF p.storage <> 'wallindirain' THEN
    PERFORM _err('invalid_state', 'Ce produit est stocké chez le fournisseur : il ne peut pas être acheté à l''avance');
  END IF;
  IF p.stock_qty - p.reserved_qty < p_qty THEN PERFORM _err('out_of_stock', 'Stock disponible insuffisant'); END IF;
  v_unit := p.supplier_price + p.margin_unit;
  v_cost := v_unit * p_qty;
  PERFORM pg_advisory_xact_lock(hashtext('wallet:' || p_actor::text));
  IF _wallet_available(p_actor) < v_cost THEN
    PERFORM _err('insufficient_funds', 'Solde insuffisant : ' || v_cost || ' GNF nécessaires. Faites un dépôt auprès de Wallindirain.');
  END IF;
  PERFORM _wallet_add(p_actor, 'stock_purchase', -v_cost, NULL, now(), p_qty || ' x ' || p.name);
  PERFORM _wallet_add(_float(), 'float_in', v_cost, NULL, now(), 'Achat de stock prépayé');
  UPDATE products SET stock_qty = stock_qty - p_qty WHERE id = p_product;
  INSERT INTO seller_stock(seller_id, product_id, qty) VALUES (p_actor, p_product, p_qty)
  ON CONFLICT (seller_id, product_id) DO UPDATE SET qty = seller_stock.qty + EXCLUDED.qty;
  PERFORM _audit(p_actor, 'stock_purchased', 'product', p_product::text, jsonb_build_object('qty', p_qty, 'cost', v_cost));
  RETURN jsonb_build_object('cost', v_cost, 'unit', v_unit);
END $$;

-- Réglages (administrateur)
CREATE FUNCTION fn_admin_set_setting(p_actor uuid, p_key text, p_value bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_old bigint;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_value IS NULL OR p_value < 0 THEN PERFORM _err('invalid_input', 'Valeur invalide'); END IF;
  IF p_key = 'margin_bps' AND p_value > 10000 THEN PERFORM _err('invalid_input', 'Marge invalide'); END IF;
  IF p_key IN ('code_max_attempts','call_attempt_limit') AND p_value < 1 THEN PERFORM _err('invalid_input', 'Valeur invalide'); END IF;
  SELECT value INTO v_old FROM settings WHERE key = p_key FOR UPDATE;
  IF NOT FOUND THEN PERFORM _err('not_found', 'Réglage inconnu'); END IF;
  UPDATE settings SET value = p_value WHERE key = p_key;
  PERFORM _audit(p_actor, 'setting_changed', 'setting', p_key, jsonb_build_object('from', v_old, 'to', p_value));
END $$;

CREATE FUNCTION fn_admin_set_delivery_rate(p_actor uuid, p_commune text, p_fee bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_old bigint;
BEGIN
  PERFORM _require(p_actor, ARRAY['admin']::user_role[]);
  IF p_fee IS NULL OR p_fee < 0 OR p_fee > 1000000 THEN PERFORM _err('invalid_input', 'Tarif invalide'); END IF;
  IF p_commune IS NULL OR length(trim(p_commune)) < 2 THEN PERFORM _err('invalid_input', 'Commune invalide'); END IF;
  SELECT fee INTO v_old FROM delivery_rates WHERE commune = trim(p_commune);
  INSERT INTO delivery_rates(commune, fee) VALUES (trim(p_commune), p_fee)
  ON CONFLICT (commune) DO UPDATE SET fee = EXCLUDED.fee;
  PERFORM _audit(p_actor, 'delivery_rate_changed', 'commune', trim(p_commune),
                 jsonb_build_object('from', v_old, 'to', p_fee));
END $$;
