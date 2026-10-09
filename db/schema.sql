CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username varchar(20) NOT NULL,
  email varchar(254) NOT NULL,
  password_hash varchar(100) NOT NULL,
  session_version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE UNIQUE INDEX users_username_ci ON users (lower(username));
CREATE UNIQUE INDEX users_email_ci ON users (lower(email));

CREATE TABLE player_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  territory text NOT NULL DEFAULT 'docks',
  level integer NOT NULL DEFAULT 1 CHECK (level > 0),
  xp bigint NOT NULL DEFAULT 0 CHECK (xp >= 0),
  health integer NOT NULL DEFAULT 100,
  energy integer NOT NULL DEFAULT 100,
  energy_updated_at timestamptz NOT NULL DEFAULT now(),
  nerve integer NOT NULL DEFAULT 100,
  nerve_updated_at timestamptz NOT NULL DEFAULT now(),
  credits bigint NOT NULL DEFAULT 1000,
  reputation integer NOT NULL DEFAULT 0,
  bounty bigint NOT NULL DEFAULT 0,
  stats jsonb NOT NULL DEFAULT '{"strength":5,"cunning":5,"influence":5}',
  inventory jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(32) NOT NULL,
  territory text NOT NULL,
  credits bigint NOT NULL DEFAULT 0 CHECK (credits >= 0),
  total_shares integer NOT NULL DEFAULT 1000 CHECK (total_shares > 0),
  treasury_shares integer NOT NULL DEFAULT 0 CHECK (treasury_shares >= 0 AND treasury_shares <= total_shares),
  reputation integer NOT NULL DEFAULT 0,
  founded_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX companies_name_ci ON companies (lower(name));

CREATE TABLE company_members (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  npc_id text,
  role text NOT NULL CHECK (role IN ('ceo', 'cfo', 'employee')),
  shares integer NOT NULL DEFAULT 0 CHECK (shares >= 0),
  wage_per_minute bigint NOT NULL DEFAULT 0 CHECK (wage_per_minute >= 0),
  joined_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(user_id, npc_id) = 1)
);
CREATE UNIQUE INDEX company_user_membership ON company_members(company_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX company_npc_membership ON company_members(company_id, npc_id) WHERE npc_id IS NOT NULL;
CREATE UNIQUE INDEX company_single_ceo ON company_members(company_id) WHERE role = 'ceo';

CREATE TABLE company_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  asset_type text NOT NULL,
  name text NOT NULL,
  purchase_cost bigint NOT NULL,
  income_per_minute bigint NOT NULL,
  purchased_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE company_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payer_company_id uuid NOT NULL REFERENCES companies(id),
  payee_company_id uuid NOT NULL REFERENCES companies(id),
  amount_per_minute bigint NOT NULL CHECK (amount_per_minute > 0),
  status text NOT NULL CHECK (status IN ('offered', 'active', 'cancelled')),
  offered_at timestamptz NOT NULL DEFAULT now(),
  signed_at timestamptz,
  next_payment_at timestamptz,
  CHECK (payer_company_id <> payee_company_id)
);

CREATE TABLE chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL CHECK (channel IN ('global', 'company', 'direct')),
  company_id uuid REFERENCES companies(id) ON DELETE CASCADE,
  sender_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  sender_npc_id text,
  recipient_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  recipient_npc_id text,
  body varchar(500) NOT NULL CHECK (length(body) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(sender_user_id, sender_npc_id) = 1),
  CHECK (channel <> 'company' OR company_id IS NOT NULL),
  CHECK (channel <> 'direct' OR num_nonnulls(recipient_user_id, recipient_npc_id) = 1)
);
CREATE INDEX chat_global_recent ON chat_messages(created_at DESC) WHERE channel = 'global';
CREATE INDEX chat_company_recent ON chat_messages(company_id, created_at DESC) WHERE channel = 'company';
CREATE INDEX chat_direct_recent ON chat_messages(least(sender_user_id, recipient_user_id), greatest(sender_user_id, recipient_user_id), created_at DESC) WHERE channel = 'direct';

CREATE TABLE game_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX game_events_recent ON game_events(occurred_at DESC);
