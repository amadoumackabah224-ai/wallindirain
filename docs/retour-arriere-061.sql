-- Retour arrière de la migration 061 (boutique). Refuse s'il existe des produits, ventes ou clôtures.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pf_items) OR EXISTS (SELECT 1 FROM pf_sales) OR EXISTS (SELECT 1 FROM pf_cash_close) THEN RAISE EXCEPTION 'retour arrière refusé : des données de boutique existent'; END IF;
END $$;
DO $$
DECLARE d text;
BEGIN
  SELECT pg_get_functiondef('fn_pf_erase(uuid,text)'::regprocedure) INTO d;
  d := replace(d, 'DELETE FROM pf_sale_lines WHERE sale_id IN (SELECT id FROM pf_sales WHERE owner_id = p_actor);' || E'\n  ', '');
  d := replace(d, 'DELETE FROM pf_sales WHERE owner_id = p_actor;' || E'\n  ', '');
  d := replace(d, 'DELETE FROM pf_cash_close WHERE owner_id = p_actor;' || E'\n  ', '');
  d := replace(d, 'DELETE FROM pf_items WHERE owner_id = p_actor;' || E'\n  ', '');
  EXECUTE d;
END $$;
DROP TRIGGER users_pf_shop_anonymized ON users;
DROP FUNCTION trg_pf_shop_anonymized();
DROP FUNCTION fn_pf_cash_close(uuid, uuid, date, bigint, text);
DROP FUNCTION fn_pf_sale_void(uuid, uuid);
DROP FUNCTION fn_pf_sale_add(uuid, uuid, date, jsonb, text);
DROP FUNCTION fn_pf_item_restock(uuid, uuid, int, bigint, uuid, date);
DROP FUNCTION fn_pf_item_archive(uuid, uuid, boolean);
DROP FUNCTION fn_pf_item_save(uuid, uuid, text, bigint, bigint, int, int);
DROP FUNCTION _pf_gnf_account(uuid, uuid);
DROP TABLE pf_cash_close; DROP TABLE pf_sale_lines; DROP TABLE pf_sales; DROP TABLE pf_items;
DELETE FROM schema_migrations WHERE name = '061_boutique.sql';
