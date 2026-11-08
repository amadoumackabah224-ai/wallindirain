-- 052 : nouveau rôle « membre » (personne qui veut seulement gérer son argent dans Mes finances, sans utiliser les services de livraison).
-- Cette migration ne fait qu'ajouter la valeur au type de rôle ; elle est utilisée par la 053 (une valeur ajoutée ne peut pas servir dans la même transaction).
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'member';
