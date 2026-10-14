-- Test de bout en bout : exemple du cahier des charges (formule A, 150 000 GNF, Ratoma)
-- fournisseur 60 000 + marge 9 000 + livraison 30 000 + call center 5 000 + vendeur 46 000
\set ON_ERROR_STOP on
SET client_min_messages = notice;
DO $$
DECLARE
  adm uuid; sup uuid; sel uuid; ag uuid; chief uuid; cou uuid; wh uuid;
  pid uuid; r jsonb; oid uuid; v_code text; v_ref text;
  v_exp bigint;
  function_name text;
BEGIN
  -- comptes
  adm   := fn_admin_create_staff((SELECT id FROM users WHERE false), '600000001','Admin','admin','x') ;
EXCEPTION WHEN OTHERS THEN NULL;  -- le premier admin est créé hors fonction (voir bloc suivant)
END $$;

-- Premier administrateur (amorçage, comme le fera le script d'installation)
INSERT INTO users(role,status,full_name,phone,password_hash,identity_verified)
VALUES ('admin','active','Admin Test','600000001','x',true);

DO $$
DECLARE
  adm uuid := (SELECT id FROM users WHERE phone='600000001');
  sup uuid; sel uuid; ag uuid; chief uuid; cou uuid; wh uuid;
  pid uuid; r jsonb; oid uuid; v_code text; v_ref text; a_id uuid;
  v_plat bigint; v_sel bigint; v_sup bigint; v_cash jsonb;
BEGIN
  sup   := fn_register('600000002','Fournisseur','supplier','x','CNI-1234');
  sel   := fn_register('600000003','Vendeur','seller','x','CNI-5678');
  PERFORM fn_admin_set_user_status(adm, sup, 'active');
  PERFORM fn_admin_set_user_status(adm, sel, 'active');
  ag    := fn_admin_create_staff(adm,'600000004','Agent Un','agent','x','CallPlus');
  chief := fn_admin_create_staff(adm,'600000005','Chef','call_chief','x','CallPlus');
  cou   := fn_admin_create_staff(adm,'600000006','Livreur','courier','x');
  wh    := fn_admin_create_staff(adm,'600000007','Magasinier','warehouse','x');

  -- produit à 60 000 (stock chez le fournisseur), marge 15 % => 9 000
  pid := fn_supplier_add_product(sup,'Montre','Montre test',60000,'supplier',10);
  PERFORM fn_admin_review_product(adm, pid, true);
  IF (SELECT margin_unit FROM products WHERE id=pid) <> 9000 THEN RAISE EXCEPTION 'marge attendue 9000'; END IF;

  -- prix minimum = 60000+9000+5000+30000 = 104000 ; 150000 accepté, 103999 refusé
  PERFORM fn_seller_set_price(sel, pid, 150000);
  BEGIN
    PERFORM fn_seller_set_price(sel, pid, 103999);
    RAISE EXCEPTION 'prix trop bas accepté';
  EXCEPTION WHEN SQLSTATE 'WLD01' THEN NULL; END;
  PERFORM fn_seller_set_price(sel, pid, 104000);
  PERFORM fn_seller_set_price(sel, pid, 150000);

  -- commande publique via lien
  r := fn_public_order(fn_seller_create_link(sel, pid), 1, 'Client Test', '620000001', 'Ratoma', 'Rue 12');
  v_ref := r->>'ref';
  SELECT id INTO oid FROM orders WHERE ref = v_ref;
  IF (SELECT sale_total FROM orders WHERE id=oid) <> 150000 THEN RAISE EXCEPTION 'total attendu 150000'; END IF;

  -- commande identique en cours : refusée
  BEGIN
    PERFORM fn_public_order(fn_seller_create_link(sel, pid), 1, 'Client Test', '620000001', 'Ratoma', 'Rue 12');
    RAISE EXCEPTION 'doublon accepté';
  EXCEPTION WHEN SQLSTATE 'WLD01' THEN NULL; END;

  -- appel
  PERFORM fn_agent_take_order(ag, oid);
  PERFORM fn_agent_log_call(ag, oid, 'confirmed', 'ok');
  SELECT code INTO v_code FROM order_secrets WHERE order_id = oid;
  IF NOT EXISTS (SELECT 1 FROM messages WHERE order_id=oid AND body LIKE '%'||v_code||'%') THEN RAISE EXCEPTION 'code non envoyé au client'; END IF;

  -- affectation + livraison, mauvais code d'abord
  PERFORM fn_chief_assign(chief, oid, cou);
  PERFORM fn_courier_pickup(cou, oid);
  PERFORM fn_courier_depart(cou, oid);
  r := fn_courier_deliver(cou, oid, CASE WHEN v_code='0000' THEN '1111' ELSE '0000' END);
  IF (r->>'ok')::boolean THEN RAISE EXCEPTION 'livré avec un mauvais code'; END IF;
  r := fn_courier_deliver(cou, oid, v_code);
  IF NOT (r->>'ok')::boolean THEN RAISE EXCEPTION 'livraison refusée avec le bon code'; END IF;

  -- argent : le gain vendeur est bloqué 48 h
  IF _wallet_available(sel) <> 0 OR _wallet_pending(sel) <> 46000 THEN RAISE EXCEPTION 'gain vendeur attendu 46000 en attente, vu % / %', _wallet_available(sel), _wallet_pending(sel); END IF;
  IF _wallet_pending(sup) <> 60000 THEN RAISE EXCEPTION 'fournisseur attendu 60000'; END IF;
  -- résultat Wallindirain : 44000 brut - 1000 agent - 5000 livreur = 38000
  v_plat := _wallet_available(_platform());
  IF v_plat <> 38000 THEN RAISE EXCEPTION 'résultat Wallindirain attendu 38000, vu %', v_plat; END IF;
  IF _wallet_available(ag) <> 1000 OR _wallet_available(cou) <> 5000 THEN RAISE EXCEPTION 'rémunérations incorrectes'; END IF;

  -- caisse : manque de 10 000 débité au livreur
  v_cash := fn_admin_count_cash(adm, cou, 140000);
  IF (v_cash->>'shortage')::bigint <> 10000 OR _wallet_available(cou) <> 5000 - 10000 THEN RAISE EXCEPTION 'manque de caisse mal traité'; END IF;

  -- code usage unique : secret détruit
  IF EXISTS (SELECT 1 FROM order_secrets WHERE order_id=oid) THEN RAISE EXCEPTION 'code non détruit'; END IF;

  -- un tarif modifié ne touche pas la commande passée
  PERFORM fn_admin_set_delivery_rate(adm,'Ratoma',99000);
  IF (SELECT delivery_fee FROM orders WHERE id=oid) <> 30000 THEN RAISE EXCEPTION 'tarif rétroactif'; END IF;
  PERFORM fn_admin_set_delivery_rate(adm,'Ratoma',30000);

  -- immutabilité
  BEGIN UPDATE wallet_entries SET amount = 1; RAISE EXCEPTION 'portefeuille modifiable';
  EXCEPTION WHEN integrity_constraint_violation THEN NULL; END;
  BEGIN UPDATE orders SET sale_total = 1 WHERE id = oid; RAISE EXCEPTION 'montant modifiable';
  EXCEPTION WHEN integrity_constraint_violation THEN NULL; END;

  -- contrôle comptable global
  IF EXISTS (SELECT 1 FROM fn_ledger_check()) THEN RAISE EXCEPTION 'ledger_check non vide'; END IF;
  -- la somme de tous les mouvements = argent encaissé (150000) moins l'argent déjà débité (manque 10000 rattrape côté plateforme)
  RAISE NOTICE 'OK : exemple du cahier des charges validé (résultat Wallindirain 38 000 GNF)';
END $$;
