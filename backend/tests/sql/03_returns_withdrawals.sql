\set ON_ERROR_STOP on
INSERT INTO users(role,status,full_name,phone,password_hash,identity_verified) VALUES ('admin','active','Admin','600000001','x',true);
DO $$
DECLARE adm uuid := (SELECT id FROM users WHERE phone='600000001'); sup uuid; sel uuid; ag uuid; ag2 uuid; chief uuid; cou uuid; wh uuid;
  pid uuid; o1 uuid; o2 uuid; o3 uuid; o4 uuid; r jsonb; code text; wid uuid; a uuid; bal bigint;
BEGIN
  sup := fn_register('600000002','Fournisseur','supplier','x','CNI-0001'); PERFORM fn_admin_set_user_status(adm,sup,'active');
  sel := fn_register('600000003','Vendeur','seller','x','CNI-0002');   PERFORM fn_admin_set_user_status(adm,sel,'active');
  ag  := fn_admin_create_staff(adm,'600000004','Agent1','agent','x','CC');
  ag2 := fn_admin_create_staff(adm,'600000005','Agent2','agent','x','CC');
  chief := fn_admin_create_staff(adm,'600000009','Chef','call_chief','x','CC');
  cou := fn_admin_create_staff(adm,'600000006','Livreur','courier','x');
  wh  := fn_admin_create_staff(adm,'600000007','Mag','warehouse','x');

  -- stock chez Wallindirain : annonce 10, magasinier compte 8, seuls 8 sont vendables
  pid := fn_supplier_add_product(sup,'Sac','d',60000,'wallindirain',0); PERFORM fn_admin_review_product(adm,pid,true);
  a := fn_supplier_announce_arrival(sup,pid,10); PERFORM fn_warehouse_count_arrival(wh,a,8);
  IF (SELECT stock_qty FROM products WHERE id=pid) <> 8 THEN RAISE EXCEPTION 'stock compté attendu 8'; END IF;
  PERFORM fn_seller_set_price(sel,pid,150000);

  -- achat de stock sans fonds : refusé ; puis dépôt, achat 2 x 69000 = 138000
  BEGIN PERFORM fn_seller_buy_stock(sel,pid,2); RAISE EXCEPTION 'achat sans fonds'; EXCEPTION WHEN SQLSTATE 'WLD01' THEN NULL; END;
  PERFORM fn_admin_deposit(adm,sel,200000,'OM-123');
  PERFORM fn_seller_buy_stock(sel,pid,2);
  IF _wallet_available(sel) <> 62000 THEN RAISE EXCEPTION 'solde après achat attendu 62000, vu %', _wallet_available(sel); END IF;

  -- verrou : un seul agent
  r := fn_seller_create_order(sel,pid,NULL,NULL,1,'C1','620000001','Kaloum','Rue 1 Test',NULL); o1 := (r->>'id')::uuid;
  IF r->>'formula' <> 'B' THEN RAISE EXCEPTION 'formule B attendue (stock vendeur), vu %', r->>'formula'; END IF;
  PERFORM fn_agent_take_order(ag,o1);
  BEGIN PERFORM fn_agent_take_order(ag2,o1); RAISE EXCEPTION 'deux agents sur la même commande'; EXCEPTION WHEN SQLSTATE 'WLD01' THEN NULL; END;
  BEGIN PERFORM fn_agent_log_call(ag2,o1,'confirmed',NULL); RAISE EXCEPTION 'appel signé par un autre agent'; EXCEPTION WHEN SQLSTATE 'WLD01' THEN NULL; END;

  -- le vendeur ne peut plus annuler une commande déjà prise
  BEGIN PERFORM fn_seller_cancel_order(sel,o1); RAISE EXCEPTION 'annulation après prise'; EXCEPTION WHEN SQLSTATE 'WLD01' THEN NULL; END;

  -- 1) refus du client au retour : le vendeur paie livraison + call center, stock libéré
  PERFORM fn_agent_log_call(ag,o1,'confirmed',NULL); PERFORM fn_chief_assign(chief,o1,cou);
  PERFORM fn_courier_pickup(cou,o1); PERFORM fn_courier_depart(cou,o1); PERFORM fn_courier_fail(cou,o1,'customer_refusal');
  PERFORM fn_chief_return_to_warehouse(chief,o1);
  bal := _wallet_available(sel);
  PERFORM fn_warehouse_receive_return(wh,o1,'customer_refusal');
  IF _wallet_available(sel) <> bal - (25000+5000) THEN RAISE EXCEPTION 'frais de retour vendeur attendus 30000'; END IF;
  IF (SELECT reserved_qty FROM seller_stock WHERE seller_id=sel) <> 0 OR (SELECT qty FROM seller_stock WHERE seller_id=sel) <> 2 THEN RAISE EXCEPTION 'stock vendeur non remis'; END IF;
  IF NOT EXISTS (SELECT 1 FROM risky_customers WHERE customer_phone='620000001') THEN RAISE EXCEPTION 'client non signalé'; END IF;
  -- le même client est signalé à l'agent
  r := fn_seller_create_order(sel,pid,NULL,NULL,1,'C1','620000001','Kaloum','Rue 1 Test',NULL);
  IF NOT (SELECT risk_flag FROM orders WHERE id=(r->>'id')::uuid) THEN RAISE EXCEPTION 'risque non signalé'; END IF;
  PERFORM fn_seller_cancel_order(sel,(r->>'id')::uuid);

  -- 2) défectueux : le fournisseur paie la livraison, le vendeur récupère son stock prépayé, pas de remise en stock
  r := fn_seller_create_order(sel,pid,NULL,NULL,1,'C2','620000002','Matoto','Rue 2 Test',NULL); o2 := (r->>'id')::uuid;
  PERFORM fn_agent_take_order(ag,o2); PERFORM fn_agent_log_call(ag,o2,'confirmed',NULL); PERFORM fn_chief_assign(chief,o2,cou);
  PERFORM fn_courier_pickup(cou,o2); PERFORM fn_courier_depart(cou,o2); PERFORM fn_courier_fail(cou,o2,'other');
  PERFORM fn_chief_return_to_warehouse(chief,o2);
  bal := _wallet_available(sel);
  PERFORM fn_warehouse_receive_return(wh,o2,'defective');
  IF _wallet_available(sel) <> bal + 69000 THEN RAISE EXCEPTION 'remboursement stock prépayé attendu 69000'; END IF;
  IF _wallet_pending(sup) <> 0 AND EXISTS (SELECT 1 FROM wallet_entries WHERE user_id=sup AND kind='return_fee_supplier' AND amount <> -30000) THEN RAISE EXCEPTION 'frais fournisseur attendus 30000'; END IF;
  IF (SELECT qty FROM seller_stock WHERE seller_id=sel) <> 1 THEN RAISE EXCEPTION 'stock défectueux non retiré'; END IF;

  -- 3) abîmé en transport : à la charge de Wallindirain
  r := fn_seller_create_order(sel,pid,NULL,NULL,1,'C3','620000003','Dixinn','Rue 3 Test',NULL); o3 := (r->>'id')::uuid;
  PERFORM fn_agent_take_order(ag,o3); PERFORM fn_agent_log_call(ag,o3,'confirmed',NULL); PERFORM fn_chief_assign(chief,o3,cou);
  PERFORM fn_courier_pickup(cou,o3); PERFORM fn_courier_depart(cou,o3); PERFORM fn_courier_fail(cou,o3,'other');
  PERFORM fn_chief_return_to_warehouse(chief,o3);
  PERFORM fn_warehouse_receive_return(wh,o3,'damaged_transport');
  IF (SELECT status FROM orders WHERE id=o3) <> 'returned' THEN RAISE EXCEPTION 'retour non clos'; END IF;

  -- livraison avec code : 5 essais puis blocage
  r := fn_seller_create_order(sel,pid,NULL,NULL,1,'C4','620000004','Matam','Rue 4 Test',NULL); o4 := (r->>'id')::uuid;
  PERFORM fn_agent_take_order(ag,o4); PERFORM fn_agent_log_call(ag,o4,'confirmed',NULL); PERFORM fn_chief_assign(chief,o4,cou);
  PERFORM fn_courier_pickup(cou,o4); PERFORM fn_courier_depart(cou,o4);
  SELECT s.code INTO code FROM order_secrets s WHERE order_id=o4;
  FOR i IN 1..5 LOOP r := fn_courier_deliver(cou,o4,CASE WHEN code='9999' THEN '8888' ELSE '9999' END); END LOOP;
  IF NOT (r->>'locked')::boolean THEN RAISE EXCEPTION 'blocage après 5 essais attendu'; END IF;
  r := fn_courier_deliver(cou,o4,code);   -- même le bon code est refusé une fois bloqué
  IF (r->>'ok')::boolean THEN RAISE EXCEPTION 'livraison possible après blocage'; END IF;
  PERFORM fn_courier_fail(cou,o4,'other');   -- bloqué : le livreur doit signaler l'échec
  PERFORM fn_chief_assign(chief,o4,cou);  -- le chef décide et réaffecte : compteur remis à zéro
  PERFORM fn_courier_pickup(cou,o4); PERFORM fn_courier_depart(cou,o4);
  r := fn_courier_deliver(cou,o4,code);
  IF NOT (r->>'ok')::boolean THEN RAISE EXCEPTION 'livraison impossible après réaffectation'; END IF;

  -- retraits : identité non vérifiée => impossible
  BEGIN PERFORM fn_withdrawal_request(sel,50000,'orange_money','622000000'); RAISE EXCEPTION 'retrait sans identité vérifiée'; EXCEPTION WHEN SQLSTATE 'WLD01' THEN NULL; END;
  PERFORM fn_admin_verify_identity(adm,sel,true);
  BEGIN PERFORM fn_withdrawal_request(sel,49999,'orange_money','622000000'); RAISE EXCEPTION 'sous le minimum'; EXCEPTION WHEN SQLSTATE 'WLD01' THEN NULL; END;
  BEGIN PERFORM fn_withdrawal_request(sel,900000,'orange_money','622000000'); RAISE EXCEPTION 'solde dépassé'; EXCEPTION WHEN SQLSTATE 'WLD01' THEN NULL; END;
  bal := _wallet_available(sel);
  wid := fn_withdrawal_request(sel,60000,'orange_money','622000000');
  IF _wallet_available(sel) <> bal THEN RAISE EXCEPTION 'solde débité avant le code'; END IF;
  r := fn_withdrawal_confirm(sel,wid,'000000');
  SELECT (regexp_match(body,'est ([0-9]{6})|: ([0-9]{6})\.'))[2] INTO code FROM messages WHERE template='withdrawal_code' ORDER BY id DESC LIMIT 1;
  IF code = '000000' THEN code := '000001'; END IF;
  IF (r->>'ok')::boolean THEN RAISE EXCEPTION 'retrait confirmé avec un mauvais code'; END IF;
  r := fn_withdrawal_confirm(sel,wid,code);
  IF NOT (r->>'ok')::boolean THEN RAISE EXCEPTION 'code correct refusé: %', r; END IF;
  IF _wallet_available(sel) <> bal - 60000 THEN RAISE EXCEPTION 'solde après retrait'; END IF;
  PERFORM fn_admin_reject_withdrawal(adm,wid,'compte invalide');
  IF _wallet_available(sel) <> bal THEN RAISE EXCEPTION 'remboursement du retrait refusé'; END IF;

  -- contrôle d'ensemble : tous les mouvements des comptes (sans la caisse en espèces) sont cohérents
  IF EXISTS (SELECT 1 FROM fn_ledger_check()) THEN RAISE EXCEPTION 'ledger_check non vide: %', (SELECT string_agg(problem||':'||detail, ', ') FROM fn_ledger_check()); END IF;
  RAISE NOTICE 'OK : stock prépayé, 3 types de retour, code de livraison, retraits';
END $$;
