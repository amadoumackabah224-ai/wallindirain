-- =====================================================================
-- Wallindirain : schéma PostgreSQL (migration 001)
-- Montants : entiers en GNF (bigint). Suppressions : logiques (deleted_at).
-- Les tables sensibles sont en ajout seul (UPDATE/DELETE interdits par trigger).
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- Types ----------
CREATE TYPE user_role AS ENUM
  ('admin','supplier','seller','agent','call_chief','courier','warehouse','system');
CREATE TYPE user_status AS ENUM ('pending','active','suspended');
CREATE TYPE storage_mode AS ENUM ('wallindirain','supplier');
CREATE TYPE product_status AS ENUM ('pending','approved','rejected','archived');
CREATE TYPE order_status AS ENUM
  ('new','in_call','confirmed','assigned','picked_up','on_the_way','delivered',
   'failed','return_pending','returned','refused','cancelled');
CREATE TYPE call_result AS ENUM ('confirmed','unreachable','refused');
CREATE TYPE return_cause AS ENUM ('customer_refusal','defective','damaged_transport');
CREATE TYPE withdrawal_status AS ENUM ('pending_code','requested','paid','rejected','expired');

-- ---------- Utilisateurs ----------
CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role             user_role   NOT NULL,
  status           user_status NOT NULL DEFAULT 'pending',
  full_name        text        NOT NULL CHECK (length(trim(full_name)) >= 2),
  phone            text        NOT NULL UNIQUE CHECK (phone ~ '^[0-9]{9}$' OR role = 'system'),
  password_hash    text        NOT NULL,
  team             text,                       -- nom du call center (agents / chefs)
  identity_doc     text,                       -- référence de la pièce d'identité
  identity_verified boolean    NOT NULL DEFAULT false,
  failed_attempts  int         NOT NULL DEFAULT 0,
  locked_until     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);

CREATE TABLE sessions (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE one_time_codes (       -- mot de passe oublié, retrait
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  purpose     text NOT NULL CHECK (purpose IN ('password_reset','withdrawal')),
  code_hash   text NOT NULL,
  attempts    int  NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  ref_id      uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- Réglages et tarifs ----------
CREATE TABLE settings (
  key    text PRIMARY KEY,
  value  bigint NOT NULL,
  label  text   NOT NULL
);
INSERT INTO settings(key, value, label) VALUES
  ('margin_bps',        1500,   'Marge Wallindirain (points de base, 1500 = 15 %)'),
  ('call_fee',          5000,   'Frais de call center par commande (GNF)'),
  ('agent_pay',         1000,   'Rémunération agent par commande confirmée (GNF)'),
  ('courier_pay',       5000,   'Rémunération livreur par livraison (GNF)'),
  ('unlock_hours',      48,     'Délai de déblocage des gains (heures)'),
  ('min_withdrawal',    50000,  'Retrait minimum (GNF)'),
  ('code_max_attempts', 5,      'Essais maximum du code de livraison'),
  ('call_attempt_limit',5,      'Appels injoignables avant escalade au chef');

CREATE TABLE delivery_rates (
  commune text PRIMARY KEY,
  fee     bigint NOT NULL CHECK (fee >= 0)
);
INSERT INTO delivery_rates(commune, fee) VALUES
  ('Kaloum',25000),('Dixinn',25000),('Matam',25000),('Ratoma',30000),('Matoto',30000);

-- ---------- Catalogue ----------
CREATE TABLE products (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id     uuid NOT NULL REFERENCES users(id),
  name            text NOT NULL CHECK (length(trim(name)) >= 2),
  description     text,
  supplier_price  bigint NOT NULL CHECK (supplier_price > 0),
  margin_unit     bigint CHECK (margin_unit >= 0),   -- figée à la validation du produit
  storage         storage_mode NOT NULL,
  stock_qty       int NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),    -- vendable, non acheté
  reserved_qty    int NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0),
  status          product_status NOT NULL DEFAULT 'pending',
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  CHECK (reserved_qty <= stock_qty)
);
CREATE INDEX products_supplier_idx ON products(supplier_id);

CREATE TABLE arrivals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id     uuid NOT NULL REFERENCES products(id),
  announced_qty  int NOT NULL CHECK (announced_qty > 0),
  counted_qty    int CHECK (counted_qty >= 0),
  counted_by     uuid REFERENCES users(id),
  counted_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE seller_prices (
  seller_id   uuid NOT NULL REFERENCES users(id),
  product_id  uuid NOT NULL REFERENCES products(id),
  sale_price  bigint NOT NULL CHECK (sale_price > 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (seller_id, product_id)
);

CREATE TABLE seller_stock (
  seller_id    uuid NOT NULL REFERENCES users(id),
  product_id   uuid NOT NULL REFERENCES products(id),
  qty          int NOT NULL DEFAULT 0 CHECK (qty >= 0),
  reserved_qty int NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0),
  PRIMARY KEY (seller_id, product_id),
  CHECK (reserved_qty <= qty)
);

CREATE TABLE seller_links (
  code        text PRIMARY KEY,
  seller_id   uuid NOT NULL REFERENCES users(id),
  product_id  uuid NOT NULL REFERENCES products(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (seller_id, product_id)
);

-- ---------- Commandes ----------
CREATE SEQUENCE order_ref_seq START 1000;

CREATE TABLE orders (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref                  text NOT NULL UNIQUE DEFAULT ('WLD-' || nextval('order_ref_seq')),
  seller_id            uuid NOT NULL REFERENCES users(id),
  product_id           uuid REFERENCES products(id),      -- NULL pour la formule C
  own_product_name     text,                              -- formule C
  formula              text NOT NULL CHECK (formula IN ('A','B','AB','C')),
  source               text NOT NULL CHECK (source IN ('public_link','seller')),
  qty                  int  NOT NULL CHECK (qty > 0 AND qty <= 100),
  qty_from_seller      int  NOT NULL DEFAULT 0 CHECK (qty_from_seller >= 0),
  qty_from_catalog     int  NOT NULL DEFAULT 0 CHECK (qty_from_catalog >= 0),
  customer_name        text NOT NULL CHECK (length(trim(customer_name)) >= 2),
  customer_phone       text NOT NULL CHECK (customer_phone ~ '^[0-9]{9}$'),
  commune              text NOT NULL REFERENCES delivery_rates(commune),
  address              text NOT NULL CHECK (length(trim(address)) >= 3),
  note                 text,
  -- montants figés à la création
  sale_total           bigint NOT NULL CHECK (sale_total > 0),
  supplier_unit_price  bigint NOT NULL DEFAULT 0,
  margin_unit          bigint NOT NULL DEFAULT 0,
  seller_unit_price    bigint NOT NULL DEFAULT 0,          -- prix vendeur = fournisseur + marge
  delivery_fee         bigint NOT NULL,
  call_fee             bigint NOT NULL,
  agent_pay            bigint NOT NULL,
  courier_pay          bigint NOT NULL,
  unlock_hours         int    NOT NULL,
  delivery_code_hash   text   NOT NULL,
  -- suivi
  status               order_status NOT NULL DEFAULT 'new',
  locked_by            uuid REFERENCES users(id),
  locked_at            timestamptz,
  confirmed_by         uuid REFERENCES users(id),
  courier_id           uuid REFERENCES users(id),
  assigned_by          uuid REFERENCES users(id),
  call_attempts        int NOT NULL DEFAULT 0,
  escalated            boolean NOT NULL DEFAULT false,
  risk_flag            boolean NOT NULL DEFAULT false,
  code_attempts        int NOT NULL DEFAULT 0,
  failure_reason       text,
  return_cause         return_cause,
  created_at           timestamptz NOT NULL DEFAULT now(),
  confirmed_at         timestamptz,
  delivered_at         timestamptz,
  closed_at            timestamptz,
  CHECK (qty = qty_from_seller + qty_from_catalog OR formula = 'C'),
  CHECK ((formula = 'C' AND product_id IS NULL AND own_product_name IS NOT NULL)
      OR (formula <> 'C' AND product_id IS NOT NULL))
);
CREATE INDEX orders_status_idx   ON orders(status);
CREATE INDEX orders_seller_idx   ON orders(seller_id);
CREATE INDEX orders_courier_idx  ON orders(courier_id);
CREATE INDEX orders_phone_idx    ON orders(customer_phone);

CREATE TABLE order_secrets (          -- code en clair, supprimé en fin de vie de la commande
  order_id uuid PRIMARY KEY REFERENCES orders(id),
  code     text NOT NULL
);

CREATE TABLE order_history (
  id         bigserial PRIMARY KEY,
  order_id   uuid NOT NULL REFERENCES orders(id),
  from_status order_status,
  to_status  order_status NOT NULL,
  actor_id   uuid REFERENCES users(id),
  note       text,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_history_order_idx ON order_history(order_id);

CREATE TABLE calls (
  id           bigserial PRIMARY KEY,
  order_id     uuid NOT NULL REFERENCES orders(id),
  agent_id     uuid NOT NULL REFERENCES users(id),
  agent_name   text NOT NULL,
  call_center  text NOT NULL,
  result       call_result NOT NULL,
  note         text,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX calls_order_idx ON calls(order_id);

CREATE TABLE risky_customers (
  customer_phone text PRIMARY KEY,
  incidents      int NOT NULL DEFAULT 1,
  last_reason    text NOT NULL,
  last_order_id  uuid REFERENCES orders(id),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------- Argent ----------
CREATE TABLE wallet_entries (
  id            bigserial PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id),
  kind          text NOT NULL,
  amount        bigint NOT NULL CHECK (amount <> 0),
  order_id      uuid REFERENCES orders(id),
  available_at  timestamptz NOT NULL DEFAULT now(),
  description   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wallet_user_idx ON wallet_entries(user_id);
CREATE INDEX wallet_order_idx ON wallet_entries(order_id);

CREATE TABLE withdrawals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id),
  amount         bigint NOT NULL CHECK (amount > 0),
  method         text NOT NULL CHECK (method IN ('orange_money','mtn_momo')),
  account_number text NOT NULL CHECK (account_number ~ '^[0-9]{9}$'),
  status         withdrawal_status NOT NULL DEFAULT 'pending_code',
  payment_ref    text,
  decided_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  decided_at     timestamptz
);

CREATE TABLE courier_cash_entries (
  id         bigserial PRIMARY KEY,
  courier_id uuid NOT NULL REFERENCES users(id),
  order_id   uuid NOT NULL REFERENCES orders(id) UNIQUE,
  amount     bigint NOT NULL CHECK (amount > 0),
  count_id   uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cash_counts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  courier_id  uuid NOT NULL REFERENCES users(id),
  admin_id    uuid NOT NULL REFERENCES users(id),
  expected    bigint NOT NULL,
  counted     bigint NOT NULL CHECK (counted >= 0),
  shortage    bigint NOT NULL,
  surplus     bigint NOT NULL,
  at          timestamptz NOT NULL DEFAULT now()
);

-- ---------- Contrôle ----------
CREATE TABLE audit_log (
  id        bigserial PRIMARY KEY,
  actor_id  uuid REFERENCES users(id),
  action    text NOT NULL,
  entity    text,
  entity_id text,
  details   jsonb NOT NULL DEFAULT '{}'::jsonb,
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_action_idx ON audit_log(action);

CREATE TABLE messages (               -- WhatsApp / SMS tracés
  id         bigserial PRIMARY KEY,
  to_phone   text NOT NULL,
  channel    text NOT NULL DEFAULT 'whatsapp',
  template   text NOT NULL,
  body       text NOT NULL,
  order_id   uuid REFERENCES orders(id),
  status     text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','simulated','failed')),
  error      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz
);
CREATE INDEX messages_status_idx ON messages(status);

-- ---------- Protections d'intégrité ----------
CREATE FUNCTION trg_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % en ajout seul : % interdit', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END $$;

CREATE TRIGGER wallet_entries_immutable BEFORE UPDATE OR DELETE ON wallet_entries
  FOR EACH ROW EXECUTE FUNCTION trg_append_only();
CREATE TRIGGER order_history_immutable BEFORE UPDATE OR DELETE ON order_history
  FOR EACH ROW EXECUTE FUNCTION trg_append_only();
CREATE TRIGGER calls_immutable BEFORE UPDATE OR DELETE ON calls
  FOR EACH ROW EXECUTE FUNCTION trg_append_only();
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION trg_append_only();
CREATE TRIGGER cash_counts_immutable BEFORE UPDATE OR DELETE ON cash_counts
  FOR EACH ROW EXECUTE FUNCTION trg_append_only();

-- Pas de suppression physique sur les tables métier
CREATE TRIGGER users_no_delete    BEFORE DELETE ON users    FOR EACH ROW EXECUTE FUNCTION trg_append_only();
CREATE TRIGGER products_no_delete BEFORE DELETE ON products FOR EACH ROW EXECUTE FUNCTION trg_append_only();
CREATE TRIGGER orders_no_delete   BEFORE DELETE ON orders   FOR EACH ROW EXECUTE FUNCTION trg_append_only();
CREATE TRIGGER withdrawals_no_delete BEFORE DELETE ON withdrawals FOR EACH ROW EXECUTE FUNCTION trg_append_only();

-- Prix, frais et code figés dans la commande
CREATE FUNCTION trg_orders_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sale_total          IS DISTINCT FROM OLD.sale_total
  OR NEW.supplier_unit_price IS DISTINCT FROM OLD.supplier_unit_price
  OR NEW.margin_unit         IS DISTINCT FROM OLD.margin_unit
  OR NEW.seller_unit_price   IS DISTINCT FROM OLD.seller_unit_price
  OR NEW.delivery_fee        IS DISTINCT FROM OLD.delivery_fee
  OR NEW.call_fee            IS DISTINCT FROM OLD.call_fee
  OR NEW.agent_pay           IS DISTINCT FROM OLD.agent_pay
  OR NEW.courier_pay         IS DISTINCT FROM OLD.courier_pay
  OR NEW.unlock_hours        IS DISTINCT FROM OLD.unlock_hours
  OR NEW.delivery_code_hash  IS DISTINCT FROM OLD.delivery_code_hash
  OR NEW.qty                 IS DISTINCT FROM OLD.qty
  OR NEW.seller_id           IS DISTINCT FROM OLD.seller_id
  OR NEW.product_id          IS DISTINCT FROM OLD.product_id
  OR NEW.formula             IS DISTINCT FROM OLD.formula
  OR NEW.commune             IS DISTINCT FROM OLD.commune
  OR NEW.customer_phone      IS DISTINCT FROM OLD.customer_phone THEN
    RAISE EXCEPTION 'montants et identité de la commande figés après création'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_frozen BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION trg_orders_frozen();

-- Compte rôle applicatif : n'a accès qu'aux fonctions (voir migration 003)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wld_app') THEN
    CREATE ROLE wld_app NOLOGIN;
  END IF;
END $$;
