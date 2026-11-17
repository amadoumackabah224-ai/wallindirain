-- Retour arrière de la migration 073 (finances de la société). À jouer en tant que propriétaire de la base.
-- Retire la liaison automatique du portefeuille de la plateforme, puis les catégories propres à l'entreprise.
-- Refuse de supprimer une catégorie déjà utilisée par une transaction, un budget ou un paiement planifié (rien n'est perdu).
BEGIN;
DO $$
DECLARE d text; i int := 0; j int;
BEGIN
  d := pg_get_viewdef('pf_all_tx_raw'::regclass, false);
  d := regexp_replace(d, '[;[:space:]]+$', '');
  LOOP j := position('UNION ALL' in substr(d, i + 1)); EXIT WHEN j = 0; i := i + j + 8; END LOOP;   -- dernière occurrence : notre branche
  IF i = 0 THEN RAISE EXCEPTION 'pf_all_tx_raw : texte inattendu'; END IF;
  EXECUTE 'CREATE OR REPLACE VIEW pf_all_tx_raw AS ' || substr(d, 1, i - 9);
END $$;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pf_transactions WHERE category LIKE 'co\_%')
     OR EXISTS (SELECT 1 FROM pf_budgets WHERE category LIKE 'co\_%')
     OR EXISTS (SELECT 1 FROM pf_recurring WHERE category LIKE 'co\_%') THEN
    RAISE EXCEPTION 'Retour arrière refusé : des catégories de l''entreprise sont utilisées. Rien n''a été supprimé.';
  END IF;
END $$;
DELETE FROM pf_cat_system WHERE key LIKE 'co\_%';
DELETE FROM schema_migrations WHERE name = '073_finances_societe.sql';
COMMIT;
