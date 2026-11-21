-- 084 : style visuel « bulles » (boutons en verre coloré, barre du bas flottante, cartes arrondies). Apparence seulement :
-- aucun effet sur les données, les droits ni l'argent. Réglage feature_style_bulles, éteint par défaut (Réglages > Fonctions).
-- Retour arrière : docs/retour-arriere-084.sql.
INSERT INTO settings(key, value, label) VALUES
  ('feature_style_bulles', 0, 'Style visuel « bulles » : 1 = oui, 0 = non')
ON CONFLICT (key) DO NOTHING;
