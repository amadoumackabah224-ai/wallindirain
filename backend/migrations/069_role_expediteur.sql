-- 069 : nouveau rôle « expéditeur » (personne qui fait livrer un colis sans être vendeur).
-- Cette migration ne fait qu'ajouter la valeur au type de rôle ; elle est utilisée par la 070 (une valeur ajoutée ne peut pas servir dans la même transaction).
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'shipper';
